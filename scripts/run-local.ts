/**
 * ローカルで1サイクルだけ売買ロジックを実行する(デプロイ不要の動作確認用)。
 *
 *   1. .env ファイルに APIキーを書く(.env.example 参照)
 *   2. npm run trade:local
 *
 * DRY_RUN=false を明示しない限り注文は送信されない。
 */
import { existsSync, readFileSync } from 'node:fs';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

process.env.LOCAL_RUN = 'true';

const { runTradingCycle } = await import('../amplify/functions/trader/handler');
await runTradingCycle();
