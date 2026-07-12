import type { HoldingInfo } from '../shared/portfolio';

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
  /** 成行(テイカー)手数料率(%)。0 = 手数料無料。不明な場合は undefined */
  takerFeePct?: number;
  /** 過去24時間の価格履歴(1時間ごと、古い順) */
  priceHistory24h?: number[];
  /** 過去7日間の価格履歴(6時間ごと、古い順) */
  priceHistory7d?: number[];
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
  };
  /** 総資産の実績変化率。自分の成績を踏まえて判断させる */
  performance?: {
    change24hPct?: number;
    change7dPct?: number;
  };
  /** 直近の実注文履歴。往復売買(直近の判断の無根拠な反転)を防ぐ */
  recentOrders?: RecentOrderInfo[];
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
  apiKey: string,
  model: string,
  snapshot: PortfolioSnapshot,
  fallbackApiKey?: string,
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
    `- 24時間売買代金が ${snapshot.constraints.minLiquidityJpy} 円未満の流動性の低いペアは成行が大きく滑るため提案しない`,
    '- markets の takerFeePct は成行手数料率(%)。手数料無料(0)のペアを優先する。' +
      '有料ペアは往復の手数料を差し引いても利益が見込める強い根拠がある場合のみ提案する',
    '- 含み益が十分に乗った銘柄は全量(sell_all)または半量(sell_half)を利確して現金に戻し、小さな利益を確実に積み上げる',
    '- actionは必ず "buy" (買う), "sell_all" (全部売る), "sell_half" (半分売る) のいずれかを指定すること。金額や数量の調整は不要（コード側で安全なサイズに自動調整される）',
    '- 明確な根拠がない取引は提案しない。取引しない(orders を空にする)のは常に正しい選択肢',
    '- 短期の値動きへの過剰反応や、下落銘柄への安易なナンピンを避ける',
    `- 提案は最大 ${snapshot.constraints.maxOrdersPerCycle} 件まで。確信の高いものだけに絞る`,
    '- portfolio.holdings の avgEntryPrice / pnlPct は実際の取得単価と含み損益率(%)。' +
      '含み損銘柄への買い増しより、見込みの薄い銘柄からの撤退(sell_all)を優先する',
    '- recentOrders はこのシステム自身が直近に執行した実注文。結果を振り返って判断に活かし、' +
      '新しい根拠なしに直近の売買を反転させる(買った直後に売る等)提案はしない',
    '- performance は総資産の実績変化率。悪化が続くときは新規買いを減らし現金比率を高める',
    '- markets の priceHistory24h (過去24時間、1時間ごと) および priceHistory7d (過去7日間、6時間ごと) は価格の時系列データ(古い順)です。トレンド(上昇・下降)やボラティリティを分析し、判断の精度向上に役立ててください。',
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

  const attemptFetch = async (key: string) => {
    return fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: bodyString,
    });
  };

  let res = await attemptFetch(apiKey);

  if (!res.ok && fallbackApiKey) {
    const errText = await res.text();
    console.warn(`Gemini API error with main key: ${res.status} ${errText}. Retrying with fallback key...`);
    res = await attemptFetch(fallbackApiKey);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error: ${res.status} ${errText}`);
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
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
