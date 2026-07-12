import { useMemo, useRef, useState } from 'react';
import type { SnapshotPoint } from './api';

/* ===== 共通ユーティリティ ===== */
const W = 820;
const H = 300;
const PAD = { top: 24, right: 20, bottom: 36, left: 72 };
const INNER_W = W - PAD.left - PAD.right;
const INNER_H = H - PAD.top - PAD.bottom;

const yen = new Intl.NumberFormat('ja-JP');

/** 通貨ごとの固定カラー（積み上げ・ドーナツ共通） */
const CURRENCY_COLORS: Record<string, string> = {
  jpy: '#7fae7f',
  btc: '#f7931a',
  eth: '#627eea',
  xrp: '#00aae4',
  sol: '#9945ff',
  doge: '#c3a634',
  shib: '#e45826',
  avax: '#e84142',
  matic: '#8247e5',
  dot: '#e6007a',
  ada: '#0033ad',
  link: '#2a5ada',
  atom: '#2e3148',
  xlm: '#14b6e7',
  trx: '#ff0013',
  mona: '#dec799',
  iost: '#1c1c1c',
  sand: '#04adef',
  wbtc: '#f09242',
  dai: '#fdc134',
  mkr: '#1aab9b',
  bril: '#a855f7',
  bc: '#5a9a5a',
  imx: '#18a0fb',
  apt: '#4ce4a3',
  hbar: '#3a3a3a',
  fpl: '#38bdf8',
};
const FALLBACK_COLORS = [
  '#e879a0', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa',
  '#fb923c', '#4ade80', '#f472b6', '#22d3ee', '#c084fc',
];
function colorFor(currency: string, index: number): string {
  return CURRENCY_COLORS[currency] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

function formatTick(v: number): string {
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}億`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}万`;
  return yen.format(Math.round(v));
}

function formatDateShort(t: number): string {
  return new Date(t).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
}

function formatDateTime(t: number): string {
  return new Date(t).toLocaleString('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

type ChartView = 'stacked' | 'line' | 'returns' | 'donut' | 'holdings';
const VIEWS: { key: ChartView; icon: string; label: string }[] = [
  { key: 'stacked', icon: '📊', label: '資産構成' },
  { key: 'line', icon: '💰', label: '総資産' },
  { key: 'returns', icon: '📈', label: '日次リターン' },
  { key: 'donut', icon: '🥧', label: '構成比' },
  { key: 'holdings', icon: '🪙', label: '保有量' },
];

/* ===== データ加工 ===== */

interface CurrencySlice {
  currency: string;
  color: string;
}

/** 全ポイントに登場する通貨を収集し、一貫した順序と色を割り当てる */
function collectCurrencies(points: SnapshotPoint[]): CurrencySlice[] {
  const seen = new Map<string, number>();
  for (const p of points) {
    for (const h of p.holdings ?? []) {
      if (!seen.has(h.currency)) seen.set(h.currency, seen.size);
    }
  }
  return [...seen.entries()].map(([currency, idx]) => ({
    currency,
    color: colorFor(currency, idx),
  }));
}

/** 15分粒度を日次集計する（日次リターン棒グラフ用） */
interface DailyReturn {
  date: string;
  t: number;
  returnPct: number;
  openValue: number;
  closeValue: number;
}
function computeDailyReturns(points: SnapshotPoint[]): DailyReturn[] {
  if (points.length < 2) return [];
  // グループ化(日ごと)
  const byDay = new Map<string, SnapshotPoint[]>();
  for (const p of points) {
    const d = new Date(p.t).toLocaleDateString('ja-JP');
    const arr = byDay.get(d);
    if (arr) arr.push(p);
    else byDay.set(d, [p]);
  }
  const days = [...byDay.entries()];
  const returns: DailyReturn[] = [];
  for (let i = 1; i < days.length; i++) {
    const prevDay = days[i - 1][1];
    const currDay = days[i][1];
    const prevClose = prevDay[prevDay.length - 1].totalAssetsJpy;
    const currClose = currDay[currDay.length - 1].totalAssetsJpy;
    if (prevClose <= 0) continue;
    returns.push({
      date: days[i][0],
      t: currDay[0].t,
      returnPct: ((currClose - prevClose) / prevClose) * 100,
      openValue: prevClose,
      closeValue: currClose,
    });
  }
  return returns;
}

/* ===== Y軸目盛りヘルパー ===== */
function niceYTicks(min: number, max: number, count = 5): number[] {
  const range = max - min;
  if (range <= 0) return [min];
  const raw = range / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const nice = [1, 2, 5, 10].find((n) => n * mag >= raw)! * mag;
  const start = Math.floor(min / nice) * nice;
  const ticks: number[] = [];
  for (let v = start; v <= max + nice * 0.1; v += nice) {
    if (v >= min - nice * 0.5) ticks.push(v);
  }
  return ticks;
}

/* ===== X軸日付目盛りヘルパー ===== */
function xDateTicks(tMin: number, tMax: number, maxTicks = 6): number[] {
  const range = tMax - tMin;
  const dayMs = 86_400_000;
  const intervals = [dayMs, 2 * dayMs, 7 * dayMs, 14 * dayMs, 30 * dayMs, 90 * dayMs];
  const interval = intervals.find((i) => range / i <= maxTicks) ?? intervals[intervals.length - 1];
  const ticks: number[] = [];
  let t = Math.ceil(tMin / interval) * interval;
  while (t <= tMax) {
    ticks.push(t);
    t += interval;
  }
  return ticks;
}

/* ===== 1. 積み上げエリアチャート ===== */
function StackedAreaChart({ points }: { points: SnapshotPoint[] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const { currencies, geometry } = useMemo(() => {
    const currencies = collectCurrencies(points);
    if (points.length < 2) return { currencies, geometry: null };

    const tMin = points[0].t;
    const tMax = points[points.length - 1].t;
    const vMax = Math.max(...points.map((p) => p.totalAssetsJpy));
    const vPad = vMax * 0.08;

    const x = (t: number) => PAD.left + ((t - tMin) / Math.max(1, tMax - tMin)) * INNER_W;
    const y = (v: number) => H - PAD.bottom - (v / (vMax + vPad)) * INNER_H;

    // 各通貨の積み上げ値を計算
    const stacks: number[][] = points.map((p) => {
      const holdingMap = new Map((p.holdings ?? []).map((h) => [h.currency, h.jpyValue]));
      let cumulative = p.jpyAvailable; // 底はJPY
      const vals = [cumulative]; // index 0 = JPY top
      for (const c of currencies) {
        cumulative += holdingMap.get(c.currency) ?? 0;
        vals.push(cumulative);
      }
      return vals;
    });

    // SVGパスを生成（下から上へ積み上げ）
    const areas: { currency: string; color: string; path: string }[] = [];

    // JPY エリア（最下層: 0 → jpyAvailable）
    const jpyTop = points.map((p, i) => `${x(p.t).toFixed(1)},${y(stacks[i][0]).toFixed(1)}`);
    const jpyBot = points.map((p) => `${x(p.t).toFixed(1)},${y(0).toFixed(1)}`);
    areas.push({
      currency: 'jpy',
      color: CURRENCY_COLORS.jpy,
      path: `M${jpyTop.join(' L')} L${jpyBot.reverse().join(' L')} Z`,
    });

    // 各通貨エリア
    for (let ci = 0; ci < currencies.length; ci++) {
      const top = points.map((p, i) => `${x(p.t).toFixed(1)},${y(stacks[i][ci + 1]).toFixed(1)}`);
      const bot = points.map((p, i) => `${x(p.t).toFixed(1)},${y(stacks[i][ci]).toFixed(1)}`);
      areas.push({
        currency: currencies[ci].currency,
        color: currencies[ci].color,
        path: `M${top.join(' L')} L${bot.reverse().join(' L')} Z`,
      });
    }

    const yTicks = niceYTicks(0, vMax);
    const xTicks = xDateTicks(tMin, tMax);

    return { currencies, geometry: { x, y, areas, yTicks, xTicks, tMin, tMax, vMax, stacks } };
  }, [points]);

  if (!geometry) {
    return <div className="chart-empty">📈 データの蓄積待ちです。</div>;
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(geometry.x(p.t) - px);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    setHover(best);
  };

  const hp = hover !== null ? points[hover] : null;
  const hStacks = hover !== null ? geometry.stacks[hover] : null;

  return (
    <div className="chart-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="asset-chart"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="資産構成の推移（積み上げエリア）"
      >
        {/* Y軸グリッド */}
        {geometry.yTicks.map((v, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={geometry.y(v)} y2={geometry.y(v)} className="gridline" />
            <text x={PAD.left - 8} y={geometry.y(v) + 4} className="tick" textAnchor="end">{formatTick(v)}</text>
          </g>
        ))}
        {/* X軸目盛り */}
        {geometry.xTicks.map((t, i) => (
          <text key={i} x={geometry.x(t)} y={H - 8} className="tick" textAnchor="middle">{formatDateShort(t)}</text>
        ))}
        <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} className="baseline" />
        {/* 積み上げエリア */}
        {geometry.areas.map((a) => (
          <path key={a.currency} d={a.path} fill={a.color} opacity={0.7} />
        ))}
        {/* 総資産ライン（最上部） */}
        <path
          d={points.map((p, i) => `${i === 0 ? 'M' : 'L'}${geometry.x(p.t).toFixed(1)},${geometry.y(p.totalAssetsJpy).toFixed(1)}`).join(' ')}
          fill="none"
          stroke="var(--gold)"
          strokeWidth={1.5}
          opacity={0.9}
        />
        {/* ホバークロスヘア */}
        {hp && (
          <g>
            <line
              x1={geometry.x(hp.t)} x2={geometry.x(hp.t)}
              y1={PAD.top} y2={H - PAD.bottom}
              className="crosshair"
            />
            <circle cx={geometry.x(hp.t)} cy={geometry.y(hp.totalAssetsJpy)} r={4} className="hover-dot" />
          </g>
        )}
      </svg>
      {/* ツールチップ */}
      {hp && hStacks && (
        <div className="chart-tooltip stacked-tooltip">
          <div className="tooltip-date">{formatDateTime(hp.t)}</div>
          <div className="tooltip-total">
            総資産 <strong>¥{yen.format(Math.round(hp.totalAssetsJpy))}</strong>
          </div>
          <div className="tooltip-breakdown">
            <div className="tooltip-row">
              <span className="tooltip-swatch" style={{ background: CURRENCY_COLORS.jpy }} />
              <span>JPY</span>
              <span className="tooltip-val">¥{yen.format(Math.round(hp.jpyAvailable))}</span>
            </div>
            {currencies.map((c, ci) => {
              const val = (hStacks[ci + 1] ?? 0) - (hStacks[ci] ?? 0);
              if (val <= 0) return null;
              return (
                <div className="tooltip-row" key={c.currency}>
                  <span className="tooltip-swatch" style={{ background: c.color }} />
                  <span>{c.currency.toUpperCase()}</span>
                  <span className="tooltip-val">¥{yen.format(Math.round(val))}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {/* 凡例 */}
      <div className="chart-legend">
        <span className="legend-item" style={{ color: CURRENCY_COLORS.jpy }}>● JPY</span>
        {currencies.map((c) => (
          <span key={c.currency} className="legend-item" style={{ color: c.color }}>
            ● {c.currency.toUpperCase()}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ===== 2. 総資産ラインチャート ===== */
function LineChart({ points }: { points: SnapshotPoint[] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const geometry = useMemo(() => {
    if (points.length < 2) return null;
    const ts = points.map((p) => p.t);
    const assets = points.map((p) => p.totalAssetsJpy);
    const cash = points.map((p) => p.jpyAvailable);
    const tMin = Math.min(...ts);
    const tMax = Math.max(...ts);
    const allValues = [...assets, ...cash];
    const vMin = Math.min(...allValues);
    const vMax = Math.max(...allValues);
    const vPad = Math.max((vMax - vMin) * 0.12, vMax * 0.02, 1);
    const y0 = vMin - vPad;
    const y1 = vMax + vPad;
    const x = (t: number) => PAD.left + ((t - tMin) / Math.max(1, tMax - tMin)) * INNER_W;
    const y = (v: number) => H - PAD.bottom - ((v - y0) / (y1 - y0)) * INNER_H;
    const assetPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.totalAssetsJpy).toFixed(1)}`).join(' ');
    const cashPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.jpyAvailable).toFixed(1)}`).join(' ');
    const area = `${assetPath} L${x(tMax).toFixed(1)},${y(y0).toFixed(1)} L${x(tMin).toFixed(1)},${y(y0).toFixed(1)} Z`;
    const yTicks = niceYTicks(y0, y1);
    const xTicks = xDateTicks(tMin, tMax);

    // 最高値・最低値
    let maxIdx = 0;
    let minIdx = 0;
    for (let i = 1; i < assets.length; i++) {
      if (assets[i] > assets[maxIdx]) maxIdx = i;
      if (assets[i] < assets[minIdx]) minIdx = i;
    }

    // 変化率
    const first = assets[0];
    const last = assets[assets.length - 1];
    const changeJpy = last - first;
    const changePct = first > 0 ? (changeJpy / first) * 100 : 0;

    return { x, y, assetPath, cashPath, area, yTicks, xTicks, tMin, tMax, maxIdx, minIdx, changeJpy, changePct };
  }, [points]);

  if (!geometry) {
    return <div className="chart-empty">📈 データの蓄積待ちです。</div>;
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(geometry.x(p.t) - px);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    setHover(best);
  };

  const h = hover !== null ? points[hover] : null;
  const maxP = points[geometry.maxIdx];
  const minP = points[geometry.minIdx];
  const isUp = geometry.changeJpy >= 0;

  return (
    <div className="chart-wrap">
      {/* 変化率バッジ */}
      <div className={`change-badge ${isUp ? 'up' : 'down'}`}>
        <span className="change-arrow">{isUp ? '▲' : '▼'}</span>
        <span className="change-pct">{isUp ? '+' : ''}{geometry.changePct.toFixed(2)}%</span>
        <span className="change-abs">{isUp ? '+' : ''}¥{yen.format(Math.round(geometry.changeJpy))}</span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="asset-chart"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="総資産と現金の推移（円）"
      >
        <defs>
          <linearGradient id="goldFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f0c24b" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#f0c24b" stopOpacity="0" />
          </linearGradient>
        </defs>
        {geometry.yTicks.map((v, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={geometry.y(v)} y2={geometry.y(v)} className="gridline" />
            <text x={PAD.left - 8} y={geometry.y(v) + 4} className="tick" textAnchor="end">{formatTick(v)}</text>
          </g>
        ))}
        {geometry.xTicks.map((t, i) => (
          <text key={i} x={geometry.x(t)} y={H - 8} className="tick" textAnchor="middle">{formatDateShort(t)}</text>
        ))}
        <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} className="baseline" />
        <path d={geometry.area} fill="url(#goldFill)" />
        <path d={geometry.cashPath} className="cash-line" />
        <path d={geometry.assetPath} className="asset-line" />
        {/* 最高値マーカー */}
        <g className="extremum-marker">
          <circle cx={geometry.x(maxP.t)} cy={geometry.y(maxP.totalAssetsJpy)} r={4} fill="var(--up)" stroke="var(--bg)" strokeWidth={2} />
          <text
            x={geometry.x(maxP.t)}
            y={geometry.y(maxP.totalAssetsJpy) - 10}
            className="extremum-label high"
            textAnchor="middle"
          >
            ▲{formatTick(maxP.totalAssetsJpy)}
          </text>
        </g>
        {/* 最低値マーカー */}
        <g className="extremum-marker">
          <circle cx={geometry.x(minP.t)} cy={geometry.y(minP.totalAssetsJpy)} r={4} fill="var(--down)" stroke="var(--bg)" strokeWidth={2} />
          <text
            x={geometry.x(minP.t)}
            y={geometry.y(minP.totalAssetsJpy) + 16}
            className="extremum-label low"
            textAnchor="middle"
          >
            ▼{formatTick(minP.totalAssetsJpy)}
          </text>
        </g>
        {h && (
          <g>
            <line x1={geometry.x(h.t)} x2={geometry.x(h.t)} y1={PAD.top} y2={H - PAD.bottom} className="crosshair" />
            <circle cx={geometry.x(h.t)} cy={geometry.y(h.totalAssetsJpy)} r={5} className="hover-dot" />
            <circle cx={geometry.x(h.t)} cy={geometry.y(h.jpyAvailable)} r={3.5} className="hover-dot cash" />
          </g>
        )}
      </svg>
      {h && (
        <div className="chart-tooltip">
          <div className="tooltip-date">{formatDateTime(h.t)}</div>
          <div className="tooltip-total">
            総資産 <strong>¥{yen.format(Math.round(h.totalAssetsJpy))}</strong>
          </div>
          <span className="cash-tip">💴 ¥{yen.format(Math.round(h.jpyAvailable))}</span>
        </div>
      )}
      <div className="chart-legend">
        <span className="legend-asset">━ 総資産</span>
        <span className="legend-cash">━ 現金(JPY)</span>
      </div>
    </div>
  );
}

/* ===== 3. 日次リターン棒グラフ ===== */
function ReturnsChart({ points }: { points: SnapshotPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const data = useMemo(() => computeDailyReturns(points), [points]);

  const geometry = useMemo(() => {
    if (data.length < 1) return null;
    const values = data.map((d) => d.returnPct);
    const absMax = Math.max(Math.max(...values.map(Math.abs)), 0.5);
    const vRange = absMax * 1.2;

    const barW = Math.min(16, Math.max(2, (INNER_W / data.length) * 0.7));
    const gap = (INNER_W - barW * data.length) / Math.max(1, data.length - 1);

    const x = (i: number) => PAD.left + i * (barW + gap);
    const yScale = INNER_H / (vRange * 2);
    const zeroY = PAD.top + INNER_H / 2;
    const barHeight = (v: number) => Math.abs(v) * yScale;
    const barY = (v: number) => v >= 0 ? zeroY - barHeight(v) : zeroY;

    const yTicks = niceYTicks(-vRange, vRange, 4);
    const y = (v: number) => zeroY - v * yScale;

    // X軸（日付）は間引いて表示
    const xLabelStep = Math.max(1, Math.ceil(data.length / 8));

    // サマリー統計
    const wins = values.filter((v) => v > 0).length;
    const losses = values.filter((v) => v < 0).length;
    const avgReturn = values.reduce((a, b) => a + b, 0) / values.length;
    const maxReturn = Math.max(...values);
    const minReturn = Math.min(...values);

    return { barW, gap, x, y, zeroY, barHeight, barY, yTicks, xLabelStep, wins, losses, avgReturn, maxReturn, minReturn };
  }, [data]);

  if (!geometry || data.length === 0) {
    return <div className="chart-empty">📈 日次リターンの計算には2日分以上のデータが必要です。</div>;
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    data.forEach((_, i) => {
      const cx = geometry.x(i) + geometry.barW / 2;
      const d = Math.abs(cx - px);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    setHover(best);
  };

  const hd = hover !== null ? data[hover] : null;

  return (
    <div className="chart-wrap">
      {/* サマリー統計 */}
      <div className="returns-summary">
        <div className="returns-stat">
          <span className="stat-label">勝率</span>
          <span className="stat-value">{((geometry.wins / data.length) * 100).toFixed(0)}%</span>
          <span className="stat-detail up">{geometry.wins}勝</span>
          <span className="stat-detail down">{geometry.losses}敗</span>
        </div>
        <div className="returns-stat">
          <span className="stat-label">平均</span>
          <span className={`stat-value ${geometry.avgReturn >= 0 ? 'up' : 'down'}`}>
            {geometry.avgReturn >= 0 ? '+' : ''}{geometry.avgReturn.toFixed(3)}%
          </span>
        </div>
        <div className="returns-stat">
          <span className="stat-label">最高</span>
          <span className="stat-value up">+{geometry.maxReturn.toFixed(2)}%</span>
        </div>
        <div className="returns-stat">
          <span className="stat-label">最低</span>
          <span className="stat-value down">{geometry.minReturn.toFixed(2)}%</span>
        </div>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="asset-chart"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="日次リターン率の推移"
      >
        {/* Y軸グリッド */}
        {geometry.yTicks.map((v, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={geometry.y(v)} y2={geometry.y(v)} className="gridline" />
            <text x={PAD.left - 8} y={geometry.y(v) + 4} className="tick" textAnchor="end">
              {v > 0 ? '+' : ''}{v.toFixed(1)}%
            </text>
          </g>
        ))}
        {/* ゼロライン */}
        <line x1={PAD.left} x2={W - PAD.right} y1={geometry.zeroY} y2={geometry.zeroY} className="zero-line" />
        {/* 棒 */}
        {data.map((d, i) => (
          <rect
            key={i}
            x={geometry.x(i)}
            y={geometry.barY(d.returnPct)}
            width={geometry.barW}
            height={Math.max(1, geometry.barHeight(d.returnPct))}
            rx={1}
            fill={d.returnPct >= 0 ? 'var(--up)' : 'var(--down)'}
            opacity={hover === i ? 1 : 0.75}
          />
        ))}
        {/* X軸ラベル */}
        {data.map((d, i) => (
          i % geometry.xLabelStep === 0 ? (
            <text key={i} x={geometry.x(i) + geometry.barW / 2} y={H - 8} className="tick" textAnchor="middle">
              {formatDateShort(d.t)}
            </text>
          ) : null
        ))}
        {/* ホバーハイライト */}
        {hover !== null && (
          <line
            x1={geometry.x(hover) + geometry.barW / 2}
            x2={geometry.x(hover) + geometry.barW / 2}
            y1={PAD.top}
            y2={H - PAD.bottom}
            className="crosshair"
          />
        )}
      </svg>
      {hd && (
        <div className="chart-tooltip">
          <div className="tooltip-date">{hd.date}</div>
          <div className={`tooltip-return ${hd.returnPct >= 0 ? 'up' : 'down'}`}>
            {hd.returnPct >= 0 ? '+' : ''}{hd.returnPct.toFixed(3)}%
          </div>
          <div className="tooltip-detail">
            ¥{yen.format(Math.round(hd.openValue))} → ¥{yen.format(Math.round(hd.closeValue))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ===== 4. ドーナツチャート ===== */
function DonutChart({ points }: { points: SnapshotPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const data = useMemo(() => {
    if (points.length === 0) return null;
    const latest = points[points.length - 1];
    const total = latest.totalAssetsJpy;
    if (total <= 0) return null;

    const slices: { currency: string; label: string; value: number; pct: number; color: string }[] = [];
    slices.push({
      currency: 'jpy',
      label: 'JPY（現金）',
      value: latest.jpyAvailable,
      pct: (latest.jpyAvailable / total) * 100,
      color: CURRENCY_COLORS.jpy,
    });
    for (const h of latest.holdings ?? []) {
      slices.push({
        currency: h.currency,
        label: h.currency.toUpperCase(),
        value: h.jpyValue,
        pct: (h.jpyValue / total) * 100,
        color: colorFor(h.currency, slices.length),
      });
    }
    return { slices, total };
  }, [points]);

  if (!data) {
    return <div className="chart-empty">🥧 構成比データがありません。</div>;
  }

  const CX = 200;
  const CY = 140;
  const R = 110;
  const r = 65;
  const DONUT_W = 400;
  const DONUT_H = 280;

  let cumAngle = -Math.PI / 2;
  const arcs = data.slices.map((s, i) => {
    const angle = (s.value / data.total) * Math.PI * 2;
    const start = cumAngle;
    cumAngle += angle;
    const end = cumAngle;
    const isHovered = hoverIdx === i;
    const expand = isHovered ? 6 : 0;
    const midAngle = (start + end) / 2;
    const dx = Math.cos(midAngle) * expand;
    const dy = Math.sin(midAngle) * expand;

    const x1 = CX + Math.cos(start) * R + dx;
    const y1 = CY + Math.sin(start) * R + dy;
    const x2 = CX + Math.cos(end) * R + dx;
    const y2 = CY + Math.sin(end) * R + dy;
    const x3 = CX + Math.cos(end) * r + dx;
    const y3 = CY + Math.sin(end) * r + dy;
    const x4 = CX + Math.cos(start) * r + dx;
    const y4 = CY + Math.sin(start) * r + dy;
    const large = angle > Math.PI ? 1 : 0;

    const path = [
      `M${x1.toFixed(2)},${y1.toFixed(2)}`,
      `A${R},${R} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`,
      `L${x3.toFixed(2)},${y3.toFixed(2)}`,
      `A${r},${r} 0 ${large} 0 ${x4.toFixed(2)},${y4.toFixed(2)}`,
      'Z',
    ].join(' ');

    return { ...s, path, idx: i };
  });

  const hoveredSlice = hoverIdx !== null ? data.slices[hoverIdx] : null;

  return (
    <div className="donut-wrap">
      <svg viewBox={`0 0 ${DONUT_W} ${DONUT_H}`} className="donut-chart" role="img" aria-label="ポートフォリオ構成比">
        {arcs.map((a) => (
          <path
            key={a.currency}
            d={a.path}
            fill={a.color}
            opacity={hoverIdx === null || hoverIdx === a.idx ? 0.85 : 0.35}
            stroke="var(--bg)"
            strokeWidth={2}
            onMouseEnter={() => setHoverIdx(a.idx)}
            onMouseLeave={() => setHoverIdx(null)}
            style={{ cursor: 'pointer', transition: 'opacity 0.15s' }}
          />
        ))}
        {/* 中央テキスト */}
        <text x={CX} y={CY - 8} textAnchor="middle" className="donut-center-label">
          {hoveredSlice ? hoveredSlice.label : '総資産'}
        </text>
        <text x={CX} y={CY + 16} textAnchor="middle" className="donut-center-value">
          {hoveredSlice ? `¥${yen.format(Math.round(hoveredSlice.value))}` : `¥${yen.format(Math.round(data.total))}`}
        </text>
        {hoveredSlice && (
          <text x={CX} y={CY + 34} textAnchor="middle" className="donut-center-pct">
            {hoveredSlice.pct.toFixed(1)}%
          </text>
        )}
      </svg>
      {/* 凡例テーブル */}
      <div className="donut-legend">
        {data.slices.map((s, i) => (
          <div
            className={`donut-legend-row ${hoverIdx === i ? 'active' : ''}`}
            key={s.currency}
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(null)}
          >
            <span className="tooltip-swatch" style={{ background: s.color }} />
            <span className="donut-legend-name">{s.label}</span>
            <span className="donut-legend-value">¥{yen.format(Math.round(s.value))}</span>
            <span className="donut-legend-pct">{s.pct.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ===== 5. 通貨別保有量チャート ===== */
function HoldingsChart({ points }: { points: SnapshotPoint[] }) {
  const currencies = useMemo(() => collectCurrencies(points), [points]);
  const [selected, setSelected] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  // 初期選択: 最新スナップショットで最も円換算額が大きい通貨
  const activeCurrency = useMemo(() => {
    if (selected && currencies.some((c) => c.currency === selected)) return selected;
    if (currencies.length === 0) return null;
    const latest = points[points.length - 1];
    const sorted = [...(latest.holdings ?? [])].sort((a, b) => b.jpyValue - a.jpyValue);
    return sorted[0]?.currency ?? currencies[0].currency;
  }, [selected, currencies, points]);

  // 選択通貨の時系列データを抽出
  const series = useMemo(() => {
    if (!activeCurrency) return null;
    const data = points.map((p) => {
      const h = (p.holdings ?? []).find((hh) => hh.currency === activeCurrency);
      return { t: p.t, amount: h?.amount ?? 0, jpyValue: h?.jpyValue ?? 0 };
    });
    return data;
  }, [points, activeCurrency]);

  const geometry = useMemo(() => {
    if (!series || series.length < 2) return null;
    const tMin = series[0].t;
    const tMax = series[series.length - 1].t;
    const amounts = series.map((s) => s.amount);
    const jpyValues = series.map((s) => s.jpyValue);
    const aMin = Math.min(...amounts);
    const aMax = Math.max(...amounts);
    const jMin = Math.min(...jpyValues);
    const jMax = Math.max(...jpyValues);
    const aPad = Math.max((aMax - aMin) * 0.12, aMax * 0.02, 0.0001);
    const jPad = Math.max((jMax - jMin) * 0.12, jMax * 0.02, 1);
    const a0 = Math.max(0, aMin - aPad);
    const a1 = aMax + aPad;
    const j0 = Math.max(0, jMin - jPad);
    const j1 = jMax + jPad;

    const x = (t: number) => PAD.left + ((t - tMin) / Math.max(1, tMax - tMin)) * (INNER_W - 52);
    const yA = (v: number) => H - PAD.bottom - ((v - a0) / Math.max(0.0001, a1 - a0)) * INNER_H;
    const yJ = (v: number) => H - PAD.bottom - ((v - j0) / Math.max(1, j1 - j0)) * INNER_H;

    const amountPath = series.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(s.t).toFixed(1)},${yA(s.amount).toFixed(1)}`).join(' ');
    const jpyPath = series.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(s.t).toFixed(1)},${yJ(s.jpyValue).toFixed(1)}`).join(' ');
    const jpyArea = `${jpyPath} L${x(tMax).toFixed(1)},${(H - PAD.bottom).toFixed(1)} L${x(tMin).toFixed(1)},${(H - PAD.bottom).toFixed(1)} Z`;

    const aTicksRaw = niceYTicks(a0, a1, 4);
    const jTicksRaw = niceYTicks(j0, j1, 4);
    const xTicks = xDateTicks(tMin, tMax);

    // 変化量サマリー
    const firstAmt = amounts[0];
    const lastAmt = amounts[amounts.length - 1];
    const amtChange = lastAmt - firstAmt;
    const amtChangePct = firstAmt > 0 ? (amtChange / firstAmt) * 100 : 0;

    return { x, yA, yJ, amountPath, jpyPath, jpyArea, aTicksRaw, jTicksRaw, xTicks, tMin, tMax, a0, a1, j0, j1, amtChange, amtChangePct, lastAmt };
  }, [series]);

  if (currencies.length === 0) {
    return <div className="chart-empty">🪙 保有通貨がまだありません。</div>;
  }

  const color = activeCurrency ? colorFor(activeCurrency, currencies.findIndex((c) => c.currency === activeCurrency)) : '#fff';

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!geometry || !series) return;
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    series.forEach((s, i) => {
      const d = Math.abs(geometry.x(s.t) - px);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    setHover(best);
  };

  const hp = hover !== null && series ? series[hover] : null;

  // 数量のフォーマット
  const formatAmount = (v: number) => {
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(2)}K`;
    if (v >= 1) return v.toFixed(4);
    return v.toFixed(8);
  };

  return (
    <div className="chart-wrap">
      {/* 通貨セレクター */}
      <div className="holdings-selector">
        {currencies.map((c) => (
          <button
            key={c.currency}
            className={`holdings-pill ${activeCurrency === c.currency ? 'active' : ''}`}
            style={{ '--pill-color': c.color } as React.CSSProperties}
            onClick={() => setSelected(c.currency)}
          >
            {c.currency.toUpperCase()}
          </button>
        ))}
      </div>
      {geometry && series ? (
        <>
          {/* 変化量バッジ */}
          <div className={`change-badge ${geometry.amtChange >= 0 ? 'up' : 'down'}`}>
            <span className="change-arrow">{geometry.amtChange >= 0 ? '▲' : '▼'}</span>
            <span className="change-pct">{geometry.amtChange >= 0 ? '+' : ''}{geometry.amtChangePct.toFixed(2)}%</span>
            <span className="change-abs">{geometry.amtChange >= 0 ? '+' : ''}{formatAmount(geometry.amtChange)} {activeCurrency?.toUpperCase()}</span>
          </div>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="asset-chart"
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            role="img"
            aria-label={`${activeCurrency?.toUpperCase()} の保有量推移`}
          >
            {/* 左Y軸: 数量 */}
            {geometry.aTicksRaw.map((v, i) => (
              <g key={`a${i}`}>
                <line x1={PAD.left} x2={W - PAD.right - 52} y1={geometry.yA(v)} y2={geometry.yA(v)} className="gridline" />
                <text x={PAD.left - 8} y={geometry.yA(v) + 4} className="tick" textAnchor="end" fill={color}>
                  {formatAmount(v)}
                </text>
              </g>
            ))}
            {/* 右Y軸: 円換算 */}
            {geometry.jTicksRaw.map((v, i) => (
              <text key={`j${i}`} x={W - PAD.right - 48} y={geometry.yJ(v) + 4} className="tick" textAnchor="start" fill="var(--muted)">
                {formatTick(v)}
              </text>
            ))}
            {/* X軸 */}
            {geometry.xTicks.map((t, i) => (
              <text key={i} x={geometry.x(t)} y={H - 8} className="tick" textAnchor="middle">{formatDateShort(t)}</text>
            ))}
            <line x1={PAD.left} x2={W - PAD.right - 52} y1={H - PAD.bottom} y2={H - PAD.bottom} className="baseline" />
            {/* 円換算エリア（薄い背景） */}
            <path d={geometry.jpyArea} fill={color} opacity={0.08} />
            <path d={geometry.jpyPath} fill="none" stroke={color} strokeWidth={1} opacity={0.3} strokeDasharray="4 2" />
            {/* 数量ライン（メイン） */}
            <path d={geometry.amountPath} fill="none" stroke={color} strokeWidth={2.5} />
            {/* ホバー */}
            {hp && (
              <g>
                <line x1={geometry.x(hp.t)} x2={geometry.x(hp.t)} y1={PAD.top} y2={H - PAD.bottom} className="crosshair" />
                <circle cx={geometry.x(hp.t)} cy={geometry.yA(hp.amount)} r={5} fill={color} stroke="var(--bg)" strokeWidth={2} />
                <circle cx={geometry.x(hp.t)} cy={geometry.yJ(hp.jpyValue)} r={3} fill={color} stroke="var(--bg)" strokeWidth={1.5} opacity={0.6} />
              </g>
            )}
          </svg>
          {hp && (
            <div className="chart-tooltip">
              <div className="tooltip-date">{formatDateTime(hp.t)}</div>
              <div style={{ color, fontWeight: 700, fontSize: 16 }}>
                {formatAmount(hp.amount)} {activeCurrency?.toUpperCase()}
              </div>
              <div className="tooltip-detail">≈ ¥{yen.format(Math.round(hp.jpyValue))}</div>
            </div>
          )}
          <div className="chart-legend">
            <span style={{ color }}>━ 保有量 ({activeCurrency?.toUpperCase()})</span>
            <span style={{ color, opacity: 0.4 }}>┈ 円換算</span>
          </div>
        </>
      ) : (
        <div className="chart-empty">選択中の通貨のデータがありません。</div>
      )}
    </div>
  );
}

/* ===== メインコンポーネント ===== */
export function AssetChart({ points }: { points: SnapshotPoint[] }) {
  const [view, setView] = useState<ChartView>('stacked');

  return (
    <div className="chart-container">
      <div className="chart-tabs">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            className={`chart-tab ${view === v.key ? 'active' : ''}`}
            onClick={() => setView(v.key)}
          >
            <span className="tab-icon">{v.icon}</span>
            <span className="tab-label">{v.label}</span>
          </button>
        ))}
      </div>
      <div className="chart-body">
        {view === 'stacked' && <StackedAreaChart points={points} />}
        {view === 'line' && <LineChart points={points} />}
        {view === 'returns' && <ReturnsChart points={points} />}
        {view === 'donut' && <DonutChart points={points} />}
        {view === 'holdings' && <HoldingsChart points={points} />}
      </div>
    </div>
  );
}
