import type { PreSignUpTriggerHandler } from 'aws-lambda';

export const handler: PreSignUpTriggerHandler = async (event) => {
  const allowed = (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const email = event.request.userAttributes.email?.trim().toLowerCase();

  if (!email || !allowed.includes(email)) {
    console.log(`sign-up rejected for: ${email ?? '(no email)'}`);
    throw new Error('このメールアドレスでは登録できません');
  }
  return event;
};
