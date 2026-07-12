import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCostBasis, computeRealizedPnl, buildPerformance, computeDrawdownPct } from '../amplify/functions/trader/feedback';
import { getPriceHistory } from '../amplify/functions/trader/handler';
import type { TradeEvent, SnapshotPoint } from '../amplify/functions/shared/history';

test('加重平均取得単価を実注文履歴から復元する', () => {
  const events: TradeEvent[] = [
    { t: 1, type: 'order', dryRun: false, pair: 'doge_jpy', action: 'buy', sizeJpy: 1000, price: 10 },
    { t: 2, type: 'order', dryRun: false, pair: 'doge_jpy', action: 'buy', sizeJpy: 2000, price: 20 },
    { t: 3, type: 'order', dryRun: false, pair: 'doge_jpy', action: 'sell', sizeCoin: 50, price: 25 },
  ];
  const doge = computeCostBasis(events).get('doge');
  assert.ok(doge);
  // 100コイン@10 + 100コイン@20 = 200コイン/3000円 → 平均15円。50売却で150コイン残、平均は不変
  assert.equal(doge.amount, 150);
  assert.equal(doge.avgPrice, 15);
});

test('dry-run・価格欠損・decision イベントは無視する', () => {
  const events: TradeEvent[] = [
    { t: 1, type: 'order', dryRun: false, pair: 'eth_jpy', action: 'buy', sizeJpy: 1000, price: 100 },
    { t: 2, type: 'order', dryRun: true, pair: 'eth_jpy', action: 'buy', sizeJpy: 99999, price: 1 },
    { t: 3, type: 'order', dryRun: false, pair: 'eth_jpy', action: 'buy', sizeJpy: 500 }, // price欠損
    { t: 4, type: 'decision', dryRun: false },
  ];
  const eth = computeCostBasis(events).get('eth');
  assert.ok(eth);
  // 有効な買いは1件のみ: 10コイン@100
  assert.equal(eth.amount, 10);
  assert.equal(eth.avgPrice, 100);
});

test('全量売却で平均取得単価がリセットされる', () => {
  const events: TradeEvent[] = [
    { t: 1, type: 'order', dryRun: false, pair: 'shib_jpy', action: 'buy', sizeJpy: 100, price: 0.001 },
    { t: 2, type: 'order', dryRun: false, pair: 'shib_jpy', action: 'sell', sizeCoin: 100000, price: 0.0008 },
  ];
  const shib = computeCostBasis(events).get('shib');
  assert.ok(shib);
  assert.equal(shib.amount, 0);
  assert.equal(shib.avgPrice, 0);
});

test('確定損益を平均取得原価法で計算する(利益・損失・勝敗)', () => {
  const events: TradeEvent[] = [
    // doge を平均15円で200コイン取得
    { t: 1, type: 'order', dryRun: false, pair: 'doge_jpy', action: 'buy', sizeJpy: 1000, price: 10 },
    { t: 2, type: 'order', dryRun: false, pair: 'doge_jpy', action: 'buy', sizeJpy: 2000, price: 20 },
    // 100コインを25円(2500円)で売却 → 原価1500円 → +1000円(勝ち)
    { t: 3, type: 'order', dryRun: false, pair: 'doge_jpy', action: 'sell', sizeCoin: 100, sizeJpy: 2500, price: 25 },
    // 残り100コインを12円(1200円)で売却 → 原価1500円 → -300円(負け)
    { t: 4, type: 'order', dryRun: false, pair: 'doge_jpy', action: 'sell', sizeCoin: 100, sizeJpy: 1200, price: 12 },
  ];
  const r = computeRealizedPnl(events);
  assert.equal(r.realizedJpy, 700); // +1000 - 300
  assert.equal(r.wins, 1);
  assert.equal(r.losses, 1);
  assert.equal(r.sellCount, 2);
});

test('原価が復元できない売却(履歴外の保有)は損益計上しない', () => {
  const events: TradeEvent[] = [
    // 買い履歴なしでいきなり売却(ボット導入前からの保有)
    { t: 1, type: 'order', dryRun: false, pair: 'shib_jpy', action: 'sell', sizeCoin: 1000, sizeJpy: 800, price: 0.0008 },
  ];
  const r = computeRealizedPnl(events);
  assert.equal(r.realizedJpy, 0);
  assert.equal(r.sellCount, 0);
});

test('ストップロスの発動境界(取得単価比の下落率)', () => {
  const avg = 15;
  const trigger = ((avg - 13.4) / avg) * 100; // 10.67%
  const noTrigger = ((avg - 13.6) / avg) * 100; // 9.33%
  assert.ok(trigger >= 10, '10%閾値を超えたら発動');
  assert.ok(noTrigger < 10, '10%閾値未満なら発動しない');
});

test('getPriceHistory による価格時系列の間引きサンプリング', () => {
  const now = Date.now();
  const snapshots: SnapshotPoint[] = [
    { t: now - 3 * 3600_000, totalAssetsJpy: 100, jpyAvailable: 100, prices: { 'btc_jpy': 1000 } },
    { t: now - 2 * 3600_000, totalAssetsJpy: 100, jpyAvailable: 100, prices: { 'btc_jpy': 1100 } },
    { t: now - 1 * 3600_000, totalAssetsJpy: 100, jpyAvailable: 100, prices: { 'btc_jpy': 1200 } },
    { t: now, totalAssetsJpy: 100, jpyAvailable: 100, prices: { 'btc_jpy': 1300 } },
  ];

  // 過去3時間について、1時間おきの価格履歴を取得する
  const history = getPriceHistory(snapshots, 'btc_jpy', 3, 1);
  assert.equal(history.length, 4);
  assert.equal(history[0], 1000);
  assert.equal(history[1], 1100);
  assert.equal(history[2], 1200);
  assert.equal(history[3], 1300);
});

test('getPriceHistory は最新価格を必ず含み、正時からずれた記録でも決定的', () => {
  const now = Date.now();
  // 実行時刻の「分」に依存しないことを確かめるため、13分ずれた時刻に記録する
  const off = 13 * 60_000;
  const snapshots: SnapshotPoint[] = [
    { t: now - 3 * 3600_000 + off, totalAssetsJpy: 100, jpyAvailable: 100, prices: { 'eth_jpy': 500000 } },
    { t: now - 2 * 3600_000 + off, totalAssetsJpy: 100, jpyAvailable: 100, prices: { 'eth_jpy': 510000 } },
    { t: now - 1 * 3600_000 + off, totalAssetsJpy: 100, jpyAvailable: 100, prices: { 'eth_jpy': 520000 } },
    { t: now - 2 * 60_000, totalAssetsJpy: 100, jpyAvailable: 100, prices: { 'eth_jpy': 531234 } },
  ];
  const history = getPriceHistory(snapshots, 'eth_jpy', 3, 1);
  // 最新スナップショット(現在価格)が必ず末尾に入る
  assert.equal(history[history.length - 1], 531230); // 531234 を有効数字5桁に丸め
  // 同じスナップショットは重複採用されない(点数は候補数以下)
  assert.ok(history.length <= snapshots.length);
});

test('getPriceHistory は対象期間外・価格欠損を除外する', () => {
  const now = Date.now();
  const snapshots: SnapshotPoint[] = [
    { t: now - 30 * 3600_000, totalAssetsJpy: 100, jpyAvailable: 100, prices: { 'btc_jpy': 900 } }, // 期間外(24h超)
    { t: now - 5 * 3600_000, totalAssetsJpy: 100, jpyAvailable: 100, prices: { 'xrp_jpy': 80 } }, // btc価格なし
    { t: now - 1 * 3600_000, totalAssetsJpy: 100, jpyAvailable: 100, prices: { 'btc_jpy': 1000 } },
  ];
  const history = getPriceHistory(snapshots, 'btc_jpy', 24, 1);
  assert.ok(history.every((p) => p === 1000));
  assert.ok(history.length >= 1);
});

test('buildPerformance による実績変化率の算出', () => {
  const now = Date.now();
  const snapshots: SnapshotPoint[] = [
    { t: now - 25 * 3600_000, totalAssetsJpy: 10000, jpyAvailable: 10000 },
    { t: now - 24 * 3600_000, totalAssetsJpy: 10000, jpyAvailable: 10000 }, // これが 24時間前の基準になるはず
    { t: now - 12 * 3600_000, totalAssetsJpy: 11000, jpyAvailable: 11000 },
  ];

  const perf = buildPerformance(12000, snapshots);
  // 基準: 10000 → 現在: 12000 => +20.00%
  assert.equal(perf.change24hPct, 20);
  // 最古のデータが 25時間前で 10000 => 7日変化率は最古を基準とするので +20.00%
  assert.equal(perf.change7dPct, 20);
});

test('computeDrawdownPct: 出金による見かけの資産減少では発動しない', () => {
  const now = Date.now();
  const floorMs = now - 24 * 3600_000;
  const snapshots: SnapshotPoint[] = [
    { t: now - 24 * 3600_000, totalAssetsJpy: 10000, jpyAvailable: 5000 },
  ];
  // 総資産は 10000 → 8500(-15%)。だが 2000 出金しているので純入出金 netFlow = -2000。
  // 調整後の運用成績: (8500 - (-2000)) = 10500 → 基準10000比で +5% なので発動しない
  const adjusted = computeDrawdownPct(8500, snapshots, floorMs, -2000);
  assert.ok(adjusted !== undefined && adjusted > 0, `出金調整後はプラスのはず: ${adjusted}`);
  // 調整しない(netFlow=0)場合は -15% で発動域
  const raw = computeDrawdownPct(8500, snapshots, floorMs, 0);
  assert.ok(raw !== undefined && raw <= -10, `生ドローダウンは -10% 以下のはず: ${raw}`);
});

test('computeDrawdownPct: ベースライン以降のみを基準にする(手動再開後の再計測)', () => {
  const now = Date.now();
  const snapshots: SnapshotPoint[] = [
    { t: now - 20 * 3600_000, totalAssetsJpy: 10000, jpyAvailable: 5000 }, // 発動前の高値
    { t: now - 2 * 3600_000, totalAssetsJpy: 8000, jpyAvailable: 4000 }, // 手動再開時点(下落済み)
  ];
  // 手動再開を1.9時間前にした => その時点(8000)を基準に計測。現在 7960 なら -0.5% で発動しない
  const reEnabledMs = now - 1.9 * 3600_000;
  const afterReEnable = computeDrawdownPct(7960, snapshots, reEnabledMs, 0);
  assert.ok(afterReEnable !== undefined && afterReEnable > -1, `再開後基準では小幅: ${afterReEnable}`);
  // ベースラインを24h前まで遡ると 10000 基準で -20% と誤って発動してしまう(=旧挙動)
  const fromOld = computeDrawdownPct(7960, snapshots, now - 24 * 3600_000, 0);
  assert.ok(fromOld !== undefined && fromOld <= -10, `古い基準だと発動域: ${fromOld}`);
});
