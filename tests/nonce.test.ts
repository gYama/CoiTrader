import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoincheckClient } from '../amplify/functions/trader/coincheck';

/**
 * 認証付きリクエストは常に直列で実行され、nonce が単調増加することを保証する。
 * (並列に投げると後発の小さい nonce が先に届き "Nonce must be incremented" で弾かれるため)
 */
test('認証付きリクエストは直列化され nonce が単調増加する', async () => {
  const arrivals: number[] = [];
  let inFlight = 0;
  let maxConcurrency = 0;

  (globalThis as unknown as { fetch: unknown }).fetch = async (
    _url: string,
    init?: { headers?: Record<string, string> },
  ) => {
    inFlight++;
    maxConcurrency = Math.max(maxConcurrency, inFlight);
    arrivals.push(Number(init?.headers?.['ACCESS-NONCE'] ?? 0));
    await new Promise((r) => setTimeout(r, Math.random() * 20));
    inFlight--;
    return { ok: true, json: async () => ({ success: true }) };
  };

  const client = new CoincheckClient('key', 'secret');
  await Promise.all([client.getBalance(), client.getAccounts(), client.getOpenOrders()]);

  assert.equal(maxConcurrency, 1, '同時実行は常に1件');
  assert.equal(arrivals.length, 3);
  for (let i = 1; i < arrivals.length; i++) {
    assert.ok(arrivals[i] > arrivals[i - 1], `nonce は単調増加 (位置${i})`);
  }
});

test('1件が失敗しても直列チェーンは切れず後続が実行される', async () => {
  (globalThis as unknown as { fetch: unknown }).fetch = async () => ({
    ok: false,
    statusText: 'Bad Request',
    json: async () => ({ success: false, error: 'boom' }),
  });
  const client = new CoincheckClient('key', 'secret');
  const errMsg = await client.getBalance().catch((e: Error) => e.message);
  assert.match(String(errMsg), /boom/);

  let ran = false;
  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    ran = true;
    return { ok: true, json: async () => ({ success: true }) };
  };
  await client.getBalance();
  assert.ok(ran, '失敗後も後続リクエストが実行される');
});
