import type { HoldingInfo } from '../shared/portfolio';
import type { TechnicalIndicators } from './indicators';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Gemini が提案する1件の注文 */
export interface ProposedOrder {
  pair: string;
  action: 'buy' | 'sell_all' | 'sell_half';
  /** 判断の確信度 (0〜1) */
  confidence: number;
  /** 判断理由(日本語) */
  reason: string;
}

export interface PortfolioDecision {
  orders: ProposedOrder[];
  /** 市場全体の見立て(ログ用) */
  outlook: string;
}

export interface MarketPairInfo {
  pair: string;
  last: number;
  high24h: number;
  low24h: number;
  changePct24h: number;
  /** 24時間の売買代金(円)。流動性の目安 */
  quoteVolumeJpy: number;
  /** 売値と買値の乖離率(%)。実質的な取引コスト(スプレッド) */
  spreadPct?: number;
  /** 成行(テイカー)手数料率(%)。0 = 手数料無料。不明な場合は undefined */
  takerFeePct?: number;
  /** 過去24時間の価格履歴(1時間ごと、古い順) */
  priceHistory24h?: number[];
  /** 過去7日間の価格履歴(6時間ごと、古い順) */
  priceHistory7d?: number[];
  /** コード側で計算済みのテクニカル指標(データ不足の項目は省略される) */
  indicators?: TechnicalIndicators;
}

/** 直近に提案されたが実行できなかった注文(ガードレール見送り・注文APIエラー) */
export interface RecentSkipInfo {
  hoursAgo: number;
  pair?: string;
  action?: string;
  reason?: string;
}

/** このシステム自身が過去に執行した実注文(成績フィードバック用) */
export interface RecentOrderInfo {
  daysAgo: number;
  pair?: string;
  action?: 'buy' | 'sell' | 'sell_all' | 'sell_half';
  sizeJpy?: number;
  price?: number;
  reason?: string;
}

export interface PortfolioSnapshot {
  markets: MarketPairInfo[];
  portfolio: {
    jpyAvailable: number;
    totalAssetsJpy: number;
    holdings: HoldingInfo[];
  };
  /** コード側で強制される制約。Gemini にも伝えて無駄な提案を減らす */
  constraints: {
    maxOrdersPerCycle: number;
    maxOrderJpy: number;
    maxCoinSharePct: number;
    minJpyReserve: number;
    minLiquidityJpy: number;
    /** 同時に保有してよい銘柄数の上限。小資本での過剰分散を防ぐ */
    maxHoldings: number;
    /** 買ってからこの時間(h)は売れない(ストップロス除く) */
    minHoldHours: number;
    /** 売ってからこの時間(h)は同じ通貨を買い直せない */
    rebuyCooldownHours: number;
  };
  /** 総資産の実績変化率と確定損益。自分の成績を踏まえて判断させる */
  performance?: {
    change24hPct?: number;
    change7dPct?: number;
    /** 決済ごとの確定損益(円)と勝敗。負けが込んでいるときの過剰取引を抑える */
    realized?: { realizedJpy: number; wins: number; losses: number; sellCount: number };
  };
  /** 直近の実注文履歴。往復売買(直近の判断の無根拠な反転)を防ぐ */
  recentOrders?: RecentOrderInfo[];
  /** 直近に実行できなかった提案。同じ提案の無限ループを防ぐ */
  recentSkips?: RecentSkipInfo[];
}

const DECISION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    orders: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          pair: { type: 'STRING' },
          action: { type: 'STRING', enum: ['buy', 'sell_all', 'sell_half'] },
          confidence: { type: 'NUMBER' },
          reason: { type: 'STRING' },
        },
        required: ['pair', 'action', 'confidence', 'reason'],
      },
    },
    outlook: { type: 'STRING' },
  },
  required: ['orders', 'outlook'],
} as const;

export async function askGeminiForDecision(
  apiKeys: string[],
  models: string[],
  snapshot: PortfolioSnapshot,
  strategy: 'KEY_FIRST' | 'MODEL_FIRST'
): Promise<PortfolioDecision> {
  const prompt = [
    'あなたは慎重なリスク管理を最優先する暗号資産ポートフォリオマネージャーです。',
    '目的は「何年もかけた長期の複利成長」です。一度の大勝ちではなく、小さな利益を',
    '確実に積み上げることを重視してください。分散されたポートフォリオを維持しながら、',
    '大きなドローダウンを避けることを最優先し、リスクを抑えて資産の期待値を高めてください。',
    '資金を失えば複利は止まります。',
    '',
    '方針:',
    `- 1銘柄への集中を避ける。1銘柄の割合が ${snapshot.constraints.maxCoinSharePct}% を超える追加買いは提案しない`,
    '- 割合が突出した銘柄は一部売却(sell_half)してリバランスを検討する',
    `- 24時間売買代金が ${snapshot.constraints.minLiquidityJpy} 円未満のペアへの新規買い(buy)は成行が大きく滑るため提案しない。` +
      '既存保有の売却(sell_all/sell_half)は脱出手段としてその1/10の売買代金まで許容される',
    `- 同時保有銘柄数の上限は ${snapshot.constraints.maxHoldings} 銘柄。上限に達している間は未保有銘柄の buy は執行されないため提案しない。` +
      '見込みの薄い銘柄を売却して枠を空けるか、既存銘柄の買い増しを検討する',
    '- markets の takerFeePct は成行手数料率(%)。手数料無料(0)のペアを優先する。' +
      '有料ペアは往復の手数料を差し引いても利益が見込める強い根拠がある場合のみ提案する',
    '- markets の spreadPct は売値と買値の乖離率(スプレッド率%)。これは実質的な取引手数料(隠れコスト)です。' +
      'spreadPctが大きい銘柄(目安2%以上)の新規買い(buy)は、スプレッド負けして確実に損失が出るため極力避けること',
    '- 含み益が十分に乗った銘柄は全量(sell_all)または半量(sell_half)を利確して現金に戻し、小さな利益を確実に積み上げる',
    '- actionは必ず "buy" (買う), "sell_all" (全部売る), "sell_half" (半分売る) のいずれかを指定すること。金額や数量の調整は不要（コード側で安全なサイズに自動調整される）',
    '- 明確な根拠がない取引は提案しない。取引しない(orders を空にする)のは常に正しい選択肢',
    '- 短期の値動きへの過剰反応や、下落銘柄への安易なナンピンを避ける',
    `- 買った銘柄は最低 ${snapshot.constraints.minHoldHours} 時間保有する(コード側で強制。機械的ストップロスのみ例外)。` +
      `売った銘柄は ${snapshot.constraints.rebuyCooldownHours} 時間は買い直せない。この間の提案は執行されないので出さない`,
    `- maxOrderJpy 全額の買い直後は1銘柄が総資産の約20%を占めるが、これは設計どおりの標準サイズ。` +
      `${snapshot.constraints.maxCoinSharePct}% の上限を超えない限り「集中リスク」「現金比率の確保」を理由に買った銘柄をすぐ売らない。` +
      'エントリー時の想定(上がる)が崩れたときだけ売る',
    '- 全ての取引には往復コスト(spreadPct + 手数料)がかかる。想定される値幅がこのコストを明確に(2倍以上)上回る取引だけを提案する',
    `- 提案は最大 ${snapshot.constraints.maxOrdersPerCycle} 件まで。確信の高いものだけに絞る`,
    '- portfolio.holdings の avgEntryPrice / pnlPct は実際の取得単価と含み損益率(%)。' +
      '含み損銘柄への買い増しより、見込みの薄い銘柄からの撤退(sell_all)を優先する',
    '- recentOrders はこのシステム自身が直近に執行した実注文。結果を振り返って判断に活かし、' +
      '新しい根拠なしに直近の売買を反転させる(買った直後に売る等)提案はしない',
    '- performance は総資産の実績変化率。悪化が続くときは新規買いを減らし現金比率を高める',
    '- performance.realized はこのシステム自身の確定損益(realizedJpy 円)と勝敗(wins/losses)。' +
      '勝率が5割を下回っている・realizedJpy がマイナスのときは、これまでと同じ型の取引が機能していない証拠。' +
      '取引回数を絞り、より強い根拠があるものだけを厳選すること',
    '- markets の priceHistory24h (過去24時間、1時間ごと) および priceHistory7d (過去7日間、6時間ごと) は価格の時系列データ(古い順)です。トレンド(上昇・下降)やボラティリティを分析し、判断の精度向上に役立ててください。',
    '- markets の indicators はコード側で計算済みのテクニカル指標: rsi14 (RSI(14)。70超=買われすぎ, 30未満=売られすぎ)、' +
      'ma6hDevPct (6時間移動平均からの乖離率%。プラスは短期的な上振れ)、vol24hPct (1時間リターンの標準偏差%。大きいほど荒い)、' +
      'range7dPosPct (7日レンジ内の位置。0=安値圏, 100=高値圏)、trend (トレンド判定。UP=上昇, DOWN=下降, RANGE=もみ合い)。印象ではなくこれらの数値を根拠に判断すること',
    '- 各注文の reason には必ず具体的な数値根拠(RSI・乖離率・レンジ位置・含み損益率・トレンドなど)を1つ以上含めること。' +
      '「流動性が高い」「分散に適している」だけの理由では提案しない。トレンドが RANGE(もみ合い) や DOWN(下降) のときは、明確な反発サインがない限り新規買いを見送ること',
    '- recentSkips は直近に提案されたが実行できなかった注文とその理由。同じ条件のまま同じ提案を繰り返さない',
    '',
    `現在のポートフォリオと市場データ (JSON): ${JSON.stringify(snapshot)}`,
    '',
    '出力は指定された JSON スキーマに従うこと。reason と outlook は日本語で簡潔に。',
  ].join('\n');

  const bodyString = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: DECISION_SCHEMA,
    },
  });

  const attemptFetch = async (key: string, model: string): Promise<PortfolioDecision> => {
    const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: bodyString,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`${res.status} ${errText}`);
    }

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error(`Gemini returned no text: ${JSON.stringify(json)}`);
    }

    const decision = JSON.parse(text) as PortfolioDecision;

    // モデル出力を信用しすぎない: 値域と形式をコード側で強制する
    decision.orders = (Array.isArray(decision.orders) ? decision.orders : [])
      .filter((o) => o && ['buy', 'sell_all', 'sell_half'].includes(o.action) && typeof o.pair === 'string')
      .map((o) => ({
        ...o,
        confidence: clamp01(o.confidence),
      }));
    return decision;
  };

  let lastError: Error | null = null;

  if (strategy === 'KEY_FIRST') {
    for (const model of models) {
      for (const key of apiKeys) {
        try {
          return await attemptFetch(key, model);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          console.warn(`Gemini API error with model ${model} and key ***: ${lastError.message}. Retrying...`);
        }
      }
    }
  } else {
    for (const key of apiKeys) {
      for (const model of models) {
        try {
          return await attemptFetch(key, model);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          console.warn(`Gemini API error with model ${model} and key ***: ${lastError.message}. Retrying...`);
        }
      }
    }
  }

  throw new Error(`All Gemini API fallback attempts failed. Last error: ${lastError?.message}`);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
