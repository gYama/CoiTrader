import { existsSync, readFileSync } from 'node:fs';
import { CoincheckClient } from '../amplify/functions/trader/coincheck';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

const API_KEY = process.env.COINCHECK_API_KEY || '';
const API_SECRET = process.env.COINCHECK_API_SECRET || '';

if (!API_KEY || !API_SECRET) {
  console.error('Error: COINCHECK_API_KEY and COINCHECK_API_SECRET must be set in .env');
  process.exit(1);
}

const client = new CoincheckClient(API_KEY, API_SECRET);

async function main() {
  try {
    const balance = await client.getBalance();
    const holdings = Object.entries(balance)
      .filter(([key, value]) => key !== 'success' && typeof value === 'string' && parseFloat(value) > 0)
      .map(([key, value]) => `${key.toUpperCase()}: ${value}`);
      
    console.log('--- あなたの保有銘柄 ---');
    if (holdings.length === 0) {
      console.log('保有している資産はありません。');
    } else {
      holdings.forEach(h => console.log(h));
    }
    console.log('------------------------');
  } catch (error) {
    console.error('API呼び出し中にエラーが発生しました:', error);
  }
}

main();
