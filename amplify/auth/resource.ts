import { defineAuth } from '@aws-amplify/backend';
import { preSignUp } from './pre-sign-up/resource';

/**
 * メールアドレス + パスワードでログイン。
 * preSignUp トリガーが許可リスト外のアドレスの登録を拒否するため、
 * 実質的にオーナーの Gmail アドレスしかアカウントを作れない。
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  triggers: {
    preSignUp,
  },
});
