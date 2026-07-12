import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndicators,
  rangePositionPct,
  returnsVolatilityPct,
  rsi,
  smaDeviationPct,
} from '../amplify/functions/trader/indicators';

test('rsi: 上昇のみなら100、下落のみなら0、データ不足はundefined', () => {
  const up = Array.from({ length: 15 }, (_, i) => 100 + i);
  const down = Array.from({ length: 15 }, (_, i) => 100 - i);
  assert.equal(rsi(up), 100);
  assert.equal(rsi(down), 0);
  assert.equal(rsi([1, 2, 3]), undefined); // period+1=15点未満
});

test('rsi: 混合の値動きで0〜100の中間値になり、無変動は中立50', () => {
  // 上昇7・下落7を交互に(値幅は上昇2:下落1) → RSI = 14/(14+7)*100 = 66.7
  const prices = [100];
  for (let i = 0; i < 7; i += 1) {
    prices.push(prices[prices.length - 1] + 2);
    prices.push(prices[prices.length - 1] - 1);
  }
  const value = rsi(prices)!;
  assert.ok(value > 60 && value < 75, `expected ~66.7, got ${value}`);
  assert.equal(rsi(Array(20).fill(500)), 50);
});

test('smaDeviationPct: 直近価格の移動平均からの乖離率', () => {
  // 直近6点 [100,100,100,100,100,112] → SMA=102, 乖離 = (112-102)/102 ≒ +9.8%
  const prices = [90, 95, 100, 100, 100, 100, 100, 112];
  const dev = smaDeviationPct(prices, 6)!;
  assert.ok(Math.abs(dev - 9.8) < 0.1, `expected ~9.8, got ${dev}`);
  assert.equal(smaDeviationPct([1, 2], 6), undefined);
});

test('returnsVolatilityPct: 無変動は0、変動があれば正の値', () => {
  assert.equal(returnsVolatilityPct([100, 100, 100, 100]), 0);
  const vol = returnsVolatilityPct([100, 105, 95, 108, 92])!;
  assert.ok(vol > 0);
  assert.equal(returnsVolatilityPct([100, 105]), undefined); // リターン1点では算出不能
});

test('rangePositionPct: レンジ内の現在位置(0=安値, 100=高値)', () => {
  assert.equal(rangePositionPct([100, 200, 150]), 50);
  assert.equal(rangePositionPct([100, 200, 200]), 100);
  assert.equal(rangePositionPct([200, 100, 100]), 0);
  assert.equal(rangePositionPct([100, 100, 100]), 50); // レンジ幅0は中立
  assert.equal(rangePositionPct([100]), undefined);
});

test('buildIndicators: 十分なデータで全指標が埋まり、データ皆無ならundefined', () => {
  const hourly = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 5);
  const sixHourly = Array.from({ length: 29 }, (_, i) => 100 + Math.cos(i) * 10);
  const ind = buildIndicators(hourly, sixHourly)!;
  assert.ok(ind.rsi14 !== undefined);
  assert.ok(ind.ma6hDevPct !== undefined);
  assert.ok(ind.vol24hPct !== undefined);
  assert.ok(ind.range7dPosPct !== undefined);
  assert.equal(buildIndicators([], []), undefined);
});

test('buildIndicators: 一部のデータだけでも計算できる指標は返す', () => {
  // 7日系列だけある場合(記録開始直後の24hデータ不足を想定)
  const ind = buildIndicators([], [100, 120, 110])!;
  assert.equal(ind.rsi14, undefined);
  assert.equal(ind.range7dPosPct, 50);
});
