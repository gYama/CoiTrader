import { querySnapshots, type TradeEvent, type SnapshotPoint } from '../shared/history';

/**
 * 過去の実注文から復元した、ある通貨の取得状況。
 * DBに状態を持たないステートレス設計を保ったまま、注文履歴(事実の記録)だけから
 * 毎サイクル計算し直す。
 */
export interface CostBasis {
  /** 履歴上の現在保有量(買いで増え、売りで減る) */
  amount: number;
  /** 平均取得単価(加重平均法)。売りでは変わらない */
  avgPrice: number;
}

/** 実注文履歴(古い順)から通貨ごとの平均取得単価を復元する */
export function computeCostBasis(ordersOldestFirst: TradeEvent[]): Map<string, CostBasis> {
  const basis = new Map<string, CostBasis>();
  for (const e of ordersOldestFirst) {
    if (e.type !== 'order' || e.dryRun || !e.pair || !e.price || e.price <= 0) continue;
    const currency = e.pair.split('_')[0];
    const b = basis.get(currency) ?? { amount: 0, avgPrice: 0 };
    if (e.action === 'buy' && e.sizeJpy) {
      // 手数料分だけ実受取は少ないが、基準が僅かに低く出る(=損切りが僅かに早まる)だけなので安全側
      const coins = e.sizeJpy / e.price;
      const totalCost = b.amount * b.avgPrice + e.sizeJpy;
      b.amount += coins;
      b.avgPrice = totalCost / b.amount;
    } else if (e.action !== 'buy' && e.sizeCoin) {
      // 売却系はすべて保有量を減らす(sell=ストップロス, sell_all/sell_half=Gemini提案)。
      // 'sell' だけを見る旧実装では sell_all/sell_half 後も原価が残り続け、
      // 再購入時の平均取得単価と含み損益率が汚染されるバグがあった
      b.amount = Math.max(0, b.amount - e.sizeCoin);
      if (b.amount === 0) b.avgPrice = 0;
    }
    basis.set(currency, b);
  }
  return basis;
}

/** 決済(売却)ごとに確定した損益の集計 */
export interface RealizedPnl {
  /** 確定損益の合計(円)。売却代金 − 平均取得原価 */
  realizedJpy: number;
  /** 利益が出た決済の件数 */
  wins: number;
  /** 損失が出た決済の件数 */
  losses: number;
  /** 決済(売却)総数 */
  sellCount: number;
}

/**
 * 実注文履歴(古い順)から確定損益を計算する。平均取得原価法。
 * 売却のたびに「売却代金 − その時点の平均取得単価 × 売却数量」を損益として確定する。
 * 注: Coincheck現物の主要JPYペアはテイカー手数料が現状ほぼ0%のため手数料は未計上(gross)。
 */
export function computeRealizedPnl(ordersOldestFirst: TradeEvent[]): RealizedPnl {
  const basis = new Map<string, CostBasis>();
  const result: RealizedPnl = { realizedJpy: 0, wins: 0, losses: 0, sellCount: 0 };
  for (const e of ordersOldestFirst) {
    if (e.type !== 'order' || e.dryRun || !e.pair || !e.price || e.price <= 0) continue;
    const currency = e.pair.split('_')[0];
    const b = basis.get(currency) ?? { amount: 0, avgPrice: 0 };
    if (e.action === 'buy' && e.sizeJpy) {
      const coins = e.sizeJpy / e.price;
      const totalCost = b.amount * b.avgPrice + e.sizeJpy;
      b.amount += coins;
      b.avgPrice = totalCost / b.amount;
    } else if (e.action !== 'buy' && e.sizeCoin) {
      // 売却系(sell / sell_all / sell_half)。原価が復元できている分だけ損益を確定する
      const soldCoins = Math.min(e.sizeCoin, b.amount);
      if (b.avgPrice > 0 && soldCoins > 0) {
        const proceeds = e.sizeJpy ?? soldCoins * e.price;
        const cost = b.avgPrice * soldCoins;
        const pnl = proceeds - cost;
        result.realizedJpy += pnl;
        result.sellCount += 1;
        if (pnl >= 0) result.wins += 1;
        else result.losses += 1;
      }
      b.amount = Math.max(0, b.amount - e.sizeCoin);
      if (b.amount === 0) b.avgPrice = 0;
    }
    basis.set(currency, b);
  }
  result.realizedJpy = Math.round(result.realizedJpy);
  return result;
}

/**
 * サーキットブレーカー用のドローダウン率(%)を計算する。
 *
 * 通常の変化率(buildPerformance)と違い、以下を考慮する:
 * - baselineMs: 計測開始の下限時刻。手動再開後はその時刻を渡すことで、
 *   再開前の下落を「過去の出来事」として計測対象から外す(即再発動の防止)。
 * - netFlowJpy: 期間内のJPY純入出金(入金 − 出金)。入金は資産を見かけ上増やし、
 *   出金は見かけ上減らすため、これを取り除いた「純粋な運用成績」で判定する
 *   (10%超を出金しただけで暴落と誤認して緊急停止するのを防ぐ)。
 *
 * 基準スナップショットが取れない/評価額0のときは undefined(判定不能)。
 */
export function computeDrawdownPct(
  nowAssetsJpy: number,
  points: SnapshotPoint[],
  baselineMs: number,
  netFlowJpy: number,
): number | undefined {
  // baselineMs 以前で最も新しいスナップショットを基準にする
  let base: SnapshotPoint | undefined;
  for (const p of points) {
    if (p.t <= baselineMs && (!base || p.t > base.t)) base = p;
  }
  // baselineMs 以前が無ければ、baselineMs 以降の最古を基準にする(データが浅い初期など)
  if (!base) {
    for (const p of points) {
      if (!base || p.t < base.t) base = p;
    }
  }
  if (!base || base.totalAssetsJpy <= 0) return undefined;
  const adjustedNow = nowAssetsJpy - netFlowJpy;
  return ((adjustedNow - base.totalAssetsJpy) / base.totalAssetsJpy) * 100;
}

export interface PerformanceSummary {
  /** 総資産の過去24時間の変化率(%)。スナップショットが無ければ undefined */
  change24hPct?: number;
  /** 総資産の過去7日間の変化率(%) */
  change7dPct?: number;
}

/** スナップショット履歴から総資産の実績変化率を計算する(Gemini への成績フィードバック用) */
export function buildPerformance(nowAssetsJpy: number, points: SnapshotPoint[]): PerformanceSummary {
  if (points.length === 0) return {};

  // 指定時点以前で最も新しいスナップショットを基準にする
  const baseAt = (ms: number) => {
    let best: SnapshotPoint | undefined;
    for (const p of points) {
      if (p.t <= ms && (!best || p.t > best.t)) best = p;
    }
    return best;
  };
  const pct = (base?: { totalAssetsJpy: number }) =>
    base && base.totalAssetsJpy > 0
      ? Math.round(((nowAssetsJpy - base.totalAssetsJpy) / base.totalAssetsJpy) * 10000) / 100
      : undefined;

  return {
    change24hPct: pct(baseAt(Date.now() - 24 * 3600_000)),
    change7dPct: pct(points[0]),
  };
}
