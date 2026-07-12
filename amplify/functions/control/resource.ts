import { defineFunction, secret } from '@aws-amplify/backend';

/**
 * ダッシュボード用API。Cognito認証(JWT)を通過したリクエストのみ届く。
 *  GET  /status  — ポートフォリオ・全ペア相場・資産推移・botログ・設定・スイッチ状態
 *  POST /trading — 自動売買のON/OFF切替
 */
export const control = defineFunction({
  name: 'control',
  entry: './handler.ts',
  timeoutSeconds: 30,
  memoryMB: 256,
  environment: {
    COINCHECK_API_KEY: secret('COINCHECK_API_KEY'),
    COINCHECK_API_SECRET: secret('COINCHECK_API_SECRET'),
    GOAL_ASSETS_JPY: '1300000000',
    // TRADER_LOG_GROUP と TRADER_FUNCTION_NAME は backend.ts が注入する
  },
});
