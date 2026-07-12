import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Portfolio } from './portfolio';

/**
 * 資産推移と売買イベントの永久記録 (DynamoDB)。
 * - pk='SNAPSHOT': 15分ごとの総資産・現金・保有内訳。CloudWatchメトリクスと違い
 *   何年経っても15分粒度のまま残る(コインチェックアプリでは見られない細かさ)
 * - pk='EVENT'  : Gemini の判断と注文の記録
 * 書き込み失敗は売買サイクルを止めない(ログに残して続行)。
 */

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export interface SnapshotPoint {
  t: number;
  totalAssetsJpy: number;
  jpyAvailable: number;
  holdings?: Portfolio['holdings'];
  /** そのサイクル時点の BTC 価格(円)。BTC買い持ちベンチマークの基準に使う */
  btcPriceJpy?: number;
  /** 全ペアの価格記録。時系列データを Gemini に渡すために使用 */
  prices?: Record<string, number>;
}

export interface TradeEvent {
  t: number;
  /** decision=AI判断, order=注文, skip=提案されたがガードレールで見送った注文 */
  type: 'decision' | 'order' | 'skip';
  dryRun: boolean;
  /** type=decision */
  outlook?: string;
  proposedOrders?: unknown[];
  /** type=order */
  pair?: string;
  action?: 'buy' | 'sell' | 'sell_all' | 'sell_half';
  sizeJpy?: number;
  sizeCoin?: number;
  /** 執行時の参考価格(ticker.last)。取得単価の復元に使う */
  price?: number;
  reason?: string;
  orderId?: number;
}

function tableName(): string | undefined {
  return process.env.HISTORY_TABLE;
}

// サーキットブレーカーのドローダウン計測ベースライン(pk='CONFIG')。
// 手動で自動売買をONに戻した時刻を記録し、以降はその時点からドローダウンを計測し直す。
// これにより「発動→手動再開→同じ下落で即再発動」の無限ループを防ぐ。
const CONFIG_PK = 'CONFIG';
const BREAKER_BASELINE_SK = 'breaker-baseline';

/** サーキットブレーカーの計測ベースライン時刻(ms)。未設定なら undefined */
export async function getBreakerBaseline(): Promise<number | undefined> {
  const table = tableName();
  if (!table) return undefined;
  try {
    const res = await doc.send(
      new GetCommand({ TableName: table, Key: { pk: CONFIG_PK, sk: BREAKER_BASELINE_SK } }),
    );
    const ts = res.Item?.ts;
    return typeof ts === 'number' ? ts : undefined;
  } catch (err) {
    console.error('failed to read breaker baseline:', err);
    return undefined;
  }
}

/** サーキットブレーカーの計測ベースライン時刻を記録する(手動ON時などに呼ぶ) */
export async function setBreakerBaseline(ts: number): Promise<void> {
  const table = tableName();
  if (!table) return;
  try {
    await doc.send(
      new PutCommand({ TableName: table, Item: { pk: CONFIG_PK, sk: BREAKER_BASELINE_SK, ts } }),
    );
  } catch (err) {
    console.error('failed to set breaker baseline:', err);
  }
}

export async function saveSnapshot(portfolio: Portfolio, btcPriceJpy?: number, prices?: Record<string, number>): Promise<void> {
  const table = tableName();
  if (!table) {
    console.log('HISTORY_TABLE not set — skipping snapshot save');
    return;
  }
  try {
    await doc.send(
      new PutCommand({
        TableName: table,
        // btcPriceJpy/prices が undefined の場合は removeUndefinedValues で自動的に省かれる
        Item: {
          pk: 'SNAPSHOT',
          sk: new Date().toISOString(),
          totalAssetsJpy: Math.round(portfolio.totalAssetsJpy),
          jpyAvailable: Math.round(portfolio.jpyAvailable),
          btcPriceJpy: btcPriceJpy ? Math.round(btcPriceJpy) : undefined,
          prices,
          holdings: portfolio.holdings.map((h) => ({
            currency: h.currency,
            amount: h.amount,
            jpyValue: Math.round(h.jpyValue),
            sharePct: Math.round(h.sharePct * 100) / 100,
          })),
        },
      }),
    );
  } catch (err) {
    console.error('failed to save snapshot:', err);
  }
}

export async function saveEvent(event: Omit<TradeEvent, 't'>): Promise<void> {
  const table = tableName();
  if (!table) {
    console.log('HISTORY_TABLE not set — skipping event save');
    return;
  }
  try {
    // 同一ミリ秒の衝突を避けるためランダムサフィックスを付ける
    const sk = `${new Date().toISOString()}#${Math.random().toString(36).slice(2, 6)}`;
    await doc.send(
      new PutCommand({
        TableName: table,
        Item: { pk: 'EVENT', sk, ...event },
      }),
    );
    // 実注文は取得単価の復元用に別パーティションへも複製する。
    // EVENT は15分ごとの判断ログで埋まるため、まばらな実注文だけを効率よく遡れるようにする
    if (event.type === 'order' && !event.dryRun) {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: { pk: 'ORDER', sk, ...event },
        }),
      );
    }
  } catch (err) {
    console.error('failed to save event:', err);
  }
}

/** 期間内のスナップショットを古い順に全件取得する(グラフ用に総資産と現金だけ絞り込み) */
export async function querySnapshots(fromMs: number, toMs: number): Promise<SnapshotPoint[]> {
  const table = tableName();
  if (!table) return [];
  const points: SnapshotPoint[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': 'SNAPSHOT',
          ':from': new Date(fromMs).toISOString(),
          ':to': new Date(toMs).toISOString(),
        },
        ProjectionExpression: 'sk, totalAssetsJpy, jpyAvailable, holdings, btcPriceJpy, prices',
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of res.Items ?? []) {
      points.push({
        t: Date.parse(item.sk as string),
        totalAssetsJpy: item.totalAssetsJpy as number,
        jpyAvailable: item.jpyAvailable as number,
        holdings: item.holdings as Portfolio['holdings'] | undefined,
        btcPriceJpy: item.btcPriceJpy as number | undefined,
        prices: item.prices as Record<string, number> | undefined,
      });
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return points;
}

/** 直近の実注文(dry-run でないもののみ複製保存されている)を新しい順に取得する。limit未指定なら全件取得 */
export async function queryRecentOrders(limit?: number): Promise<TradeEvent[]> {
  const table = tableName();
  if (!table) return [];
  const orders: TradeEvent[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': 'ORDER' },
        ScanIndexForward: false,
        ExclusiveStartKey: lastKey,
        Limit: limit && limit > 0 ? Math.min(limit - orders.length, 100) : undefined,
      }),
    );
    for (const item of res.Items ?? []) {
      orders.push({
        ...(item as unknown as TradeEvent),
        t: Date.parse((item.sk as string).split('#')[0]),
      });
      if (limit && orders.length >= limit) {
        break;
      }
    }
    if (limit && orders.length >= limit) {
      break;
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return orders;
}

/** 直近のイベントを新しい順に取得する */
export async function queryRecentEvents(limit: number): Promise<TradeEvent[]> {
  const table = tableName();
  if (!table) return [];
  const res = await doc.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'EVENT' },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (res.Items ?? []).map((item) => ({
    ...(item as unknown as TradeEvent),
    t: Date.parse((item.sk as string).split('#')[0]),
  }));
}

/**
 * 履歴テーブル(スナップショット・イベント・注文)の全アイテムを削除する。
 * テーブル名は HISTORY_TABLE 環境変数から解決するため、どの環境でも動く(OSS向けに汎用化)。
 * スキーマ(pk/sk のキー名)に依存せず、Scan で取得したキー属性をそのまま削除に使う。
 * 削除した件数を返す。
 */
export async function clearHistory(): Promise<number> {
  const table = tableName();
  if (!table) throw new Error('HISTORY_TABLE 環境変数が設定されていません');

  // テーブルのキースキーマ(pk/sk の実際の属性名)を取得する。ハードコードしない
  const desc = await new DynamoDBClient({}).send(new DescribeTableCommand({ TableName: table }));
  const keyNames = (desc.Table?.KeySchema ?? []).map((k) => k.AttributeName!);
  if (keyNames.length === 0) throw new Error(`テーブル ${table} のキースキーマを取得できませんでした`);

  let deleted = 0;
  let lastKey: Record<string, unknown> | undefined;
  do {
    const scan = await doc.send(
      new ScanCommand({
        TableName: table,
        // キー属性だけ取得すれば削除には十分(転送量を抑える)
        ProjectionExpression: keyNames.map((_, i) => `#k${i}`).join(', '),
        ExpressionAttributeNames: Object.fromEntries(keyNames.map((n, i) => [`#k${i}`, n])),
        ExclusiveStartKey: lastKey,
      }),
    );
    const items = scan.Items ?? [];
    // BatchWrite は1回あたり最大25件
    for (let i = 0; i < items.length; i += 25) {
      const chunk = items.slice(i, i + 25);
      await doc.send(
        new BatchWriteCommand({
          RequestItems: {
            [table]: chunk.map((item) => ({
              DeleteRequest: { Key: Object.fromEntries(keyNames.map((n) => [n, item[n]])) },
            })),
          },
        }),
      );
      deleted += chunk.length;
    }
    lastKey = scan.LastEvaluatedKey;
  } while (lastKey);

  console.log(`clearHistory: deleted ${deleted} items from ${table}`);
  return deleted;
}
