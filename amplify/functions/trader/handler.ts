import type { EventBridgeHandler } from 'aws-lambda';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { CoincheckClient, type AccountInfo, type PairTicker } from './coincheck';
import { buildPerformance, computeCostBasis, computeDrawdownPct, type CostBasis } from './feedback';
import { notifyError } from './notify';
import { askGeminiForDecision, type PortfolioSnapshot, type ProposedOrder } from './gemini';
import {
  getBreakerBaseline,
  queryRecentOrders,
  querySnapshots,
  saveEvent,
  saveSnapshot,
  type SnapshotPoint,
} from '../shared/history';
import { buildPortfolio, type HoldingInfo } from '../shared/portfolio';

const ssm = new SSMClient({});

async function disableTrading(): Promise<void> {
  if (process.env.LOCAL_RUN === 'true') {
    console.log('LOCAL_RUN: mock disableTrading');
    return;
  }
  try {
    const paramName = requireEnv('TRADING_ENABLED_PARAM');
    await ssm.send(
      new PutParameterCommand({
        Name: paramName,
        Value: 'false',
        Overwrite: true,
      }),
    );
    console.log('Trading switch set to false (disabled via circuit breaker)');
  } catch (err) {
    console.error('failed to update trading switch:', err);
  }
}

/**
 * ダッシュボードのスイッチ(SSMパラメータ)を確認する。
 * 読み取りに失敗した場合は安全側に倒して「停止中」として扱う
 */
async function isTradingEnabled(): Promise<boolean> {
  // ローカル実行 (npm run trade:local) では SSM がないためスイッチ確認を飛ばす
  if (process.env.LOCAL_RUN === 'true') return true;
  try {
    const paramName = requireEnv('TRADING_ENABLED_PARAM');
    const res = await ssm.send(new GetParameterCommand({ Name: paramName }));
    return res.Parameter?.Value === 'true';
  } catch (err) {
    console.error('failed to read trading switch, treating as OFF:', err);
    return false;
  }
}

// 成行注文の最低金額(円換算)。これ未満は取引所に拒否されるか手数料負けする
const MIN_ORDER_NOTIONAL_JPY = 500;
// 取引所の最低注文数量が大きい通貨(2026-07時点: BTC系は0.005)。
// 買いでこの数量に届かないポジションは売却できず塩漬けになるため、買い自体を見送る
const MIN_LOT: Record<string, number> = {
  btc: 0.005,
  wbtc: 0.005,
};

interface Config {
  dryRun: boolean;
  /** 1注文のサイズ = 総資産 × この割合(%)。資産が増えると注文も自動で大きくなる */
  orderPctOfAssets: number;
  /** 1注文の絶対上限(円)。資産が大きく育った後の暴走防止 */
  maxOrderJpyCap: number;
  maxOrdersPerCycle: number;
  maxCoinSharePct: number;
  /** 総資産のこの割合(%)は常に円で保持する */
  jpyReservePct: number;
  minConfidence: number;
  minLiquidityJpy: number;
  /** 取得単価からこの割合(%)下落したら Gemini の判断を待たず全量売却する。0以下で無効 */
  stopLossPct: number;
  excludePairs: Set<string>;
  geminiModel: string;
  /** 目標資産額(円)。判断には使わず、進捗ログにのみ使う */
  goalAssetsJpy: number;
  /** 24時間の最大許容ドローダウン(%)。これを超えると自動停止 */
  maxDrawdown24hPct: number;
}

function loadConfig(): Config {
  return {
    dryRun: (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false',
    orderPctOfAssets: Number(process.env.ORDER_PCT_OF_ASSETS ?? 15),
    maxOrderJpyCap: Number(process.env.MAX_ORDER_JPY_CAP ?? 50000),
    maxOrdersPerCycle: Number(process.env.MAX_ORDERS_PER_CYCLE ?? 3),
    maxCoinSharePct: Number(process.env.MAX_COIN_SHARE_PCT ?? 25),
    jpyReservePct: Number(process.env.JPY_RESERVE_PCT ?? 10),
    minConfidence: Number(process.env.MIN_CONFIDENCE ?? 0.7),
    minLiquidityJpy: Number(process.env.MIN_LIQUIDITY_JPY ?? 100000),
    stopLossPct: Number(process.env.STOP_LOSS_PCT ?? 10),
    excludePairs: new Set(
      (process.env.EXCLUDE_PAIRS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash',
    goalAssetsJpy: Number(process.env.GOAL_ASSETS_JPY ?? 1_300_000_000),
    maxDrawdown24hPct: Number(process.env.MAX_DRAWDOWN_24H_PCT ?? 10),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

/**
 * スナップショット履歴から、指定期間・間隔で特定の通貨ペアの価格履歴(古い順)を抽出して間引く。
 *
 * サンプリング点は「壁時計の正時」ではなく「現在時刻(now)起点」で生成する
 * (now, now-interval, now-2*interval, …)。正時基準だと実行時刻の「分」によって
 * 各点に採用されるスナップショットが変わり、結果が非決定的になる/最新価格が
 * 系列から欠落する、という不具合があったため。最新点(k=0)は必ず直近の価格を採用し、
 * トレンド判断の入力から「今の価格」が抜けないようにする。
 */
export function getPriceHistory(
  snapshots: SnapshotPoint[],
  pair: string,
  hoursLimit: number,
  intervalHours: number
): number[] {
  const now = Date.now();
  const intervalMs = intervalHours * 3600_000;
  const cutoff = now - hoursLimit * 3600_000;

  const priceOf = (s: SnapshotPoint): number | undefined =>
    s.prices?.[pair] ?? (pair === 'btc_jpy' ? s.btcPriceJpy : undefined);

  // 対象ペアの価格を持ち、期間内のスナップショットだけを古い順に並べる
  const candidates = snapshots
    .filter((s) => s.t >= cutoff && priceOf(s) !== undefined)
    .sort((a, b) => a.t - b.t);
  if (candidates.length === 0) return [];

  const history: number[] = [];
  const used = new Set<number>();
  const count = Math.max(1, Math.floor(hoursLimit / intervalHours));

  // k=count(最古)→ k=0(現在)の順に走査し、そのまま古い順の系列を作る
  for (let k = count; k >= 0; k--) {
    const target = now - k * intervalMs;
    let bestIdx = -1;
    let minDiff = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      if (used.has(i)) continue;
      const diff = Math.abs(candidates[i].t - target);
      if (diff < minDiff) {
        minDiff = diff;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) continue;
    // k=0(現在)は必ず直近価格を採用。それ以外は間隔の半分以内にデータがある場合のみ採用する
    if (k === 0 || minDiff <= intervalMs / 2) {
      const price = priceOf(candidates[bestIdx])!;
      // 有効数字5桁に丸めてプロンプトのトークンを節約する(判断品質は落ちない)
      history.push(Number(price.toPrecision(5)));
      used.add(bestIdx);
    }
  }
  return history;
}

/**
 * baselineMs 以降のJPY純入出金(確定した入金 − 確定した出金)を集計する。
 * サーキットブレーカーが「出金による見かけの資産減少」を暴落と誤認しないために使う。
 * 取得失敗時は 0(調整なし)を返し、安全側(発動しやすい側)に倒す。
 */
async function sumJpyNetFlowSince(coincheck: CoincheckClient, baselineMs: number): Promise<number> {
  try {
    const [withdrawals, deposits] = await Promise.all([
      coincheck.getJpyWithdrawals(),
      coincheck.getJpyDeposits(),
    ]);
    const withdrawn = (withdrawals.data ?? [])
      .filter((w) => w.status === 'finished' && new Date(w.created_at).getTime() >= baselineMs)
      .reduce((sum, w) => sum + Number(w.amount), 0);
    const deposited = (deposits.deposits ?? [])
      .filter((d) => d.status === 'confirmed' && new Date(d.created_at).getTime() >= baselineMs)
      .reduce((sum, d) => sum + Number(d.amount), 0);
    return deposited - withdrawn;
  } catch (err) {
    console.error('failed to fetch JPY flows for circuit breaker (treating as 0):', err);
    return 0;
  }
}

export async function runTradingCycle(): Promise<void> {
  const config = loadConfig();
  const tradingEnabled = await isTradingEnabled();

  const coincheck = new CoincheckClient(
    requireEnv('COINCHECK_API_KEY'),
    requireEnv('COINCHECK_API_SECRET'),
  );

  // 1. 全ペアの相場と全通貨の残高を取得(DBは使わず毎回取引所から現在の状態を得る)。
  //    手数料率も毎回取得する(改定に自動追従)。取得失敗は致命的でないので握りつぶす
  const [allTickers, allRates, balance, accounts] = await Promise.all([
    coincheck.getAllTickers(),
    coincheck.getAllRates(),
    coincheck.getBalance(),
    coincheck.getAccounts().catch((err) => {
      console.error('failed to fetch account fees (continuing without):', err);
      return undefined;
    }),
  ]);
  const tickers = new Map<string, PairTicker>(
    allTickers
      .filter((t) => !config.excludePairs.has(t.pair) && t.last > 0)
      .map((t) => [t.pair, t]),
  );

  // 2. ポートフォリオ評価: 各保有通貨を対応ペアの直近価格で円換算する
  //    取引所にない通貨(OTC販売所銘柄)も allRates を用いて正しく評価額に含める
  const portfolio = buildPortfolio(tickers.values(), balance, allRates);
  const { jpyAvailable, totalAssetsJpy, holdings } = portfolio;

  // 資産推移を DynamoDB に永久保存する(スイッチOFFの間も記録は続ける)。
  // BTC価格も記録し、後から「BTCを買い持ちしていたら」ベンチマークを再構成できるようにする
  const prices: Record<string, number> = {};
  for (const [pair, t] of tickers.entries()) {
    prices[pair] = t.last;
  }
  const btcPriceJpy = tickers.get('btc_jpy')?.last;
  await saveSnapshot(portfolio, btcPriceJpy, prices);

  // 資本規模に応じた1注文サイズと円の下限(%ベースなので資産成長に自動追従する)
  const maxOrderJpy = Math.min(
    config.maxOrderJpyCap,
    Math.max(MIN_ORDER_NOTIONAL_JPY, (totalAssetsJpy * config.orderPctOfAssets) / 100),
  );
  const minJpyReserve = (totalAssetsJpy * config.jpyReservePct) / 100;

  // 塩漬けフィルタ: 最低売却数量が大きい通貨(BTC等)で、保有が売却下限未満
  // かつ最大注文額で買い足しても下限に届かない場合、ペアごと除外する。
  // Gemini に渡すデータから消すことで API コスト削減と判断精度向上を図る。
  // 資本が育って 1 注文が大きくなれば自動的に解禁される
  for (const [pair, ticker] of tickers) {
    const currency = pair.split('_')[0];
    const minLot = MIN_LOT[currency];
    if (!minLot) continue;
    const held = holdings.find((h) => h.currency === currency)?.amount ?? 0;
    const canSell = held >= minLot;
    const projectedIfBuy = held + maxOrderJpy / ticker.last;
    const canBuyToSellable = projectedIfBuy >= minLot;
    if (!canSell && !canBuyToSellable) {
      console.log(
        `excluding ${pair}: held ${held} ${currency} < min lot ${minLot}, ` +
          `even max buy ~${(maxOrderJpy / ticker.last).toFixed(8)} would only reach ${projectedIfBuy.toFixed(8)}`,
      );
      tickers.delete(pair);
    }
  }

  logProgress(totalAssetsJpy, config.goalAssetsJpy);

  // スイッチOFFなら記録だけして終了(売買判断は行わない)
  if (!tradingEnabled) {
    console.log('trading is OFF (dashboard switch) — snapshot saved, skipping trades');
    return;
  }

  // 過去7日間のスナップショットを取得 (サーキットブレーカー、パフォーマンス、価格系列で使用)
  const nowMs = Date.now();
  const snapshots = await querySnapshots(nowMs - 7 * 24 * 3600_000, nowMs);

  // 自分自身の成績(資産推移)を算出。これは Gemini へのフィードバック用(生の変化率)
  const performance = buildPerformance(totalAssetsJpy, snapshots);

  // サーキットブレーカー: 総資産が短時間で大きく下落したら自動停止する最後の砦。
  // ただし2つの誤発動を防ぐ:
  //  (1) JPYの出金だけで「暴落」と誤認しない → 入出金フローを除いた純粋な運用成績で判定
  //  (2) 手動でONに戻した直後に同じ下落で即再発動しない → 手動ON時刻をベースラインにして計測し直す
  const breakerBaselineTs = (await getBreakerBaseline()) ?? 0;
  const floorMs = Math.max(nowMs - 24 * 3600_000, breakerBaselineTs);
  const maxDrawdown = config.maxDrawdown24hPct;

  // まず入出金を考慮しない生ドローダウンで判定(API追加コストゼロの安価な経路)
  const rawDrawdown = computeDrawdownPct(totalAssetsJpy, snapshots, floorMs, 0);
  if (rawDrawdown !== undefined && rawDrawdown <= -maxDrawdown) {
    // 生の下落が閾値を超えたときだけ、入出金履歴を取得して「見かけの変動」を除外して再確認する
    const netFlowJpy = await sumJpyNetFlowSince(coincheck, floorMs);
    const adjustedDrawdown = computeDrawdownPct(totalAssetsJpy, snapshots, floorMs, netFlowJpy);
    if (adjustedDrawdown !== undefined && adjustedDrawdown <= -maxDrawdown) {
      const pct = Math.round(adjustedDrawdown * 100) / 100;
      console.warn(`[CIRCUIT BREAKER] flow-adjusted drawdown ${pct}% exceeds limit -${maxDrawdown}%`);
      await disableTrading();
      await notifyError(
        'circuit-breaker',
        new Error(
          `[CIRCUIT BREAKER] 入出金を除いた運用成績が ${pct}% 下落しました(閾値 -${maxDrawdown}%)。` +
            `安全のため自動売買を緊急停止(SSM OFF)しました。現在の総資産: ${Math.round(totalAssetsJpy)} JPY。` +
            `再開する場合はダッシュボードのスイッチをONに戻してください(その時点から計測し直します)`,
        ),
      );
      return;
    }
    console.log(
      `[circuit breaker] 生ドローダウン ${Math.round(rawDrawdown * 100) / 100}% だが、` +
        `入出金調整後は ${Math.round((adjustedDrawdown ?? 0) * 100) / 100}% のため発動しない(入出金による見かけの変動)`,
    );
  }

  // 実注文の履歴(古い順)から通貨ごとの平均取得単価を復元する
  const pastOrders = (await queryRecentOrders()).reverse();
  const costBasis = computeCostBasis(pastOrders);

  // 機械的ストップロス: 損切りは判断ではなくルールとして強制する(ドローダウンを浅く保つ最後の砦)
  const stopped = await applyStopLoss({ config, coincheck, tickers, holdings, costBasis });
  // 損切りした銘柄は今サイクルの判断対象から外す(売却代金は次サイクルから使う)
  const activeHoldings = holdings.filter((h) => !stopped.has(h.currency));

  // 取得単価が復元できる銘柄には含み損益を付けて Gemini に渡す
  for (const h of activeHoldings) {
    const b = costBasis.get(h.currency);
    if (b && b.avgPrice > 0 && b.amount >= h.amount * 0.9) {
      const ticker = tickers.get(`${h.currency}_jpy`);
      h.avgEntryPrice = Math.round(b.avgPrice * 10000) / 10000;
      if (ticker) h.pnlPct = Math.round(((ticker.last - b.avgPrice) / b.avgPrice) * 10000) / 100;
    }
  }

  // 自分自身の成績(資産推移と直近の実注文)を判断材料としてフィードバックする
  const recentOrders = pastOrders.slice(-10).map((e) => ({
    daysAgo: Math.round(((Date.now() - e.t) / 86_400_000) * 10) / 10,
    pair: e.pair,
    action: e.action,
    sizeJpy: e.sizeJpy,
    price: e.price,
    reason: e.reason,
  }));

  const snapshot: PortfolioSnapshot = {
    markets: [...tickers.values()].map((t) => ({
      pair: t.pair,
      last: t.last,
      high24h: t.high,
      low24h: t.low,
      changePct24h: t.price_change_percent_24h * 100,
      quoteVolumeJpy: Math.round(t.quote_volume),
      takerFeePct: takerFeePctFor(t.pair, accounts),
      priceHistory24h: getPriceHistory(snapshots, t.pair, 24, 1),
      priceHistory7d: getPriceHistory(snapshots, t.pair, 24 * 7, 6),
    })),
    portfolio: { jpyAvailable, totalAssetsJpy, holdings: activeHoldings },
    constraints: {
      maxOrdersPerCycle: config.maxOrdersPerCycle,
      maxOrderJpy: Math.floor(maxOrderJpy),
      maxCoinSharePct: config.maxCoinSharePct,
      minJpyReserve: Math.ceil(minJpyReserve),
      minLiquidityJpy: config.minLiquidityJpy,
    },
    performance,
    recentOrders,
  };

  console.log('portfolio snapshot:', JSON.stringify(snapshot.portfolio));

  // 3. Gemini にポートフォリオ全体の売買判断を依頼
  const decision = await askGeminiForDecision(
    requireEnv('GEMINI_API_KEY'),
    config.geminiModel,
    snapshot,
  );
  console.log('gemini outlook:', decision.outlook);
  console.log('gemini proposed orders:', JSON.stringify(decision.orders));

  // 判断の記録を永久保存する(見送りも含めて後から振り返れるように)
  await saveEvent({
    type: 'decision',
    dryRun: config.dryRun,
    outlook: decision.outlook,
    proposedOrders: decision.orders,
  });

  if (decision.orders.length === 0) {
    console.log('no trade proposed');
    return;
  }

  // 4. 提案された注文にガードレールを適用して順に執行する。
  //    1件の失敗で全体を止めず、注文ごとに検証・実行する
  let jpySpendable = Math.max(0, jpyAvailable - minJpyReserve);
  const holdingByCurrency = new Map(activeHoldings.map((h) => [h.currency, h]));
  let executed = 0;

  for (const order of decision.orders) {
    if (executed >= config.maxOrdersPerCycle) {
      await skipOrder(
        order,
        `1サイクルの注文上限 ${config.maxOrdersPerCycle} 件に到達`,
        config.dryRun,
      );
      continue;
    }
    try {
      const done = await executeWithGuardrails(order, {
        config,
        coincheck,
        tickers,
        holdingByCurrency,
        totalAssetsJpy,
        maxOrderJpy,
        jpySpendable,
      });
      if (done !== null) {
        executed += 1;
        jpySpendable = done.jpySpendableAfter;
      }
    } catch (err) {
      console.error(`order failed for ${order.pair}:`, err);
    }
  }
  console.log(`cycle done: ${executed} order(s) ${config.dryRun ? 'simulated' : 'executed'}`);
}

/**
 * ペアの成行(テイカー)手数料率(%)を解決する。
 * ペア個別の設定 → 口座全体の既定値の順に見て、どちらも無ければ undefined(不明)。
 * 手数料無料ペアの優先は Gemini のプロンプトで行う。
 */
function takerFeePctFor(pair: string, accounts?: AccountInfo): number | undefined {
  const raw = accounts?.exchange_fees?.[pair]?.taker_fee ?? accounts?.taker_fee;
  if (raw === undefined) return undefined;
  const pct = Number(raw);
  return Number.isFinite(pct) ? pct : undefined;
}

/**
 * 総資産を CloudWatch のカスタムメトリクスとして記録する (EMF形式)。
 * DBなしで何年分でも資産推移をグラフ化できる。
 */
function logProgress(totalAssetsJpy: number, goalAssetsJpy: number): void {
  const progressPct = (totalAssetsJpy / goalAssetsJpy) * 100;
  console.log(
    `goal progress: ${Math.round(totalAssetsJpy)} JPY / ${goalAssetsJpy} JPY (${progressPct.toFixed(5)}%)`,
  );
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'CoinGod',
            Dimensions: [[]],
            Metrics: [{ Name: 'TotalAssetsJpy', Unit: 'None' }],
          },
        ],
      },
      TotalAssetsJpy: Math.round(totalAssetsJpy),
    }),
  );
}

interface StopLossContext {
  config: Config;
  coincheck: CoincheckClient;
  tickers: Map<string, PairTicker>;
  holdings: HoldingInfo[];
  costBasis: Map<string, CostBasis>;
}

/**
 * 機械的ストップロス。取得単価から一定割合下落した銘柄は Gemini の判断を待たず全量売却する。
 * 損切りを判断(AI・人間)に委ねると迷いで遅れるため、コードのルールとして強制する。
 * 取得単価が復元できない銘柄(ボット導入前からの保有など)は対象外で、Gemini の判断に委ねる。
 * 売却した通貨の集合を返す。
 */
async function applyStopLoss(ctx: StopLossContext): Promise<Set<string>> {
  const sold = new Set<string>();
  const threshold = ctx.config.stopLossPct;
  if (threshold <= 0) return sold;

  for (const h of ctx.holdings) {
    const b = ctx.costBasis.get(h.currency);
    // 履歴が保有量をほぼ説明できる場合のみ発動する(部分的な記録による誤発動を防ぐ)
    if (!b || b.avgPrice <= 0 || b.amount < h.amount * 0.9) continue;
    const pair = `${h.currency}_jpy`;
    const ticker = ctx.tickers.get(pair);
    if (!ticker) continue;
    const dropPct = ((b.avgPrice - ticker.last) / b.avgPrice) * 100;
    if (dropPct < threshold) continue;

    const coinAmount = Number(h.amount.toFixed(8));
    const notionalJpy = coinAmount * ticker.last;
    const minLot = MIN_LOT[h.currency] ?? 0;
    if (coinAmount < minLot || notionalJpy < MIN_ORDER_NOTIONAL_JPY) {
      const skipReason =
        `stop-loss発動条件だが、数量 ${coinAmount} ${h.currency} (${Math.floor(notionalJpy)}円) ` +
        'が最低売却条件未満のため売却不能';
      console.log(`stop-loss skip ${pair}: ${skipReason}`);
      await saveEvent({
        type: 'skip', dryRun: ctx.config.dryRun, pair, action: 'sell', reason: skipReason,
      });
      continue;
    }

    const reason = `stop-loss: 取得単価 ${b.avgPrice.toFixed(4)} JPY から ${dropPct.toFixed(1)}% 下落 (閾値 ${threshold}%)`;
    if (ctx.config.dryRun) {
      console.log(
        `[DRY_RUN] would stop-loss sell ${coinAmount} ${h.currency} (~${Math.floor(notionalJpy)} JPY) — ${reason}`,
      );
      await saveEvent({
        type: 'order', dryRun: true, pair, action: 'sell',
        sizeCoin: coinAmount, sizeJpy: Math.floor(notionalJpy), price: ticker.last, reason,
      });
      sold.add(h.currency);
      continue;
    }
    try {
      const result = await ctx.coincheck.marketSell(pair, coinAmount);
      console.log(`stop-loss sell placed for ${pair}:`, JSON.stringify(result));
      await saveEvent({
        type: 'order', dryRun: false, pair, action: 'sell',
        sizeCoin: coinAmount, sizeJpy: Math.floor(notionalJpy), price: ticker.last,
        reason, orderId: result.id,
      });
      sold.add(h.currency);
    } catch (err) {
      // 1銘柄の失敗でサイクル全体を止めない
      console.error(`stop-loss sell failed for ${pair}:`, err);
    }
  }
  return sold;
}

interface ExecutionContext {
  config: Config;
  coincheck: CoincheckClient;
  tickers: Map<string, PairTicker>;
  holdingByCurrency: Map<string, HoldingInfo>;
  totalAssetsJpy: number;
  maxOrderJpy: number;
  jpySpendable: number;
}

/**
 * 見送った注文もログとイベント履歴の両方に記録する。
 * ダッシュボードで「なぜ売買しなかったのか」を後から追えるようにする
 */
async function skipOrder(order: ProposedOrder, reason: string, dryRun: boolean): Promise<null> {
  console.log(`skip ${order.action} ${order.pair}: ${reason}`);
  await saveEvent({ type: 'skip', dryRun, pair: order.pair, action: order.action, reason });
  return null;
}

/** ガードレールを通過した場合のみ注文する。見送った場合は null を返す */
async function executeWithGuardrails(
  order: ProposedOrder,
  ctx: ExecutionContext,
): Promise<{ jpySpendableAfter: number } | null> {
  const { config, coincheck, tickers } = ctx;

  const ticker = tickers.get(order.pair);
  if (!ticker) {
    return skipOrder(order, '取引対象外のペア(除外設定または未上場)', config.dryRun);
  }
  if (order.confidence < config.minConfidence) {
    return skipOrder(
      order,
      `確信度 ${order.confidence} が閾値 ${config.minConfidence} 未満`,
      config.dryRun,
    );
  }
  // 流動性ガード: 板が薄いペアへの成行は滑りが大きすぎる
  if (ticker.quote_volume < config.minLiquidityJpy) {
    return skipOrder(
      order,
      `24時間売買代金 ${Math.round(ticker.quote_volume)} 円が流動性下限 ${config.minLiquidityJpy} 円未満`,
      config.dryRun,
    );
  }

  const currency = order.pair.split('_')[0];
  const holding = ctx.holdingByCurrency.get(currency);
  const minLot = MIN_LOT[currency] ?? 0;

  if (order.action === 'buy') {
    // 集中ガード: この銘柄がポートフォリオの上限割合を超える買いはしない
    const currentValue = holding?.jpyValue ?? 0;
    const shareRoom = (ctx.totalAssetsJpy * config.maxCoinSharePct) / 100 - currentValue;
    const orderJpy = Math.floor(
      Math.min(ctx.jpySpendable, ctx.maxOrderJpy, shareRoom),
    );
    if (orderJpy < MIN_ORDER_NOTIONAL_JPY) {
      return skipOrder(
        order,
        `注文額 ${orderJpy} 円が最低 ${MIN_ORDER_NOTIONAL_JPY} 円未満 ` +
          `(使える現金=${Math.floor(ctx.jpySpendable)}円, 集中上限までの余地=${Math.floor(shareRoom)}円)`,
        config.dryRun,
      );
    }
    // 塩漬けガード: 買った後の保有量が最低売却数量に届かないなら、売れない資産になるため買わない。
    // 資本が育って1注文が大きくなれば自動的に解禁される
    if (minLot > 0) {
      const projected = (holding?.amount ?? 0) + orderJpy / ticker.last;
      if (projected < minLot) {
        return skipOrder(
          order,
          `買っても保有量 ${projected.toFixed(8)} ${currency} が最低売却数量 ${minLot} ${currency} に届かず、` +
            '売れない資産(塩漬け)になるため見送り',
          config.dryRun,
        );
      }
    }
    if (config.dryRun) {
      console.log(`[DRY_RUN] would market-buy ${orderJpy} JPY of ${order.pair} — ${order.reason}`);
      await saveEvent({
        type: 'order', dryRun: true, pair: order.pair, action: 'buy',
        sizeJpy: orderJpy, price: ticker.last, reason: order.reason,
      });
      return { jpySpendableAfter: ctx.jpySpendable - orderJpy };
    }
    const result = await coincheck.marketBuy(order.pair, orderJpy);
    console.log(`buy order placed for ${order.pair}:`, JSON.stringify(result));
    await saveEvent({
      type: 'order', dryRun: false, pair: order.pair, action: order.action,
      sizeJpy: orderJpy, price: ticker.last, reason: order.reason, orderId: result.id,
    });
    return { jpySpendableAfter: ctx.jpySpendable - orderJpy };
  }

  // sell
  const held = holding?.amount ?? 0;
  let coinAmount = order.action === 'sell_half' ? held / 2 : held;
  // 最低数量が大きい通貨は、保有が足りていれば最低数量まで引き上げる(円への回収方向のみ許容)
  if (coinAmount < minLot && held >= minLot) coinAmount = minLot;
  coinAmount = Number(coinAmount.toFixed(8));

  const notionalJpy = coinAmount * ticker.last;
  if (coinAmount <= 0 || coinAmount < minLot || notionalJpy < MIN_ORDER_NOTIONAL_JPY) {
    return skipOrder(
      order,
      `売却数量 ${coinAmount} ${currency} (${Math.floor(notionalJpy)}円) が最低売却条件未満`,
      config.dryRun,
    );
  }
  if (config.dryRun) {
    console.log(
      `[DRY_RUN] would market-sell ${coinAmount} ${currency} (~${Math.floor(notionalJpy)} JPY) on ${order.pair} — ${order.reason}`,
    );
    await saveEvent({
      type: 'order', dryRun: true, pair: order.pair, action: order.action,
      sizeCoin: coinAmount, sizeJpy: Math.floor(notionalJpy), price: ticker.last,
      reason: order.reason,
    });
    return { jpySpendableAfter: ctx.jpySpendable };
  }
  const result = await coincheck.marketSell(order.pair, coinAmount);
  console.log(`sell order placed for ${order.pair}:`, JSON.stringify(result));
  await saveEvent({
    type: 'order', dryRun: false, pair: order.pair, action: order.action,
    sizeCoin: coinAmount, sizeJpy: Math.floor(notionalJpy), price: ticker.last,
    reason: order.reason, orderId: result.id,
  });
  return { jpySpendableAfter: ctx.jpySpendable };
}

export const handler: EventBridgeHandler<'Scheduled Event', unknown, void> = async () => {
  try {
    await runTradingCycle();
  } catch (err) {
    // 例外はログに残して正常終了させる(EventBridge の自動リトライで二重注文になるのを防ぐ)
    console.error('trading cycle failed:', err);
    // サイクル全体が落ちるレベルの異常は Webhook で通知する(注文ごとの失敗は握りつぶし対象なので通知しない)
    await notifyError('trading cycle', err);
  }
};
