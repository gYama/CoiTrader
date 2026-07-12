import { createHmac } from 'node:crypto';

const BASE_URL = 'https://coincheck.com';

/** /api/ticker/all が返す1ペア分の情報 */
export interface PairTicker {
  pair: string;
  last: number;
  bid: number;
  ask: number;
  high: number;
  low: number;
  volume: number;
  /** 24時間の売買代金(円) */
  quote_volume: number;
  /** 24時間の変化率 (例: -0.012 = -1.2%) */
  price_change_percent_24h: number;
  timestamp: number;
}

export interface Balance {
  success: boolean;
  jpy: string;
  btc: string;
  [key: string]: unknown;
}

export interface OrderResult {
  success: boolean;
  id?: number;
  error?: string;
  [key: string]: unknown;
}

/** /api/accounts が返す口座情報(手数料率は "0.0" のようなパーセント文字列) */
export interface AccountInfo {
  success: boolean;
  taker_fee?: string;
  maker_fee?: string;
  /** ペアごとの手数料率。キーは 'btc_jpy' など */
  exchange_fees?: Record<string, { taker_fee?: string; maker_fee?: string }>;
  [key: string]: unknown;
}

export class CoincheckClient {
  // 同一ミリ秒内の連続リクエストで nonce が重複しないよう単調増加させる
  private lastNonce = 0;
  // 認証付きリクエストを並列に投げると、後に生成した nonce のリクエストが
  // 先にサーバへ届いたとき "Nonce must be incremented" で拒否される。
  // これを防ぐため、認証付きリクエストは常に1件ずつ直列に実行する
  private privateChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
  ) {}

  private nonce(): string {
    const now = Date.now();
    this.lastNonce = now > this.lastNonce ? now : this.lastNonce + 1;
    return String(this.lastNonce);
  }

  private privateRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, string>,
  ): Promise<T> {
    const exec = () => this.sendPrivateRequest<T>(method, path, body);
    // 前のリクエストの成否に関わらず、完了を待ってから次を送る
    const result = this.privateChain.then(exec, exec);
    this.privateChain = result.catch(() => undefined);
    return result;
  }

  private async sendPrivateRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, string>,
  ): Promise<T> {
    const url = `${BASE_URL}${path}`;
    const payload = body ? JSON.stringify(body) : '';
    const nonce = this.nonce();
    // Coincheck の署名対象はホスト込みの完全URL (nonce + url + body)。
    // path だけで署名するとサーバ側の署名と一致せず invalid authentication になる
    const signature = createHmac('sha256', this.apiSecret)
      .update(nonce + url + payload)
      .digest('hex');

    const res = await fetch(url, {
      method,
      headers: {
        'ACCESS-KEY': this.apiKey,
        'ACCESS-NONCE': nonce,
        'ACCESS-SIGNATURE': signature,
        'Content-Type': 'application/json',
      },
      body: payload || undefined,
    });

    const json = (await res.json()) as T & { success?: boolean; error?: string };
    if (!res.ok || json.success === false) {
      throw new Error(`Coincheck API error (${method} ${path}): ${json.error ?? res.statusText}`);
    }
    return json;
  }

  private async publicRequest<T>(path: string): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`);
    if (!res.ok) {
      throw new Error(`Coincheck public API error (${path}): ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  // ---- 公開API ----

  /** 取引所で扱う全ペアのティッカーを1回で取得する */
  getAllTickers(): Promise<PairTicker[]> {
    return this.publicRequest<PairTicker[]>('/api/ticker/all');
  }

  /** 販売所(OTC)を含む全ペアのレートを1回で取得する */
  getAllRates(): Promise<Record<string, Record<string, string>>> {
    return this.publicRequest<Record<string, Record<string, string>>>('/api/rate/all');
  }

  // ---- 認証付きAPI ----

  /** 全通貨の残高。キーは通貨名 (jpy, btc, eth, ...) */
  getBalance(): Promise<Balance> {
    return this.privateRequest<Balance>('GET', '/api/accounts/balance');
  }

  /** 口座情報。ペアごとの取引手数料率(exchange_fees)を含む */
  getAccounts(): Promise<AccountInfo> {
    return this.privateRequest<AccountInfo>('GET', '/api/accounts');
  }

  getOpenOrders(): Promise<{ success: boolean; orders: unknown[] }> {
    return this.privateRequest('GET', '/api/exchange/orders/opens');
  }

  /** 成行買い。金額は日本円で指定する。 */
  marketBuy(pair: string, jpyAmount: number): Promise<OrderResult> {
    return this.privateRequest<OrderResult>('POST', '/api/exchange/orders', {
      pair,
      order_type: 'market_buy',
      market_buy_amount: jpyAmount.toFixed(0),
    });
  }

  /** 成行売り。数量は暗号資産の数量で指定する。 */
  marketSell(pair: string, coinAmount: number): Promise<OrderResult> {
    return this.privateRequest<OrderResult>('POST', '/api/exchange/orders', {
      pair,
      order_type: 'market_sell',
      amount: String(coinAmount),
    });
  }

  /** JPY出金履歴を取得する */
  getJpyWithdrawals(): Promise<WithdrawalsResult> {
    return this.privateRequest<WithdrawalsResult>('GET', '/api/withdraws');
  }

  /** JPYの入金履歴を取得する */
  getJpyDeposits(): Promise<DepositsResult> {
    return this.privateRequest<DepositsResult>('GET', '/api/deposit_money?currency=JPY');
  }

  /** 約定済み取引履歴を取得する(ページネーション付き) */
  getTransactionsPagination(): Promise<TransactionsResult> {
    return this.privateRequest<TransactionsResult>('GET', '/api/exchange/orders/transactions_pagination');
  }
}

export interface WithdrawalEntry {
  id: number;
  status: string;
  amount: string;
  currency: string;
  created_at: string;
  fee: string;
}

export interface WithdrawalsResult {
  success: boolean;
  data: WithdrawalEntry[];
}

export interface DepositEntry {
  id: number;
  amount: string;
  currency: string;
  status: string;
  created_at: string;
}

export interface DepositsResult {
  success: boolean;
  deposits: DepositEntry[];
}

export interface TransactionsResult {
  success: boolean;
  data: {
    id: number;
    funds: Record<string, string>;
    created_at: string;
    [key: string]: unknown;
  }[];
}
