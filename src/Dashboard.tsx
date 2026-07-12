import { useCallback, useEffect, useState } from 'react';
import type { Api, StatusData, Ticker, TradeEvent } from './api';
import { AssetChart } from './Chart';

const yen = new Intl.NumberFormat('ja-JP');

/** 価格を桁に応じた精度で表示する(高価格は整数、低価格は小数を残す) */
function formatPrice(v: number): string {
  if (v >= 1000) return yen.format(Math.round(v));
  if (v >= 1) return v.toLocaleString('ja-JP', { maximumFractionDigits: 2 });
  return v.toLocaleString('ja-JP', { maximumFractionDigits: 6 });
}

/** 15分周期の次サイクルまでの残り時間を mm:ss で返す(最新データ時刻を基準にする) */
function nextCycleCountdown(lastDataMs: number, nowMs: number): string {
  const period = 15 * 60_000;
  const elapsed = (nowMs - lastDataMs) % period;
  const remain = Math.max(0, period - elapsed);
  const m = Math.floor(remain / 60_000);
  const s = Math.floor((remain % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 全ペア価格が横に流れるティッカーテープ。データは /status の tickers をそのまま使う */
function TickerTape({ tickers }: { tickers: Ticker[] }) {
  const items = [...tickers].sort((a, b) => b.quote_volume - a.quote_volume);
  if (items.length === 0) return null;
  const row = (t: Ticker, key: string) => {
    const chg = t.price_change_percent_24h * 100;
    const dir = chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat';
    return (
      <span className="ticker-item" key={key}>
        <span className="ticker-pair">{t.pair.replace('_jpy', '').toUpperCase()}</span>
        <span className="ticker-price">¥{formatPrice(t.last)}</span>
        <span className={`ticker-chg ${dir}`}>
          {chg > 0 ? '▲' : chg < 0 ? '▼' : '─'}{Math.abs(chg).toFixed(2)}%
        </span>
      </span>
    );
  };
  // 途切れないループのため同じ内容を2連結し、トラックを -50% 動かす
  return (
    <div className="ticker-tape" aria-hidden="true">
      <div className="ticker-track">
        {items.map((t) => row(t, `a-${t.pair}`))}
        {items.map((t) => row(t, `b-${t.pair}`))}
      </div>
    </div>
  );
}

/** 稼働状態と次サイクルまでのカウントダウン */
function LiveIndicator({ enabled, lastDataMs }: { enabled: boolean; lastDataMs: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className={`live-badge ${enabled ? '' : 'paused'}`} title={enabled ? '自動売買 稼働中' : '自動売買 停止中'}>
      <span className="live-dot" />
      {enabled ? (
        <>LIVE <span className="live-countdown">次 {nextCycleCountdown(lastDataMs, now)}</span></>
      ) : (
        'PAUSED'
      )}
    </span>
  );
}

/** 保有銘柄の直近価格推移スパークライン。snapshots.prices から系列を作る */
function Sparkline({ prices }: { prices: number[] }) {
  if (prices.length < 2) return null;
  const w = 72;
  const h = 22;
  const pad = 2;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const step = (w - pad * 2) / (prices.length - 1);
  const d = prices
    .map((p, i) => {
      const x = pad + i * step;
      const y = pad + (1 - (p - min) / span) * (h - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const dir = prices[prices.length - 1] > prices[0] ? 'up' : prices[prices.length - 1] < prices[0] ? 'down' : 'flat';
  return (
    <svg className="holding-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path className={dir} d={d} />
    </svg>
  );
}

const CONFIG_LABELS: Record<string, string> = {
  DRY_RUN: 'ドライラン(実注文なし)',
  ORDER_PCT_OF_ASSETS: '1注文 = 総資産の%',
  MAX_ORDER_JPY_CAP: '1注文の絶対上限(円)',
  MAX_ORDERS_PER_CYCLE: '1サイクル最大注文数',
  MAX_COIN_SHARE_PCT: '1銘柄の占有上限(%)',
  JPY_RESERVE_PCT: '常時現金確保(%)',
  MIN_CONFIDENCE: '最低確信度',
  MIN_LIQUIDITY_JPY: '流動性下限(円/24h)',
  EXCLUDE_PAIRS: '除外ペア',
  GOAL_ASSETS_JPY: '目標資産(円)',
  GEMINI_MODEL: 'AIモデル',
};

function formatJpy(v: number): string {
  return `¥${yen.format(Math.round(v))}`;
}

function formatBig(v: number): string {
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(2)}億円`;
  if (v >= 10_000) return `${yen.format(Math.round(v / 10_000))}万円`;
  return `${yen.format(Math.round(v))}円`;
}

function formatEventTime(t: number): string {
  return new Date(t).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function EventIcon({ event }: { event: TradeEvent }) {
  if (event.type === 'decision') return <span title="AI判断">🧠</span>;
  if (event.type === 'skip') return <span title="見送り">⏸️</span>;
  if (event.action === 'buy') return <span title="買い注文">📈</span>;
  if (event.action?.startsWith('sell')) return <span title="売り注文">📉</span>;
  return <span>📋</span>;
}

function EventDetail({ event }: { event: TradeEvent }) {
  if (event.type === 'decision') {
    const count = Array.isArray(event.proposedOrders) ? event.proposedOrders.length : 0;
    return (
      <div className="event-detail">
        <span className="event-type decision">判断</span>
        <span className="event-outlook">{event.outlook ?? '—'}</span>
        <span className="event-count">{count > 0 ? `${count}件の注文を提案` : '見送り'}</span>
      </div>
    );
  }
  const pair = event.pair?.replace('_jpy', '').toUpperCase() ?? '';
  const actionLabel = event.action === 'buy' ? '買い' : event.action === 'sell_all' ? '全売' : event.action === 'sell_half' ? '半売' : event.action === 'sell' ? '売り' : '不明';
  if (event.type === 'skip') {
    return (
      <div className="event-detail">
        <span className="event-type skip">{actionLabel}見送り</span>
        <span className="event-pair">{pair}</span>
        {event.reason && <span className="event-reason">{event.reason}</span>}
      </div>
    );
  }
  const amount = event.sizeJpy ? formatJpy(event.sizeJpy) : event.sizeCoin ? `${event.sizeCoin}` : '';
  return (
    <div className="event-detail">
      <span className={`event-type ${event.action ?? ''}`}>{actionLabel}</span>
      <span className="event-pair">{pair}</span>
      <span className="event-amount">{amount}</span>
      {event.reason && <span className="event-reason">{event.reason}</span>}
      {event.orderId && <span className="event-order-id">#{event.orderId}</span>}
    </div>
  );
}

/** decision イベントの proposedOrders の中身(Gemini の提案) */
interface ProposedOrderView {
  pair?: string;
  action?: string;
  ratio?: number;
  confidence?: number;
  reason?: string;
}

/** クリックで開閉できるイベント1件。展開すると全文と提案の詳細が読める */
function EventItem({ event }: { event: TradeEvent }) {
  const [expanded, setExpanded] = useState(false);
  const orders = Array.isArray(event.proposedOrders)
    ? (event.proposedOrders as ProposedOrderView[])
    : [];
  const actionLabel = (a?: string) => (a === 'buy' ? '買い' : a === 'sell_all' ? '全売' : a === 'sell_half' ? '半売' : a === 'sell' ? '売り' : a ?? '');
  return (
    <div
      className={`event-item ${expanded ? 'expanded' : ''}`}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={() => setExpanded((v) => !v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setExpanded((v) => !v);
        }
      }}
    >
      <div className={`event-line ${event.type}`}>
        <span className="event-caret">{expanded ? '▾' : '▸'}</span>
        <span className="event-time">{formatEventTime(event.t)}</span>
        <span className="event-icon"><EventIcon event={event} /></span>
        <EventDetail event={event} />
        {event.dryRun && <span className="event-dry-badge">DRY</span>}
      </div>
      {expanded && (
        <div className="event-expand">
          {event.type === 'decision' ? (
            <>
              {event.outlook && <p className="event-full-text">{event.outlook}</p>}
              {orders.length > 0 ? (
                <ul className="event-orders">
                  {orders.map((o, i) => (
                    <li key={i}>
                      <span className={`event-type ${o.action ?? ''}`}>{actionLabel(o.action)}</span>{' '}
                      <strong>{(o.pair ?? '').replace('_jpy', '').toUpperCase()}</strong>
                      {typeof o.ratio === 'number' && <span className="event-meta"> ・割合 {(o.ratio * 100).toFixed(0)}%</span>}
                      {typeof o.confidence === 'number' && <span className="event-meta"> ・確信度 {o.confidence.toFixed(2)}</span>}
                      {o.reason && <div className="event-full-text">{o.reason}</div>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="event-meta">提案された注文はありません(見送り)。</p>
              )}
            </>
          ) : (
            <>
              {event.reason && <p className="event-full-text">{event.reason}</p>}
              <p className="event-meta">
                {event.pair && <>ペア: {event.pair} ・ </>}
                {event.sizeJpy !== undefined && <>金額: {formatJpy(event.sizeJpy)} ・ </>}
                {event.sizeCoin !== undefined && <>数量: {event.sizeCoin} ・ </>}
                {event.orderId !== undefined && <>注文ID: #{event.orderId} ・ </>}
                {event.type === 'skip'
                  ? '見送り(注文は出していません)'
                  : event.dryRun
                    ? 'ドライラン(実注文なし)'
                    : '実注文'}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  api: Api;
  userEmail: string;
  onSignOut: () => void;
}

export function Dashboard({ api, userEmail, onSignOut }: Props) {
  const [data, setData] = useState<StatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [toggling, setToggling] = useState(false);
  // 履歴リセット: idle → confirming(確認表示) → resetting(実行中) → 完了メッセージ
  const [resetState, setResetState] = useState<'idle' | 'confirming' | 'resetting'>('idle');
  const [resetResult, setResetResult] = useState<string | null>(null);
  const [showBgModal, setShowBgModal] = useState(false);

  const reload = useCallback(async () => {
    try {
      setData(await api.getStatus(days));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [api, days]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 60_000);
    return () => clearInterval(timer);
  }, [reload]);

  const toggle = async () => {
    if (!data || toggling) return;
    setToggling(true);
    try {
      const enabled = await api.setTrading(!data.tradingEnabled);
      setData({ ...data, tradingEnabled: enabled });
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setToggling(false);
    }
  };

  const resetHistory = async () => {
    setResetState('resetting');
    setResetResult(null);
    try {
      const deleted = await api.resetHistory();
      setResetResult(`✅ 履歴を削除しました(${deleted}件)。データは次のサイクルから再び蓄積されます。`);
      await reload();
    } catch (err) {
      setResetResult(`⚠️ 削除に失敗しました: ${String(err)}`);
    } finally {
      setResetState('idle');
    }
  };

  if (error && !data) {
    return (
      <div className="fortune-root">
        <div className="card error-card">⚠️ {error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="fortune-root">
        <div className="loading">🪙 開運準備中…</div>
      </div>
    );
  }

  const dryRun = data.traderConfig.DRY_RUN !== 'false';
  const sortedTickers = [...data.tickers].sort((a, b) => b.quote_volume - a.quote_volume);
  const liquidityFloor = Number(data.traderConfig.MIN_LIQUIDITY_JPY ?? 100000);
  const logsNewestFirst = [...data.botLogs].reverse();
  const eventsNewestFirst = [...data.events];

  // 保有銘柄ごとの価格系列(直近48点)をスナップショットから取り出す。スパークライン用
  const sparkFor = (currency: string): number[] => {
    const pair = `${currency}_jpy`;
    const series = data.snapshots
      .map((s) => s.prices?.[pair])
      .filter((p): p is number => typeof p === 'number' && p > 0);
    return series.slice(-48);
  };

  return (
    <div className="fortune-root">
      {showBgModal && (
        <div 
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', cursor: 'zoom-out' }}
          onClick={() => setShowBgModal(false)}
          title="クリックで閉じる"
        >
          <img src="/koi_bg.png" alt="鯉の滝登り" style={{ maxWidth: '95vw', maxHeight: '95vh', borderRadius: '16px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }} />
        </div>
      )}
      <header className="header">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <img src="/koi_icon.png" alt="Koi Icon" style={{ width: '32px', height: '32px', objectFit: 'contain' }} /> CoiTrader <span className="sub">金運ダッシュボード</span>
        </h1>
        <div className="header-right">
          <button className="ghost-btn" onClick={() => setShowBgModal(true)}>🐉 金運アート</button>
          <LiveIndicator enabled={data.tradingEnabled} lastDataMs={data.snapshots.at(-1)?.t ?? data.now} />
          <button className="ghost-btn" onClick={onSignOut}>退出</button>
        </div>
      </header>

      <TickerTape tickers={data.tickers} />

      {error && <div className="card error-card">⚠️ 更新に失敗: {error}</div>}

      <section className="hero card gold-card">
        <div className="hero-left">
          <div className="hero-label">💰 総資産</div>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
            <div className="hero-value mono">{formatJpy(data.portfolio.totalAssetsJpy)}</div>
            {data.inception && (
              <span className={`inception-badge ${data.inception.changeJpy >= 0 ? 'up' : 'down'}`}>
                <span className="inception-arrow">{data.inception.changeJpy >= 0 ? '▲' : '▼'}</span>
                <span className="inception-pct">
                  {data.inception.changeJpy >= 0 ? '+' : ''}{data.inception.changePct.toLocaleString('ja-JP', {maximumFractionDigits: 1})}%
                </span>
                <span className="inception-abs">
                  ({data.inception.changeJpy >= 0 ? '+' : ''}{formatJpy(data.inception.changeJpy)})
                </span>
              </span>
            )}
          </div>
          {data.inception && (
            <div className="hero-inception">
              <span className="inception-since">
                {new Date(data.inception.firstDate).toLocaleDateString('ja-JP')} ({formatJpy(data.inception.firstAssetsJpy)}) からの増減
              </span>
            </div>
          )}
          {data.depositWithdraw && (data.depositWithdraw.totalDepositsJpy > 0 || data.depositWithdraw.totalWithdrawalsJpy > 0) && (
            <div className="hero-cashflow">
              {data.depositWithdraw.totalDepositsJpy > 0 && (
                <span className="cashflow-chip deposit">
                  入金 {formatJpy(data.depositWithdraw.totalDepositsJpy)}
                </span>
              )}
              {data.depositWithdraw.totalWithdrawalsJpy > 0 && (
                <span className="cashflow-chip withdraw">
                  出金 {formatJpy(data.depositWithdraw.totalWithdrawalsJpy)}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="hero-right">
          <button
            className={`trade-switch ${data.tradingEnabled ? 'on' : 'off'}`}
            onClick={() => void toggle()}
            disabled={toggling}
          >
            <span className="switch-kanji">{data.tradingEnabled ? '商売繁盛' : '休業中'}</span>
            <span className="switch-state">
              自動売買 {toggling ? '…' : data.tradingEnabled ? 'ON' : 'OFF'}
            </span>
          </button>
          {dryRun && (
            <div className="dry-run-badge" title="実際の注文は送信されません">
              🧧 御守りモード(DRY RUN)— 実注文なし
            </div>
          )}
        </div>
      </section>

      {data.benchmark && (
        <section className="card benchmark-card">
          <h2>⚔️ BTC買い持ちとの勝負(アルファ)</h2>
          <div className="benchmark-grid">
            <div className="benchmark-col">
              <div className="benchmark-label">このボット</div>
              <div className={`benchmark-return mono ${data.benchmark.botReturnPct >= 0 ? 'up' : 'down'}`}>
                {data.benchmark.botReturnPct >= 0 ? '+' : ''}
                {data.benchmark.botReturnPct.toFixed(2)}%
              </div>
              <div className="benchmark-sub mono">{formatJpy(data.benchmark.actualValueJpy)}</div>
            </div>
            <div className="benchmark-vs">vs</div>
            <div className="benchmark-col">
              <div className="benchmark-label">BTC買い持ち</div>
              <div className={`benchmark-return mono ${data.benchmark.btcReturnPct >= 0 ? 'up' : 'down'}`}>
                {data.benchmark.btcReturnPct >= 0 ? '+' : ''}
                {data.benchmark.btcReturnPct.toFixed(2)}%
              </div>
              <div className="benchmark-sub mono">{formatJpy(data.benchmark.btcHoldValueJpy)}</div>
            </div>
          </div>
          <div className={`benchmark-alpha ${data.benchmark.alphaJpy >= 0 ? 'win' : 'lose'}`}>
            {data.benchmark.alphaJpy >= 0 ? '🎉 BTC放置に勝っています' : '⚠️ BTC放置に負けています'}
            <strong>
              {' '}
              {data.benchmark.alphaJpy >= 0 ? '+' : ''}
              {formatJpy(data.benchmark.alphaJpy)}
            </strong>
          </div>
          <div className="benchmark-note">
            {new Date(data.benchmark.sinceDate).toLocaleDateString('ja-JP')} 時点で全資産をBTCに換えて放置した場合との比較
          </div>
        </section>
      )}

      {data.realized && data.realized.sellCount > 0 && (
        <section className="card realized-card">
          <h2>💵 確定損益(実現P&L)</h2>
          <div className="realized-row">
            <div className="realized-main">
              <span className="realized-label">累計確定損益</span>
              <span className={`realized-value mono ${data.realized.realizedJpy >= 0 ? 'up' : 'down'}`}>
                {data.realized.realizedJpy >= 0 ? '+' : ''}{formatJpy(data.realized.realizedJpy)}
              </span>
            </div>
            <div className="realized-stats">
              <span className="realized-winrate">
                勝率 {((data.realized.wins / data.realized.sellCount) * 100).toFixed(0)}%
              </span>
              <span className="realized-wl">
                <span className="up">{data.realized.wins}勝</span>
                {' / '}
                <span className="down">{data.realized.losses}敗</span>
              </span>
            </div>
          </div>
          <div className="benchmark-note">
            売却ごとに「売却代金 − 平均取得原価」を確定した合計(手数料は現状ほぼ無料のため未計上)
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-title-row">
          <h2>📈 資産の軌跡</h2>
          <div className="range-picker">
            {[7, 30, 90, 365].map((d) => (
              <button
                key={d}
                className={`range-btn ${days === d ? 'active' : ''}`}
                onClick={() => setDays(d)}
              >
                {d >= 365 ? '1年' : `${d}日`}
              </button>
            ))}
          </div>
        </div>
        <AssetChart points={data.snapshots} />
      </section>

      <section className="card">
        <h2>🧺 保有資産(分散状況)</h2>
        <div className="holdings">
          <div className="holding">
            <div className="holding-name">JPY 💴</div>
            <div className="holding-value mono">{formatJpy(data.portfolio.jpyAvailable)}</div>
            <div className="holding-spark-cell" />
            <div className="share-bar">
              <div
                className="share-fill jpy"
                style={{
                  width: `${((data.portfolio.jpyAvailable / Math.max(1, data.portfolio.totalAssetsJpy)) * 100).toFixed(1)}%`,
                }}
              />
            </div>
            <div className="holding-share mono">
              {((data.portfolio.jpyAvailable / Math.max(1, data.portfolio.totalAssetsJpy)) * 100).toFixed(1)}%
            </div>
          </div>
          {data.portfolio.holdings.map((h) => (
            <div className="holding" key={h.currency}>
              <div className="holding-name">{h.currency.toUpperCase()} 🪙</div>
              <div className="holding-value mono">
                {formatJpy(h.jpyValue)} <span className="amount">({h.amount})</span>
              </div>
              <div className="holding-spark-cell"><Sparkline prices={sparkFor(h.currency)} /></div>
              <div className="share-bar">
                <div className="share-fill" style={{ width: `${Math.min(100, h.sharePct).toFixed(1)}%` }} />
              </div>
              <div className="holding-share mono">{h.sharePct.toFixed(1)}%</div>
            </div>
          ))}
          {data.portfolio.holdings.length === 0 && (
            <div className="muted">暗号資産の保有はまだありません(全額JPY)。</div>
          )}
        </div>
      </section>

      <section className="card">
        <h2>🏮 全銘柄の相場(Coincheck取引所 {data.tickers.length}ペア)</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>ペア</th>
                <th className="num">価格(円)</th>
                <th className="num">24h変化</th>
                <th className="num">24h売買代金(円)</th>
                <th>取引対象</th>
              </tr>
            </thead>
            <tbody>
              {sortedTickers.map((t) => {
                const change = t.price_change_percent_24h * 100;
                return (
                  <tr key={t.pair}>
                    <td className="pair">{t.pair.replace('_jpy', '').toUpperCase()}</td>
                    <td className="num mono">¥{formatPrice(t.last)}</td>
                    <td className={`num mono ${change > 0 ? 'up' : change < 0 ? 'down' : ''}`}>
                      {change > 0 ? '▲' : change < 0 ? '▼' : '−'} {Math.abs(change).toFixed(2)}%
                    </td>
                    <td className="num mono">{yen.format(Math.round(t.quote_volume))}</td>
                    <td>
                      {t.quote_volume >= liquidityFloor ? (
                        <span className="ok-chip">対象</span>
                      ) : (
                        <span className="ng-chip" title="板が薄いため自動売買の対象外">板薄</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>💱 売買イベント履歴</h2>
        <div className="event-feed">
          {eventsNewestFirst.length === 0 && (
            <div className="muted">
              まだイベントがありません。サイクルが回るとAIの判断と注文の記録がここに永久保存されます。
            </div>
          )}
          {eventsNewestFirst.map((ev, i) => (
            <EventItem event={ev} key={`${ev.t}-${i}`} />
          ))}
        </div>
      </section>

      <section className="two-col">
        <div className="card">
          <h2>🤖 神託の記録(botの直近48時間)</h2>
          <div className="log-feed">
            {logsNewestFirst.length === 0 && (
              <div className="muted">まだログがありません。サイクルが回ると判断の記録がここに並びます。</div>
            )}
            {logsNewestFirst.map((l, i) => (
              <div className="log-line" key={i}>
                <span className="log-time">
                  {new Date(l.t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="log-msg">{l.msg}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h2>🛡️ ガードレール(稼働中の設定)</h2>
          <div className="config-grid">
            {Object.entries(data.traderConfig).map(([k, v]) => (
              <div className="config-item" key={k}>
                <div className="config-key">{CONFIG_LABELS[k] ?? k}</div>
                <div className="config-value">
                  {k === 'GOAL_ASSETS_JPY' || k === 'MAX_ORDER_JPY_CAP' || k === 'MIN_LIQUIDITY_JPY'
                    ? formatBig(Number(v))
                    : v || '—'}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="card settings-card">
        <h2>⚙️ 設定</h2>
        {userEmail && (
          <div className="settings-row">
            <span className="settings-label">ログイン中</span>
            <span className="settings-user">{userEmail}</span>
          </div>
        )}
        <div className="danger-zone">
          <div className="danger-head">
            <span className="danger-title">⚠️ 危険な操作</span>
            <span className="danger-desc">
              資産推移・売買イベント・注文の全履歴を削除します。取引所の残高や設定には影響しません。元に戻せません。
            </span>
          </div>
          {resetState === 'idle' && (
            <button className="danger-btn" onClick={() => setResetState('confirming')}>
              🗑️ 履歴をリセット
            </button>
          )}
          {resetState === 'confirming' && (
            <div className="danger-confirm">
              <span>本当にすべての履歴を削除しますか?</span>
              <div className="danger-confirm-actions">
                <button className="danger-btn confirm" onClick={() => void resetHistory()}>
                  はい、削除する
                </button>
                <button className="ghost-btn" onClick={() => setResetState('idle')}>
                  キャンセル
                </button>
              </div>
            </div>
          )}
          {resetState === 'resetting' && <div className="danger-progress">削除中…</div>}
          {resetResult && <div className="danger-result">{resetResult}</div>}
        </div>
      </section>

      <footer className="footer">
        最終更新 {new Date(data.now).toLocaleTimeString('ja-JP')} ・ 60秒ごとに自動更新 ・
        暗号資産の取引には元本割れのリスクがあります
      </footer>
    </div>
  );
}
