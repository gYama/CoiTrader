import { fetchAuthSession } from 'aws-amplify/auth';
import outputsJson from '../amplify_outputs.json';

export interface Holding {
  currency: string;
  amount: number;
  jpyValue: number;
  sharePct: number;
}

export interface Ticker {
  pair: string;
  last: number;
  high: number;
  low: number;
  volume: number;
  quote_volume: number;
  price_change_percent_24h: number;
}

export interface SnapshotPoint {
  t: number;
  totalAssetsJpy: number;
  jpyAvailable: number;
  holdings?: { currency: string; amount: number; jpyValue: number; sharePct: number }[];
  /** そのサイクル時点の全ペア価格(円)。保有銘柄のスパークライン描画に使う */
  prices?: Record<string, number>;
}

export interface TradeEvent {
  t: number;
  /** decision=AI判断, order=注文, skip=提案されたがガードレールで見送った注文 */
  type: 'decision' | 'order' | 'skip';
  dryRun: boolean;
  outlook?: string;
  proposedOrders?: unknown[];
  pair?: string;
  action?: 'buy' | 'sell' | 'sell_all' | 'sell_half';
  sizeJpy?: number;
  sizeCoin?: number;
  /** 執行時の参考価格(ticker.last) */
  price?: number;
  reason?: string;
  orderId?: number;
}

export interface StatusData {
  now: number;
  tradingEnabled: boolean;
  portfolio: {
    jpyAvailable: number;
    totalAssetsJpy: number;
    holdings: Holding[];
  };
  goal: { targetJpy: number; progressPct: number };
  tickers: Ticker[];
  /** DynamoDB 永久履歴: 15分粒度のスナップショット */
  snapshots: SnapshotPoint[];
  /** DynamoDB 永久履歴: 売買イベント */
  events: TradeEvent[];
  /** CloudWatch Logs からの直近ログ(フォールバック) */
  botLogs: { t: number; msg: string }[];
  traderConfig: Record<string, string>;
  /** 初回データからの変化率 */
  inception?: {
    firstAssetsJpy: number;
    firstDate: string;
    changePct: number;
    changeJpy: number;
  };
  /** 入出金サマリー */
  depositWithdraw?: {
    totalDepositsJpy: number;
    totalWithdrawalsJpy: number;
  };
  /** BTC買い持ちベンチマークとの比較(記録開始後のデータがある場合のみ) */
  benchmark?: {
    sinceDate: string;
    btcHoldValueJpy: number;
    actualValueJpy: number;
    botReturnPct: number;
    btcReturnPct: number;
    alphaJpy: number;
  } | null;
  /** 決済ごとの確定損益(実現損益)と勝敗 */
  realized?: {
    realizedJpy: number;
    wins: number;
    losses: number;
    sellCount: number;
  };
}

export interface Api {
  getStatus(days: number): Promise<StatusData>;
  setTrading(enabled: boolean): Promise<boolean>;
  /** 履歴データ(資産推移・売買イベント・注文)を全削除する。削除件数を返す */
  resetHistory(): Promise<number>;
}

const outputs = outputsJson as { custom?: { controlApiUrl?: string } };

function apiBase(): string {
  const url = outputs.custom?.controlApiUrl;
  if (!url) {
    throw new Error(
      'amplify_outputs.json に controlApiUrl がありません。npx ampx sandbox を実行してください。',
    );
  }
  return url;
}

async function authHeader(): Promise<Record<string, string>> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new Error('ログインセッションが見つかりません');
  return { Authorization: token };
}

export const realApi: Api = {
  async getStatus(days: number): Promise<StatusData> {
    const res = await fetch(`${apiBase()}/status?days=${days}`, {
      headers: await authHeader(),
    });
    if (!res.ok) throw new Error(`status API error: ${res.status} ${await res.text()}`);
    return (await res.json()) as StatusData;
  },

  async setTrading(enabled: boolean): Promise<boolean> {
    const res = await fetch(`${apiBase()}/trading`, {
      method: 'POST',
      headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error(`trading API error: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { tradingEnabled: boolean }).tradingEnabled;
  },

  async resetHistory(): Promise<number> {
    const res = await fetch(`${apiBase()}/reset`, {
      method: 'POST',
      headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'RESET' }),
    });
    if (!res.ok) throw new Error(`reset API error: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { deleted: number }).deleted;
  },
};
