import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { queryRecentOrders, queryRecentEvents, querySnapshots } from '../amplify/functions/shared/history';
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
  const reportDir = path.join(process.cwd(), 'report');
  if (!existsSync(reportDir)) {
    mkdirSync(reportDir);
  }

  console.log('Fetching historical data from DynamoDB...');

  // 1. 注文履歴
  const orders = await queryRecentOrders(500);
  const ordersOldestFirst = [...orders].reverse();
  const pnl = computeRealizedPnl(ordersOldestFirst);
  const costBasis = computeCostBasis(ordersOldestFirst);

  const pnlReportPath = path.join(reportDir, 'pnl_analysis.json');
  writeFileSync(pnlReportPath, JSON.stringify({
    realizedPnl: pnl,
    costBasis: Array.from(costBasis.entries()).map(([currency, basis]) => ({
      currency,
      amount: basis.amount,
      avgPrice: basis.avgPrice
    }))
  }, null, 2));
  console.log(`Exported PnL analysis to ${pnlReportPath}`);

  const tradeHistoryPath = path.join(reportDir, 'trade_history.json');
  writeFileSync(tradeHistoryPath, JSON.stringify(ordersOldestFirst, null, 2));
  console.log(`Exported Trade History to ${tradeHistoryPath}`);

  // 2. イベント履歴 (AIの判断、Skipなど)
  const events = await queryRecentEvents(1000); // 直近1000件
  const decisions = events.filter(e => e.type === 'decision');
  const skips = events.filter(e => e.type === 'skip');
  
  const eventsReportPath = path.join(reportDir, 'events_history.json');
  writeFileSync(eventsReportPath, JSON.stringify({
    decisions,
    skips,
    allEvents: events
  }, null, 2));
  console.log(`Exported Events (Decisions/Skips) to ${eventsReportPath}`);

  // 3. スナップショット履歴 (相場環境)
  const nowMs = Date.now();
  // 過去7日間分のスナップショットを取得
  const snapshots = await querySnapshots(nowMs - 7 * 24 * 3600_000, nowMs);
  
  const snapshotsReportPath = path.join(reportDir, 'snapshots_history.json');
  writeFileSync(snapshotsReportPath, JSON.stringify(snapshots, null, 2));
  console.log(`Exported Snapshots to ${snapshotsReportPath}`);

  console.log('All historical data has been successfully exported to the report directory.');
}

main().catch(console.error);
