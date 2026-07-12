import { defineBackend } from '@aws-amplify/backend';
import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import { CorsHttpMethod, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AttributeType, Billing, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { auth } from './auth/resource';
import { control } from './functions/control/resource';
import { trader } from './functions/trader/resource';

const backend = defineBackend({
  auth,
  trader,
  control,
});

const traderLambda = backend.trader.resources.lambda as LambdaFunction;
const controlLambda = backend.control.resources.lambda as LambdaFunction;
const stack = Stack.of(controlLambda);

// ---- 自動売買 ON/OFF スイッチ (SSMパラメータ。DBは使わない) ----
const tradingSwitch = new StringParameter(stack, 'TradingSwitch', {
  stringValue: 'true',
  description: 'coi-trader auto trading switch (true/false), toggled from the dashboard',
});
tradingSwitch.grantRead(traderLambda);
tradingSwitch.grantWrite(traderLambda);
tradingSwitch.grantRead(controlLambda);
tradingSwitch.grantWrite(controlLambda);

// ---- 資産推移・売買イベントの永久記録テーブル (DynamoDB) ----
// pk='SNAPSHOT' + sk=ISO8601: 15分ごとの総資産・現金・保有内訳(何年分でも15分粒度)
// pk='EVENT'    + sk=ISO8601#rand: Geminiの判断と注文の記録
const historyTable = new TableV2(stack, 'CoinGodHistory', {
  partitionKey: { name: 'pk', type: AttributeType.STRING },
  sortKey: { name: 'sk', type: AttributeType.STRING },
  billing: Billing.onDemand(),
  removalPolicy: RemovalPolicy.RETAIN,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
});
historyTable.grantReadWriteData(traderLambda);
// control は履歴の閲覧に加え、設定画面からの履歴リセット(全削除)を行うため書き込みも必要
historyTable.grantReadWriteData(controlLambda);

traderLambda.addEnvironment('HISTORY_TABLE', historyTable.tableName);
controlLambda.addEnvironment('HISTORY_TABLE', historyTable.tableName);
traderLambda.addEnvironment('TRADING_ENABLED_PARAM', tradingSwitch.parameterName);
controlLambda.addEnvironment('TRADING_ENABLED_PARAM', tradingSwitch.parameterName);

// ---- エラー通知用 Webhook URL (SSM SecureString、値はGitに置かない) ----
// パラメータの値は `aws ssm put-parameter` で別途登録する。ここでは名前と読み取り権限だけ配線する。
const errorWebhookParamName = '/coi-trader/error-webhook-url';
traderLambda.addEnvironment('ERROR_WEBHOOK_PARAM', errorWebhookParamName);
traderLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['ssm:GetParameter'],
    resources: [
      `arn:aws:ssm:${stack.region}:${stack.account}:parameter${errorWebhookParamName}`,
    ],
  }),
);
// SecureString の復号 (SSM経由でのみ使えるAWS管理鍵に限定)
traderLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['kms:Decrypt'],
    resources: ['*'],
    conditions: { StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` } },
  }),
);

// ---- control が閲覧データを集めるための権限 ----
// trader のログ(売買判断の履歴)
controlLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['logs:FilterLogEvents'],
    resources: [
      `arn:aws:logs:${Stack.of(traderLambda).region}:${Stack.of(traderLambda).account}:log-group:/aws/lambda/${traderLambda.functionName}:*`,
    ],
  }),
);
// trader の稼働設定(DRY_RUNやガードレール値)の参照
controlLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['lambda:GetFunctionConfiguration'],
    resources: [traderLambda.functionArn],
  }),
);
controlLambda.addEnvironment('TRADER_LOG_GROUP', `/aws/lambda/${traderLambda.functionName}`);
controlLambda.addEnvironment('TRADER_FUNCTION_NAME', traderLambda.functionName);

// ---- Cognito 認証付き HTTP API ----
const authorizer = new HttpUserPoolAuthorizer('CognitoAuthorizer', backend.auth.resources.userPool, {
  userPoolClients: [backend.auth.resources.userPoolClient],
});
const integration = new HttpLambdaIntegration('ControlIntegration', controlLambda);

const api = new HttpApi(stack, 'CoinGodApi', {
  corsPreflight: {
    allowOrigins: ['*'],
    allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
    allowHeaders: ['authorization', 'content-type'],
  },
});
api.addRoutes({ path: '/status', methods: [HttpMethod.GET], integration, authorizer });
api.addRoutes({ path: '/trading', methods: [HttpMethod.POST], integration, authorizer });
api.addRoutes({ path: '/reset', methods: [HttpMethod.POST], integration, authorizer });

// フロントエンドが amplify_outputs.json から APIのURL を読めるようにする
backend.addOutput({
  custom: {
    controlApiUrl: api.apiEndpoint,
  },
});

