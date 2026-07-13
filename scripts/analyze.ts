import { existsSync, readFileSync } from 'node:fs';
import { queryRecentOrders, queryRecentEvents } from '../amplify/functions/shared/history';
import { computeRealizedPnl, computeCostBasis } from '../amplify/functions/trader/feedback';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

async function main() {
  const orders = await queryRecentOrders(100);
  // orders は新しい順なので、feedback用の関数には古い順(reverse)にして渡す
  const ordersOldestFirst = [...orders].reverse();
  
  const pnl = computeRealizedPnl(ordersOldestFirst);
  console.log('--- 確定損益 ---');
  console.log(JSON.stringify(pnl, null, 2));

  const costBasis = computeCostBasis(ordersOldestFirst);
  console.log('\n--- 取得単価 ---');
  for (const [currency, basis] of costBasis.entries()) {
    console.log(`${currency}: amount=${basis.amount.toFixed(8)}, avgPrice=${basis.avgPrice.toFixed(4)}`);
  }

  const events = await queryRecentEvents(20);
  console.log('\n--- 直近のイベント (最新20件) ---');
  for (const e of events) {
    const date = new Date(e.t).toLocaleString();
    if (e.type === 'decision') {
      console.log(`[${date}] DECISION: outlook=${e.outlook}`);
      if (e.proposedOrders && e.proposedOrders.length > 0) {
        console.log(`  Proposals: ${JSON.stringify(e.proposedOrders)}`);
      }
    } else if (e.type === 'order') {
      console.log(`[${date}] ORDER: ${e.action} ${e.pair} (dryRun=${e.dryRun}) price=${e.price} reason=${e.reason}`);
    } else if (e.type === 'skip') {
      console.log(`[${date}] SKIP: ${e.action} ${e.pair} reason=${e.reason}`);
    }
  }
}

main().catch(console.error);
