import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { CoincheckClient } from '../trader/coincheck';
import { PUBLIC_CONFIG_KEYS } from '../shared/constants';
import { clearHistory, queryRecentEvents, queryRecentOrders, querySnapshots, setBreakerBaseline, type SnapshotPoint, type TradeEvent } from '../shared/history';
import { buildPortfolio } from '../shared/portfolio';
import { computeRealizedPnl } from '../trader/feedback';

const ssm = new SSMClient({});
const logs = new CloudWatchLogsClient({});
const lambda = new LambdaClient({});

// ログのうちダッシュボードに出す価値のある行だけ抜き出す
const LOG_KEYWORDS = [
  'goal progress',
  'gemini outlook',
  'proposed orders',
  '[DRY_RUN]',
  'order placed',
  'skip',
  'no trade',
  'cycle done',
  'trading is OFF',
  'failed',
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

/** 一部のデータ取得に失敗してもダッシュボード全体は表示できるようにする */
async function safe<T>(promise: Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    console.error(`${label} failed:`, err);
    return fallback;
  }
}

async function getTradingEnabled(): Promise<boolean> {
  const paramName = requireEnv('TRADING_ENABLED_PARAM');
  const res = await ssm.send(new GetParameterCommand({ Name: paramName }));
  return res.Parameter?.Value === 'true';
}

/**
 * DynamoDB から資産スナップショットを取得する(何年分でも15分粒度のまま残る)。
 * CloudWatch メトリクスと違い、解像度が時間とともに粗くなることがない。
 */
async function getAssetHistory(days: number): Promise<SnapshotPoint[]> {
  const now = Date.now();
  return querySnapshots(now - days * 86400_000, now);
}

/** DynamoDB から直近の売買イベントを取得する */
async function getRecentTradeEvents(limit: number): Promise<TradeEvent[]> {
  return queryRecentEvents(limit);
}

/** trader の直近ログから売買判断の履歴を抜き出す */
async function getRecentBotLogs(): Promise<{ t: number; msg: string }[]> {
  const logGroupName = requireEnv('TRADER_LOG_GROUP');
  const res = await logs.send(
    new FilterLogEventsCommand({
      logGroupName,
      startTime: Date.now() - 48 * 3600_000,
      limit: 1000,
    }),
  );
  return (res.events ?? [])
    .filter((e) => e.message && LOG_KEYWORDS.some((k) => e.message!.includes(k)))
    .map((e) => ({ t: e.timestamp ?? 0, msg: e.message!.trim() }))
    .slice(-200);
}

/** trader Lambda の環境変数から、公開してよい設定だけを読む(常に実際の稼働設定を映す) */
async function getTraderConfig(): Promise<Record<string, string>> {
  const res = await lambda.send(
    new GetFunctionConfigurationCommand({ FunctionName: requireEnv('TRADER_FUNCTION_NAME') }),
  );
  const env = res.Environment?.Variables ?? {};
  const config: Record<string, string> = {};
  for (const key of PUBLIC_CONFIG_KEYS) {
    if (env[key] !== undefined) config[key] = env[key];
  }
  return config;
}

/** Coincheck の出金履歴から JPY の入金/出金総額を集計する */
async function getDepositWithdrawSummary(
  coincheck: CoincheckClient,
  baseMs: number
): Promise<{ totalDepositsJpy: number; totalWithdrawalsJpy: number }> {
  try {
    const [withdrawals, deposits] = await Promise.all([
      coincheck.getJpyWithdrawals(),
      coincheck.getJpyDeposits(),
    ]);
    const totalWithdrawalsJpy = (withdrawals.data ?? [])
      .filter((w) => w.status === 'finished' && new Date(w.created_at).getTime() >= baseMs)
      .reduce((sum, w) => sum + Number(w.amount), 0);
    const totalDepositsJpy = (deposits.deposits ?? [])
      .filter((d) => d.status === 'confirmed' && new Date(d.created_at).getTime() >= baseMs)
      .reduce((sum, d) => sum + Number(d.amount), 0);
    return { totalDepositsJpy, totalWithdrawalsJpy };
  } catch (err) {
    console.error('failed to fetch deposit/withdraw summary:', err);
    return { totalDepositsJpy: 0, totalWithdrawalsJpy: 0 };
  }
}

async function handleStatus(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const days = Math.min(365, Math.max(1, Number(event.queryStringParameters?.days ?? 30)));
  const coincheck = new CoincheckClient(
    requireEnv('COINCHECK_API_KEY'),
    requireEnv('COINCHECK_API_SECRET'),
  );

  // 初回データからの変化率を計算するために全期間の最古スナップショットを1件だけ取得する
  const allTimeSnapshots = await safe(querySnapshots(0, Date.now()).then((pts) => pts.slice(0, 1)), [], 'inception snapshot');
  const baseMs = allTimeSnapshots.length > 0 ? allTimeSnapshots[0].t : 0;

  const [tickers, allRates, balance, tradingEnabled, snapshots, events, botLogs, traderConfig, depositWithdraw, pastOrders] = await Promise.all([
    coincheck.getAllTickers(),
    coincheck.getAllRates(),
    coincheck.getBalance(),
    safe(getTradingEnabled(), false, 'trading switch'),
    safe(getAssetHistory(days), [], 'asset snapshots'),
    safe(getRecentTradeEvents(100), [], 'trade events'),
    safe(getRecentBotLogs(), [], 'bot logs'),
    safe(getTraderConfig(), {}, 'trader config'),
    safe(getDepositWithdrawSummary(coincheck, baseMs), { totalDepositsJpy: 0, totalWithdrawalsJpy: 0 }, 'deposit/withdraw'),
    // 実現損益の計算用に実注文履歴(古い順)を取得する
    safe(queryRecentOrders().then((o) => o.reverse()), [], 'realized pnl orders'),
  ]);

  // 決済ごとの確定損益(平均取得原価法)。まだ売却が無ければ realizedJpy=0
  const realized = computeRealizedPnl(pastOrders);

  const portfolio = buildPortfolio(tickers, balance, allRates);
  const goalAssetsJpy = Number(process.env.GOAL_ASSETS_JPY ?? 1_300_000_000);

  // BTC買い持ちベンチマーク: 表示期間の最古スナップショット時点で全資産をBTCに換えて
  // 放置していたら今いくらか、を再構成して実績と比較する(このボットが価値を生んでいるか)。
  // btcPriceJpy を記録し始めた後のデータでのみ計算できる(それ以前は null)
  const currentBtcPrice = tickers.find((t) => t.pair === 'btc_jpy')?.last;
  const benchBase = snapshots.find((s) => s.btcPriceJpy && s.btcPriceJpy > 0);
  const benchmark =
    currentBtcPrice && benchBase?.btcPriceJpy && benchBase.totalAssetsJpy > 0
      ? {
          sinceDate: new Date(benchBase.t).toISOString(),
          btcHoldValueJpy: Math.round((benchBase.totalAssetsJpy / benchBase.btcPriceJpy) * currentBtcPrice),
          actualValueJpy: Math.round(portfolio.totalAssetsJpy),
          botReturnPct:
            ((portfolio.totalAssetsJpy - benchBase.totalAssetsJpy) / benchBase.totalAssetsJpy) * 100,
          btcReturnPct: ((currentBtcPrice - benchBase.btcPriceJpy) / benchBase.btcPriceJpy) * 100,
          // アルファ = 実績 − BTC買い持ち。プラスならボットがBTC放置に勝っている
          alphaJpy: Math.round(
            portfolio.totalAssetsJpy - (benchBase.totalAssetsJpy / benchBase.btcPriceJpy) * currentBtcPrice,
          ),
        }
      : null;

  // 初回データからの変化率を計算する
  const inception = allTimeSnapshots.length > 0
    ? {
        firstAssetsJpy: allTimeSnapshots[0].totalAssetsJpy,
        firstDate: new Date(allTimeSnapshots[0].t).toISOString(),
        changePct: allTimeSnapshots[0].totalAssetsJpy > 0
          ? ((portfolio.totalAssetsJpy - allTimeSnapshots[0].totalAssetsJpy) / allTimeSnapshots[0].totalAssetsJpy) * 100
          : 0,
        changeJpy: portfolio.totalAssetsJpy - allTimeSnapshots[0].totalAssetsJpy,
      }
    : null;

  return json(200, {
    now: Date.now(),
    tradingEnabled,
    portfolio,
    goal: {
      targetJpy: goalAssetsJpy,
      progressPct: (portfolio.totalAssetsJpy / goalAssetsJpy) * 100,
    },
    tickers,
    // DynamoDB 永久履歴(15分粒度のまま何年でも保持)
    snapshots,
    events,
    // CloudWatch Logs からの直近ログ(フォールバック・詳細デバッグ用)
    botLogs,
    traderConfig,
    // 初回からの変化率と入出金サマリー
    inception,
    depositWithdraw,
    // BTC買い持ちに対する優劣(アルファ)
    benchmark,
    // 決済ごとの確定損益(実現損益)と勝敗
    realized,
  });
}

async function handleToggle(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let enabled: unknown;
  try {
    enabled = JSON.parse(event.body ?? '{}').enabled;
  } catch {
    return json(400, { error: 'invalid JSON body' });
  }
  if (typeof enabled !== 'boolean') {
    return json(400, { error: 'body must be {"enabled": true|false}' });
  }
  const paramName = requireEnv('TRADING_ENABLED_PARAM');
  await ssm.send(
    new PutParameterCommand({
      Name: paramName,
      Value: enabled ? 'true' : 'false',
      Overwrite: true,
    }),
  );
  // 手動でONに戻したら、その時点をサーキットブレーカーの計測ベースラインにする。
  // これで「発動 → 手動再開 → 過去と同じ下落で即再発動」の無限ループを防ぐ
  // (再開後にさらに下落すれば、新しいベースラインから改めて発動しうる)。
  if (enabled) {
    await safe(setBreakerBaseline(Date.now()), undefined, 'set breaker baseline');
  }
  console.log(`trading switch set to ${enabled ? 'ON' : 'OFF'}`);
  return json(200, { tradingEnabled: enabled });
}

/**
 * 履歴データ(資産推移・売買イベント・注文)を全削除する。破壊的操作のため、
 * 誤操作防止に body で {"confirm":"RESET"} を要求する。認証(Cognito)必須。
 */
async function handleReset(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let confirm: unknown;
  try {
    confirm = JSON.parse(event.body ?? '{}').confirm;
  } catch {
    return json(400, { error: 'invalid JSON body' });
  }
  if (confirm !== 'RESET') {
    return json(400, { error: 'body must be {"confirm":"RESET"}' });
  }
  const deleted = await clearHistory();
  console.log(`history reset: ${deleted} items deleted`);
  return json(200, { deleted });
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  try {
    if (method === 'GET' && path.endsWith('/status')) return await handleStatus(event);
    if (method === 'POST' && path.endsWith('/trading')) return await handleToggle(event);
    if (method === 'POST' && path.endsWith('/reset')) return await handleReset(event);
    return json(404, { error: `no route for ${method} ${path}` });
  } catch (err) {
    console.error('control handler failed:', err);
    return json(500, { error: String(err) });
  }
};
