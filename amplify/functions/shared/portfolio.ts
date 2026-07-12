import type { Balance, PairTicker } from '../trader/coincheck';

export interface HoldingInfo {
  currency: string;
  amount: number;
  jpyValue: number;
  /** ポートフォリオ全体に占める割合 (%) */
  sharePct: number;
  /** 実注文履歴から復元した平均取得単価(記録がある銘柄のみ) */
  avgEntryPrice?: number;
  /** 取得単価に対する含み損益率 (%) */
  pnlPct?: number;
}

export interface Portfolio {
  jpyAvailable: number;
  totalAssetsJpy: number;
  holdings: HoldingInfo[];
}

/** 残高と相場からポートフォリオを円換算で評価する(trader と control で共用) */
export function buildPortfolio(
  tickers: Iterable<PairTicker>,
  balance: Balance,
  allRates?: Record<string, Record<string, string>>,
): Portfolio {
  const jpyAvailable = Number(balance.jpy) || 0;
  const holdings: HoldingInfo[] = [];

  // 1. tickers にある銘柄を処理
  const processedCurrencies = new Set<string>();
  for (const ticker of tickers) {
    if (ticker.last <= 0) continue;
    const currency = ticker.pair.split('_')[0];
    const amount = Number(balance[currency]) || 0;
    if (amount <= 0) continue;
    holdings.push({ currency, amount, jpyValue: amount * ticker.last, sharePct: 0 });
    processedCurrencies.add(currency);
  }

  // 2. tickers にないが残高がある銘柄(OTC専用など、例: APE)を allRates で処理
  if (allRates?.jpy) {
    for (const currency of Object.keys(balance)) {
      if (currency === 'success' || currency === 'jpy') continue;
      if (processedCurrencies.has(currency)) continue;

      const amount = Number(balance[currency]) || 0;
      if (amount <= 0) continue;

      const rateStr = allRates.jpy[currency];
      if (rateStr) {
        const rate = Number(rateStr);
        if (rate > 0) {
          holdings.push({ currency, amount, jpyValue: amount * rate, sharePct: 0 });
          processedCurrencies.add(currency);
        }
      }
    }
  }

  // 3. 全体の集計
  const totalAssetsJpy = jpyAvailable + holdings.reduce((s, h) => s + h.jpyValue, 0);
  for (const h of holdings) {
    h.sharePct = totalAssetsJpy > 0 ? (h.jpyValue / totalAssetsJpy) * 100 : 0;
  }
  
  // 評価額(円)が大きい順にソートしておく
  holdings.sort((a, b) => b.jpyValue - a.jpyValue);

  return { jpyAvailable, totalAssetsJpy, holdings };
}
