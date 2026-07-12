/** デモモード (npm run demo) 用の疑似データ。AWSに接続せずUIを確認できる */
import type { Api, SnapshotPoint, StatusData, TradeEvent } from './api';

let mockEnabled = true;

function mockSnapshots(): SnapshotPoint[] {
  const points: SnapshotPoint[] = [];
  const now = Date.now();
  let totalAssets = 13000;
  let cashRatio = 0.35;
  let ethAmt = 0.012;
  let xrpAmt = 10;
  let solAmt = 0.15;
  const ethPrice = 290000;
  const xrpPrice = 179;
  const solPrice = 12600;
  let btcMark = 10_200_000;
  for (let i = 30 * 24 * 4; i >= 0; i -= 1) {
    totalAssets = Math.max(9000, totalAssets * (1 + (Math.random() - 0.485) * 0.01));
    cashRatio = Math.max(0.1, Math.min(0.6, cashRatio + (Math.random() - 0.5) * 0.02));
    ethAmt = Math.max(0, ethAmt + (Math.random() - 0.48) * 0.0004);
    xrpAmt = Math.max(0, xrpAmt + (Math.random() - 0.48) * 0.2);
    solAmt = Math.max(0, solAmt + (Math.random() - 0.48) * 0.003);
    const ethVal = Math.round(ethAmt * ethPrice * (1 + (Math.random() - 0.5) * 0.06));
    const xrpVal = Math.round(xrpAmt * xrpPrice * (1 + (Math.random() - 0.5) * 0.04));
    const solVal = Math.round(solAmt * solPrice * (1 + (Math.random() - 0.5) * 0.05));
    const coinTotal = ethVal + xrpVal + solVal;
    const jpyAvail = Math.round(totalAssets - coinTotal);
    const holdings = [
      { currency: 'eth', amount: Number(ethAmt.toFixed(6)), jpyValue: ethVal, sharePct: Number(((ethVal / totalAssets) * 100).toFixed(2)) },
      { currency: 'xrp', amount: Number(xrpAmt.toFixed(2)), jpyValue: xrpVal, sharePct: Number(((xrpVal / totalAssets) * 100).toFixed(2)) },
      { currency: 'sol', amount: Number(solAmt.toFixed(4)), jpyValue: solVal, sharePct: Number(((solVal / totalAssets) * 100).toFixed(2)) },
    ].filter((h) => h.jpyValue > 0);
    // 保有銘柄のスパークライン用に、そのサイクル時点の各ペア価格を記録する
    btcMark = Math.max(8_000_000, btcMark * (1 + (Math.random() - 0.5) * 0.012));
    const prices: Record<string, number> = {
      btc_jpy: Math.round(btcMark),
      eth_jpy: Math.round(ethVal / Math.max(ethAmt, 1e-9)),
      xrp_jpy: Number((xrpVal / Math.max(xrpAmt, 1e-9)).toFixed(2)),
      sol_jpy: Math.round(solVal / Math.max(solAmt, 1e-9)),
    };
    points.push({
      t: now - i * 15 * 60_000,
      totalAssetsJpy: Math.round(totalAssets),
      jpyAvailable: Math.max(0, jpyAvail),
      holdings,
      prices,
    });
  }
  return points;
}

const snapshots = mockSnapshots();
const latest = snapshots[snapshots.length - 1].totalAssetsJpy;

function mockEvents(): TradeEvent[] {
  const events: TradeEvent[] = [];
  const now = Date.now();
  events.push({
    t: now - 32 * 60_000,
    type: 'decision',
    dryRun: true,
    outlook: '市場は方向感に欠けるが、ETHに緩やかな上昇圧力。分散を維持しつつ小幅な買い増しが妥当',
    proposedOrders: [{ pair: 'eth_jpy', action: 'buy', ratio: 0.5, confidence: 0.82, reason: '出来高を伴う上昇で押し目' }],
  });
  events.push({
    t: now - 31 * 60_000,
    type: 'order',
    dryRun: true,
    pair: 'eth_jpy',
    action: 'buy',
    sizeJpy: 1950,
    reason: '出来高を伴う上昇で押し目',
  });
  events.push({
    t: now - 30 * 60_000,
    type: 'skip',
    dryRun: true,
    pair: 'btc_jpy',
    action: 'buy',
    reason: '買っても保有量 0.00005632 btc が最低売却数量 0.005 btc に届かず、売れない資産(塩漬け)になるため見送り',
  });
  events.push({
    t: now - 17 * 60_000,
    type: 'decision',
    dryRun: true,
    outlook: '大きな変化なし。取引を見送り',
    proposedOrders: [],
  });
  return events;
}

const status: StatusData = {
  now: Date.now(),
  tradingEnabled: mockEnabled,
  portfolio: {
    jpyAvailable: Math.round(latest * 0.35),
    totalAssetsJpy: latest,
    holdings: [
      { currency: 'eth', amount: 0.0142, jpyValue: latest * 0.3, sharePct: 30 },
      { currency: 'xrp', amount: 12.4, jpyValue: latest * 0.17, sharePct: 17 },
      { currency: 'sol', amount: 0.18, jpyValue: latest * 0.18, sharePct: 18 },
    ],
  },
  goal: { targetJpy: 1_300_000_000, progressPct: (latest / 1_300_000_000) * 100 },
  tickers: [
    { pair: 'btc_jpy', last: 10388097, high: 10467584, low: 10300006, volume: 285.6, quote_volume: 2962670313, price_change_percent_24h: -0.0031 },
    { pair: 'eth_jpy', last: 290652, high: 292893, low: 286460, volume: 373.4, quote_volume: 108307916, price_change_percent_24h: 0.0009 },
    { pair: 'xrp_jpy', last: 179.32, high: 180.17, low: 177.5, volume: 367961, quote_volume: 65881139, price_change_percent_24h: -0.0017 },
    { pair: 'doge_jpy', last: 12.056, high: 12.4, low: 11.9, volume: 512000, quote_volume: 6181340, price_change_percent_24h: 0.021 },
    { pair: 'sol_jpy', last: 12600, high: 12800, low: 12350, volume: 91.3, quote_volume: 1151188, price_change_percent_24h: 0.013 },
    { pair: 'fpl_jpy', last: 0.205, high: 0.21, low: 0.2, volume: 5946746, quote_volume: 1219083, price_change_percent_24h: -0.024 },
    { pair: 'dai_jpy', last: 161.62, high: 162.79, low: 160.8, volume: 1117, quote_volume: 181135, price_change_percent_24h: 0.0047 },
    { pair: 'mona_jpy', last: 10.4, high: 10.4, low: 10.4, volume: 449, quote_volume: 4674, price_change_percent_24h: 0 },
    { pair: 'shib_jpy', last: 0.000702, high: 0.000719, low: 0.000701, volume: 49016503, quote_volume: 34766, price_change_percent_24h: -0.0127 },
  ],
  snapshots,
  inception: {
    firstAssetsJpy: 9500,
    firstDate: new Date(Date.now() - 60 * 24 * 60 * 60_000).toISOString(),
    changePct: ((latest - 9500) / 9500) * 100,
    changeJpy: latest - 9500,
  },
  depositWithdraw: {
    totalDepositsJpy: 15000,
    totalWithdrawalsJpy: 2000,
  },
  benchmark: {
    sinceDate: new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
    btcHoldValueJpy: Math.round(latest * 0.96),
    actualValueJpy: Math.round(latest),
    botReturnPct: 8.2,
    btcReturnPct: 3.9,
    alphaJpy: Math.round(latest * 0.04),
  },
  realized: {
    realizedJpy: 1240,
    wins: 7,
    losses: 4,
    sellCount: 11,
  },
  events: mockEvents(),
  botLogs: [
    { t: Date.now() - 32 * 60_000, msg: `goal progress: ${latest} JPY / 1300000000 JPY (0.00${Math.round(latest / 130)}%)` },
    { t: Date.now() - 32 * 60_000, msg: 'gemini outlook: 市場は方向感に欠けるが、ETHに緩やかな上昇圧力。分散を維持しつつ小幅な買い増しが妥当' },
    { t: Date.now() - 31 * 60_000, msg: '[DRY_RUN] would market-buy 1950 JPY of eth_jpy — 出来高を伴う上昇で押し目' },
    { t: Date.now() - 31 * 60_000, msg: 'skip mona_jpy: 24h volume 4674 JPY < liquidity floor 100000 JPY' },
    { t: Date.now() - 31 * 60_000, msg: 'cycle done: 1 order(s) simulated' },
    { t: Date.now() - 17 * 60_000, msg: 'gemini outlook: 大きな変化なし。取引を見送り' },
    { t: Date.now() - 17 * 60_000, msg: 'no trade proposed' },
  ],
  traderConfig: {
    DRY_RUN: 'true',
    ORDER_PCT_OF_ASSETS: '15',
    MAX_ORDER_JPY_CAP: '50000',
    MAX_ORDERS_PER_CYCLE: '3',
    MAX_COIN_SHARE_PCT: '25',
    JPY_RESERVE_PCT: '10',
    MIN_CONFIDENCE: '0.7',
    MIN_LIQUIDITY_JPY: '100000',
    EXCLUDE_PAIRS: 'mona_jpy,bril_jpy,fpl_jpy,iost_jpy,sand_jpy,dai_jpy',
    GOAL_ASSETS_JPY: '1300000000',
    GEMINI_MODEL: 'gemini-3.5-flash',
  },
};

export const mockApi: Api = {
  async getStatus(): Promise<StatusData> {
    return { ...status, tradingEnabled: mockEnabled, now: Date.now() };
  },
  async setTrading(enabled: boolean): Promise<boolean> {
    await new Promise((r) => setTimeout(r, 400));
    mockEnabled = enabled;
    return enabled;
  },
  async resetHistory(): Promise<number> {
    await new Promise((r) => setTimeout(r, 600));
    return 0; // デモではDBが無いので0件
  },
};
