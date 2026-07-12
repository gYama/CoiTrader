import { CoincheckClient } from './amplify/functions/trader/coincheck';
import { readFileSync } from 'fs';

const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split('=')));

async function main() {
  const client = new CoincheckClient(env.COINCHECK_API_KEY, env.COINCHECK_API_SECRET);
  // Add a generic GET method to test
  const res = await (client as any).privateRequest('GET', '/api/deposit_money?currency=JPY');
  console.log('Deposits:', JSON.stringify(res, null, 2));
}
main().catch(console.error);
