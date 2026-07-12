import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/**
 * エラー発生時に Google Chat の Webhook へ通知する。
 * Webhook URL は認証トークンを含むため、コードやGitには置かず SSM(SecureString)から取得する。
 * 通知自体の失敗は握りつぶす(通知が原因で売買サイクルを壊さない)。
 */

const ssm = new SSMClient({});
// URLはコールドスタート後に一度だけ取得してキャッシュする(取得済みなら再取得しない)
let cachedUrl: string | null = null;
let fetched = false;

async function webhookUrl(): Promise<string | null> {
  if (fetched) return cachedUrl;
  fetched = true;
  const paramName = process.env.ERROR_WEBHOOK_PARAM;
  if (!paramName) return null;
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: paramName, WithDecryption: true }),
    );
    cachedUrl = res.Parameter?.Value ?? null;
  } catch (err) {
    console.error('failed to read error webhook URL from SSM:', err);
    cachedUrl = null;
  }
  return cachedUrl;
}

/**
 * 実行環境を判定する。
 * ローカル実行時は 'local'、AWS上は関数名から sandbox か production かを推測する。
 */
function getEnvironmentName(): string {
  if (process.env.LOCAL_RUN === 'true') return 'local (手元実行)';
  
  const fnName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!fnName) return 'unknown';
  if (fnName.includes('-sandbox-')) return 'sandbox (テスト環境)';
  if (fnName.includes('-main-')) return 'production (本番環境)';
  return `AWS (${fnName})`;
}

/**
 * エラーを Google Chat に通知する。context は「どの処理で失敗したか」の短い説明。
 * 通知の成否に関わらず例外は投げない。
 */
export async function notifyError(context: string, error: unknown): Promise<void> {
  const url = await webhookUrl();
  if (!url) return;
  const detail = error instanceof Error ? error.message : String(error);
  const envName = getEnvironmentName();
  
  const text = [
    '🚨 *coi-trader エラー*',
    `環境: ${envName}`,
    `処理: ${context}`,
    `内容: ${detail}`,
    `時刻: ${new Date().toISOString()}`,
  ].join('\n');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`error webhook returned ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    // 通知の失敗はログのみ(サイクルは止めない)
    console.error('failed to post error webhook:', err);
  }
}
