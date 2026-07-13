import { CoincheckClient } from '../amplify/functions/trader/coincheck';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const coincheck = new CoincheckClient('DUMMY', 'DUMMY');
  
  console.log('Fetching all tickers from Coincheck...');
  const allTickers = await coincheck.getAllTickers();
  
  const spreads = allTickers.map(t => {
    const spreadPct = t.bid > 0 ? ((t.ask - t.bid) / t.bid) * 100 : 0;
    return {
      pair: t.pair,
      last: t.last,
      bid: t.bid,
      ask: t.ask,
      spreadPct: Number(spreadPct.toFixed(3)),
      quote_volume: Math.round(t.quote_volume)
    };
  }).sort((a, b) => b.spreadPct - a.spreadPct);

  const reportDir = path.join(process.cwd(), 'report');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir);
  }

  const outputPath = path.join(reportDir, 'spread_analysis.json');
  fs.writeFileSync(outputPath, JSON.stringify(spreads, null, 2));

  console.log(`Successfully exported spread analysis data to ${outputPath}`);
}

main().catch(console.error);
