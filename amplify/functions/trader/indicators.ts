/**
 * 価格系列(古い順)から計算するテクニカル指標。
 * LLM に「上昇圧力」「底堅い」といった曖昧な印象ではなく数値根拠で判断させるため、
 * 決定的な計算はすべてコード側で行い、結果だけをプロンプトに渡す。
 * データ不足の指標は undefined を返し、プロンプトからは自動的に省かれる。
 */

/** 市場1ペア分のテクニカル指標。すべて省略可能(データ不足時) */
export interface TechnicalIndicators {
  /** RSI(14)。70超は過熱(買われすぎ)、30未満は売られすぎの目安 */
  rsi14?: number;
  /** 直近価格の6時間単純移動平均からの乖離率(%)。正=短期的に上に伸びている */
  ma6hDevPct?: number;
  /** 1時間リターンの標準偏差(%)。値が大きいほど荒い値動き */
  vol24hPct?: number;
  /** 7日レンジ内の現在位置(0=期間安値, 100=期間高値) */
  range7dPosPct?: number;
}

/** RSI (Wilder の単純平均版)。period+1 点未満のデータでは undefined */
export function rsi(pricesOldestFirst: number[], period = 14): number | undefined {
  if (pricesOldestFirst.length < period + 1) return undefined;
  const recent = pricesOldestFirst.slice(-(period + 1));
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < recent.length; i += 1) {
    const diff = recent[i] - recent[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  // 全く動いていない場合は中立の50とする(0除算の回避)
  if (gain + loss === 0) return 50;
  if (loss === 0) return 100;
  const rs = gain / loss;
  return round1((100 * rs) / (1 + rs));
}

/** 直近価格の、直近 window 点の単純移動平均からの乖離率(%) */
export function smaDeviationPct(pricesOldestFirst: number[], window: number): number | undefined {
  if (pricesOldestFirst.length < window || window <= 0) return undefined;
  const recent = pricesOldestFirst.slice(-window);
  const sma = recent.reduce((a, b) => a + b, 0) / window;
  if (sma <= 0) return undefined;
  const last = pricesOldestFirst[pricesOldestFirst.length - 1];
  return round2(((last - sma) / sma) * 100);
}

/** 隣接点間リターンの標本標準偏差(%)。ボラティリティの目安 */
export function returnsVolatilityPct(pricesOldestFirst: number[]): number | undefined {
  const returns: number[] = [];
  for (let i = 1; i < pricesOldestFirst.length; i += 1) {
    if (pricesOldestFirst[i - 1] > 0) {
      returns.push((pricesOldestFirst[i] - pricesOldestFirst[i - 1]) / pricesOldestFirst[i - 1]);
    }
  }
  if (returns.length < 2) return undefined;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  return round2(Math.sqrt(variance) * 100);
}

/** 期間高値・安値レンジ内での現在価格の位置(0〜100)。レンジ幅0なら中立の50 */
export function rangePositionPct(pricesOldestFirst: number[]): number | undefined {
  if (pricesOldestFirst.length < 2) return undefined;
  const high = Math.max(...pricesOldestFirst);
  const low = Math.min(...pricesOldestFirst);
  if (high === low) return 50;
  const last = pricesOldestFirst[pricesOldestFirst.length - 1];
  return round1(((last - low) / (high - low)) * 100);
}

/**
 * 1ペア分の指標セットを構築する。
 * history24h は1時間ごと(約25点)、history7d は6時間ごと(約29点)の系列を想定。
 * 全指標が計算不能ならオブジェクトごと undefined(プロンプトのトークン節約)。
 */
export function buildIndicators(
  history24h: number[],
  history7d: number[],
): TechnicalIndicators | undefined {
  const indicators: TechnicalIndicators = {
    rsi14: rsi(history24h, 14),
    ma6hDevPct: smaDeviationPct(history24h, 6),
    vol24hPct: returnsVolatilityPct(history24h),
    range7dPosPct: rangePositionPct(history7d),
  };
  const hasAny = Object.values(indicators).some((v) => v !== undefined);
  return hasAny ? indicators : undefined;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
