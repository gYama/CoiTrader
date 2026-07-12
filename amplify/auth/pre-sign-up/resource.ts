import { defineFunction, secret } from '@aws-amplify/backend';

/** サインアップ時に許可リスト外のメールアドレスを拒否する Cognito トリガー */
export const preSignUp = defineFunction({
  name: 'pre-sign-up',
  entry: './handler.ts',
  resourceGroupName: 'auth',
  environment: {
    // このアドレス以外はアカウント登録できない(カンマ区切りで複数指定可)
    ALLOWED_EMAILS: secret('ALLOWED_EMAILS'),
  },
});
