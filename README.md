[English](#english) | [日本語](#japanese)

<a id="english"></a>
# coi-trader — Coincheck × Gemini Automated Trading Bot (AWS Amplify)

A **database-free, completely stateless** automated cryptocurrency trading application. 
It fetches market data for **all pairs** available on the Coincheck exchange, passes the market data and your entire portfolio to Google Gemini for rebalancing and trading decisions, strictly enforces safety guardrails (diversification, order caps) in the code, and then executes market orders.

Because it runs as a scheduled AWS Amplify Gen 2 Lambda function, it operates 24/7 in the cloud without needing a PC or smartphone running.

## ⚠️ Important Notice

- Automated cryptocurrency trading carries the **risk of losing your principal**. This application does not constitute financial advice and does not guarantee profits.
- The default setting is `DRY_RUN=true` (it only logs decisions without executing actual orders). **Please observe the bot in dry-run mode for a while** before switching to live trading with real funds.
- Grant **only the minimum necessary permissions** (Balance read, Trade) to your Coincheck API keys. NEVER grant withdrawal permissions.

## Architecture

```text
EventBridge (every 15m)
   └─▶ Lambda trader (amplify/functions/trader)
          0. Exit immediately if SSM parameter (Dashboard switch) is OFF.
          1. Coincheck Public API: Fetch ticker data for all pairs.
          2. Coincheck Auth API: Fetch balances -> Evaluate portfolio in JPY.
          3. Gemini API: Send market data + portfolio state, receive rebalancing/trade proposals (max 3) in JSON.
          4. Apply safety guardrails to each proposed order (see below).
          5. Coincheck Auth API: Execute market orders (only when DRY_RUN=false).

Browser (React / Wealth Dashboard)
   └─▶ Cognito Login (Restricted to allowed Gmails only)
        └─▶ API Gateway (JWT Auth) ─▶ Lambda control
              GET  /status  … Fetch portfolio, market data, history, bot logs, and settings.
              POST /trading … Toggle automated trading ON/OFF (updates SSM parameter).
```

No database is needed because the state is fetched fresh from Coincheck every time (only the ON/OFF switch is stored in AWS SSM Parameter Store). Asset history is tracked via CloudWatch Metrics, and trade history can be viewed on the Coincheck dashboard and CloudWatch Logs.

## Dashboard

Features a premium black lacquer and gold leaf "wealth" design. It displays your total assets, progress towards your goal (e.g. 1.3 billion JPY), an asset history chart, portfolio diversification, market prices for all 27 pairs (including liquidity warnings), the bot's decision logs ("Oracle Records"), and active guardrail settings. You can instantly toggle the trading bot ON/OFF using the "Business Thriving (ON) / Closed (OFF)" button.

- Preview UI locally with mock data: `npm run demo` → http://localhost:5173
- Real usage: Run `npm run dev` after `npx ampx sandbox` (or deploy via Amplify Hosting).

### Authentication (Gmail Restricted)

It uses Cognito email login. The `preSignUp` trigger strictly rejects any email address not listed in the `ALLOWED_EMAILS` Amplify secret.
On your first visit, click "Create Account" using your permitted Gmail, then enter the verification code. Nobody else can create an account.

- **Local/Sandbox Environment**: Set via command `npx ampx sandbox secret set ALLOWED_EMAILS`.
- **Production Environment**: In the AWS Management Console for your Amplify app, navigate to **[Environment variables]** (or Secrets) for your target branch (e.g. `main`), and add `ALLOWED_EMAILS` with your email address.

## Risk Diversification Guardrails (Enforced in Code)

Regardless of what Gemini proposes, the code enforces the following rules:

- **Capital-Linked Sizing**: 1 Order = Total Assets × `ORDER_PCT_OF_ASSETS` (default 15%). As your assets grow, order sizes grow automatically, capped strictly by `MAX_ORDER_JPY_CAP` (default 50,000 JPY) to prevent runaway trades.
- **Forced Diversification**: The bot will not buy more of a coin if it exceeds `MAX_COIN_SHARE_PCT` (default 25%) of your portfolio.
- **Liquidity Filter**: Ignores illiquid pairs where the 24h trading volume is below `MIN_LIQUIDITY_JPY` (default 100,000 JPY) to avoid extreme slippage on market orders.
- **Unsellable Dust Guard**: The bot will not execute a buy order if the resulting holdings would be below the exchange's minimum sellable amount (e.g. 0.005 BTC).
- **Order Limit**: Maximum of `MAX_ORDERS_PER_CYCLE` (default 3) executed per cycle.
- **JPY Reserve**: Always keeps at least `JPY_RESERVE_PCT` (default 10%) of total assets in JPY (buying power for dips).
- **Confidence Filter**: Skips proposals if Gemini's confidence score is below `MIN_CONFIDENCE` (default 0.7).
- **Stop Loss / Circuit Breaker**: Additional protections against sudden market crashes (see Configuration).

## Goal and Progress Tracking

The bot logs its progress towards `GOAL_ASSETS_JPY` (default 1.3 Billion JPY) every cycle and records the total asset value as a CloudWatch Custom Metric (`CoinGod/TotalAssetsJpy` using EMF format, no DB required). You can visualize years of asset growth directly in CloudWatch graphs.

**Note**: The goal amount is NOT passed to the Gemini prompt. This is intentional. Asking the model to "turn 13,000 JPY into 1.3 Billion JPY" encourages high-risk, low-probability gambling behavior. The objective function for the LLM is strictly fixed to "long-term compound growth avoiding drawdowns."

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Obtain API Keys

- **Coincheck**: Create keys on the [API Settings page](https://coincheck.com/ja/api_settings). Grant ONLY "Balance" and "Trade" permissions. IP restriction cannot be used since Lambda lacks a static IP.
- **Gemini**: Create an API key at [Google AI Studio](https://aistudio.google.com/apikey).

### 3. Local Dry Run (Recommended)

```bash
cp .env.example .env
# Enter the 3 API keys in .env
npm run trade:local
```

If you see logs like `[DRY_RUN] would market-buy ...` or `no trade: ...`, the setup is successful.

### 4. Deploy to AWS

After setting up your AWS account and credentials (e.g. `aws configure`):

#### For Sandbox Environment (Testing)

```bash
# Register secrets for the sandbox
npx ampx sandbox secret set COINCHECK_API_KEY
npx ampx sandbox secret set COINCHECK_API_SECRET
npx ampx sandbox secret set GEMINI_API_KEY
npx ampx sandbox secret set ALLOWED_EMAILS

# Deploy as a sandbox (remains deployed while running)
npx ampx sandbox
```

Once the sandbox generates `amplify_outputs.json`, open another terminal and run `npm run dev` to use the dashboard (http://localhost:5173).

#### For Production Environment

For production use, connect your GitHub repository to the AWS Amplify Console and deploy the branch (the `amplify.yml` is included). The frontend will be deployed simultaneously to Amplify Hosting.

During or after deployment, open the **AWS Management Console for Amplify (Environment variables / Secrets)** for your branch, and register the following 4 secret values. The bot will not run in production without these:

1. `COINCHECK_API_KEY`
2. `COINCHECK_API_SECRET`
3. `GEMINI_API_KEY`
4. `ALLOWED_EMAILS`

### 5. Switch to Live Trading

After confirming the dry run logs (CloudWatch Logs → `/aws/lambda/...trader...`) for a few days, change `DRY_RUN: 'true'` to `'false'` in [amplify/functions/trader/resource.ts](amplify/functions/trader/resource.ts) and redeploy.

## Configuration Variables

All settings can be modified in the `environment` section of [resource.ts](amplify/functions/trader/resource.ts).

| Variable | Default | Description |
|---|---|---|
| `DRY_RUN` | `true` | Change to `false` to execute real orders. |
| `ORDER_PCT_OF_ASSETS` | `15` | Order size = Total Assets × this %. |
| `MAX_ORDER_JPY_CAP` | `50000` | Absolute max cap per order (JPY). Increase as assets grow. |
| `MAX_ORDERS_PER_CYCLE` | `3` | Max number of orders to execute per cycle. |
| `MAX_COIN_SHARE_PCT` | `25` | Max portfolio share (%) for a single coin. |
| `JPY_RESERVE_PCT` | `10` | Keep at least this % of total assets in JPY. |
| `MIN_CONFIDENCE` | `0.7` | Skip if Gemini's confidence is below this. |
| `MIN_LIQUIDITY_JPY` | `100000` | Ignore pairs with 24h volume below this (JPY). |
| `STOP_LOSS_PCT` | `10` | Auto sell-all if asset drops this % below average cost (0 to disable). |
| `MAX_DRAWDOWN_24H_PCT` | `10` | Circuit breaker: Halts all trading if total portfolio drops this % in 24h. |
| `EXCLUDE_PAIRS` | (Empty) | Pairs to exclude (e.g. `shib_jpy,pepe_jpy`). |
| `GOAL_ASSETS_JPY` | `1300000000` | Target goal. Used for logs/metrics only. |
| `GEMINI_MODEL` | `gemini-3.5-flash` | The Gemini model to use. |

You can also change the execution frequency via `schedule: 'every 15m'` in the same file.

## Estimated Costs

- **AWS Lambda**: 15 min intervals × 128~256MB × a few seconds → **Within Free Tier**
- **AWS EventBridge**: Free
- **Gemini**: Few hundred tokens per run → Minimal cost (Free Tier available)
- **Coincheck**: API usage is free (Trading fees apply separately)

## License

This project is licensed under the [MIT License](LICENSE).

---

<a id="japanese"></a>
# coi-trader — Coincheck × Gemini 自動売買 (AWS Amplify)

Coincheck の**取引所で扱う全ペア**を対象に、相場とポートフォリオ全体を Google Gemini に渡してリバランス・売買判断をさせ、分散・上限などのガードレールをコード側で強制した上で成行注文を出す、**データベース不要・完全ステートレス**な自動売買アプリです。

AWS Amplify Gen 2 のスケジュール付き Lambda 関数として動くので、PC やスマホを起動しておく必要はなく、24時間365日クラウド側で実行されます。

## ⚠️ 重要な注意

- 暗号資産の自動売買は**元本を失うリスク**があります。本アプリは投資助言ではなく、利益を保証しません。
- 初期設定は `DRY_RUN=true`(注文を送信せずログに出すだけ)です。**必ずドライランでしばらく様子を見てから**実弾に切り替えてください。
- Coincheck の APIキーには**必要最小限の権限**(残高参照・取引)だけを付与し、出金権限は絶対に付けないでください。

## アーキテクチャ

```text
EventBridge (15分ごと)
   └─▶ Lambda trader (amplify/functions/trader)
          0. SSMパラメータ(ダッシュボードのスイッチ)がOFFなら即終了
          1. Coincheck 公開API: /api/ticker/all で全ペアの相場を一括取得
          2. Coincheck 認証API: 全通貨の残高 → ポートフォリオを円換算で評価
          3. Gemini API: 全銘柄の相場 + ポートフォリオ構成を渡し、
             リバランス・売買の提案(最大3件)を JSON で受け取る
          4. 注文ごとにガードレール適用(下記)
          5. Coincheck 認証API: 成行注文(DRY_RUN=false のときのみ)

ブラウザ (React / 金運ダッシュボード)
   └─▶ Cognito ログイン(許可した Gmail のみ登録可能)
        └─▶ API Gateway (JWT認証) ─▶ Lambda control
              GET  /status  … ポートフォリオ・全ペア相場・資産推移・botログ・稼働設定
              POST /trading … 自動売買 ON/OFF (SSMパラメータを書き換え)
```

状態は毎回 Coincheck から取得するため DB は不要です(ON/OFFスイッチのみ SSM Parameter Store に保持)。資産推移は CloudWatch メトリクス、取引履歴は Coincheck の取引画面と CloudWatch Logs で確認できます。

## ダッシュボード

黒漆×金箔の金運デザイン。総資産と13億円への進捗、資産推移チャート、保有資産の分散状況、全27ペアの相場(自動売買の対象/板薄も表示)、botの判断ログ(神託の記録)、稼働中のガードレール設定を一画面で確認でき、「商売繁盛(ON)/休業中(OFF)」ボタンで自動売買を即時に切り替えられます。

- ローカルで実データなしにUIを見る: `npm run demo` → http://localhost:5173
- 実運用: `npx ampx sandbox` 起動後に `npm run dev`(またはAmplify Hostingへデプロイ)

### 認証(Gmail限定)

Cognito のメールアドレスログインを使い、`preSignUp` トリガーが Amplify のシークレット `ALLOWED_EMAILS` に設定したアドレス以外の登録を拒否します。
初回アクセス時に「Create Account」からそのGmailで登録し、届いた確認コードを入力してください。以後は他人はアカウント自体を作れません。

- **ローカル/サンドボックス環境**: `npx ampx sandbox secret set ALLOWED_EMAILS` コマンドで設定します。
- **本番環境**: AWSマネジメントコンソールの Amplify アプリ画面から、対象ブランチ（`main`等）の **[Environment variables]**（または Secrets）設定画面を開き、そこに `ALLOWED_EMAILS` と自分のメールアドレスを追加します。

## リスク分散のためのガードレール(コード側で強制)

Gemini の提案がどうであれ、以下はコードが強制します。

- **資本連動のサイズ**: 1注文 = 総資産 × `ORDER_PCT_OF_ASSETS`(既定15%)。資産が育つと注文も自動で大きくなり、`MAX_ORDER_JPY_CAP`(既定5万円)が暴走防止の絶対上限になる
- **分散の強制**: 1銘柄がポートフォリオの `MAX_COIN_SHARE_PCT`(既定25%)を超える買い増しはしない
- **流動性フィルタ**: 24時間売買代金が `MIN_LIQUIDITY_JPY`(既定10万円)未満の板の薄いペアは成行が大きく滑るため取引しない(Coincheck取引所はBTC/ETH/XRP以外の出来高が極端に少ない日が多い)
- **塩漬けガード**: 買った後の保有量が取引所の最低売却数量(BTC系は 0.005 BTC ≈ 数万円)に届かない買いはしない。売れないポジションを作らないため。資本が育てば自動的に解禁される
- **件数上限**: 1サイクル `MAX_ORDERS_PER_CYCLE`(既定3件)まで
- **円の下限**: 総資産の `JPY_RESERVE_PCT`(既定10%)は常に円で保持(下落時の買い余力)
- **確信度フィルタ**: Gemini の confidence が `MIN_CONFIDENCE`(既定0.7)未満の提案は見送り
- 例外: BTC/WBTC の成行売りは、保有が足りる場合のみ注文サイズ上限を超えて最低数量(0.005)に切り上げて売ります(円への回収方向のみ)

## 目標と進捗の記録

`GOAL_ASSETS_JPY`(既定13億円)への進捗を毎サイクルログに出し、総資産額を CloudWatch カスタムメトリクス `CoinGod/TotalAssetsJpy` として記録します(EMF形式、DB不要)。
CloudWatch のメトリクスグラフで何年分でも資産推移を確認できます。

**注意**: 目標額は売買判断(Geminiへのプロンプト)には渡していません。意図的な設計です — 「1.3万円を13億円にしろ」とモデルに伝えると、期待値の低い一発逆転型の取引に誘導されるためです。判断側の目的関数はあくまで「ドローダウンを避けた長期複利」に固定しています。

⚠️ どんな戦略でも「常に資産が増える」ことは保証できません。これらのガードレールは損失の速度と集中リスクを抑えるためのもので、利益を保証するものではありません。

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. APIキーの取得

- **Coincheck**: [API設定ページ](https://coincheck.com/ja/api_settings) でキーを作成。権限は「残高」「取引」のみ。IPアドレス制限は Lambda では固定IPがないため使えません。
- **Gemini**: [Google AI Studio](https://aistudio.google.com/apikey) で APIキーを作成。

### 3. ローカルでドライラン(推奨)

```bash
cp .env.example .env
# .env に3つのAPIキーを記入
npm run trade:local
```

`[DRY_RUN] would market-buy ...` や `no trade: ...` というログが出れば正常です。

### 4. AWS へデプロイ

AWS アカウントと認証情報(`aws configure` など)を設定した上で:

#### サンドボックス環境 (テスト用) の場合

```bash
# サンドボックス用のシークレットを登録
npx ampx sandbox secret set COINCHECK_API_KEY
npx ampx sandbox secret set COINCHECK_API_SECRET
npx ampx sandbox secret set GEMINI_API_KEY
npx ampx sandbox secret set ALLOWED_EMAILS

# サンドボックスとしてデプロイ(起動したまま = デプロイされたまま)
npx ampx sandbox
```

サンドボックスが `amplify_outputs.json` を生成したら、別ターミナルで `npm run dev` を実行するとダッシュボード(http://localhost:5173)が使えます。

#### 本番環境 (プロダクション) の場合

本番運用する場合は GitHub リポジトリを AWS Amplify コンソールに接続してブランチデプロイします(`amplify.yml` 同梱済み。フロントも同時に Hosting へ配信されます)。

デプロイ設定時（またはデプロイ後）に、**AWSマネジメントコンソールの Amplify アプリ設定画面（Environment variables / Secrets）** を開き、対象ブランチ（`main`等）に対して以下の4つのシークレット値を登録してください。これを忘れると本番環境でボットが動きません。

1. `COINCHECK_API_KEY`
2. `COINCHECK_API_SECRET`
3. `GEMINI_API_KEY`
4. `ALLOWED_EMAILS`

### 5. 実弾に切り替える

ドライランのログ(CloudWatch Logs → `/aws/lambda/...trader...`)を数日確認した後、
[amplify/functions/trader/resource.ts](amplify/functions/trader/resource.ts) の
`DRY_RUN: 'true'` を `'false'` に変えて再デプロイします。

## 設定項目

すべて [resource.ts](amplify/functions/trader/resource.ts) の `environment` で変更できます。

| 変数 | デフォルト | 意味 |
|---|---|---|
| `DRY_RUN` | `true` | `false` にすると実際に注文を送信 |
| `ORDER_PCT_OF_ASSETS` | `15` | 1注文のサイズ = 総資産 × この% |
| `MAX_ORDER_JPY_CAP` | `50000` | 1注文の絶対上限(円)。資産が育ったら引き上げる |
| `MAX_ORDERS_PER_CYCLE` | `3` | 1サイクルで執行する注文数の上限 |
| `MAX_COIN_SHARE_PCT` | `25` | 1銘柄のポートフォリオ占有率の上限(%) |
| `JPY_RESERVE_PCT` | `10` | 総資産のこの%は常に円で保持 |
| `MIN_CONFIDENCE` | `0.7` | Gemini の確信度がこれ未満なら見送り |
| `MIN_LIQUIDITY_JPY` | `100000` | 24時間売買代金がこれ未満のペアは対象外 |
| `STOP_LOSS_PCT` | `10` | 取得単価からこの%下落したら Gemini の判断を待たず全量売却。0以下で無効 |
| `MAX_DRAWDOWN_24H_PCT` | `10` | 入出金を除いた運用成績が24時間でこの%下落したら自動売買を緊急停止(サーキットブレーカー)。再開はダッシュボードのスイッチON |
| `EXCLUDE_PAIRS` | (空) | 対象から外すペア(例: `shib_jpy,pepe_jpy`) |
| `GOAL_ASSETS_JPY` | `1300000000` | 目標資産額。ログとメトリクスにのみ使用 |
| `GEMINI_MODEL` | `gemini-3.5-flash` | 使用モデル |

実行頻度は同ファイルの `schedule: 'every 15m'` で変更できます。

## コスト目安

- Lambda: 15分間隔 × 128〜256MB × 数秒 → **無料枠内**
- EventBridge スケジュール: 無料
- Gemini 2.5 Flash: 1回あたり数百トークン → 月数円程度(無料枠あり)
- Coincheck: API利用は無料(取引手数料は別途)

## ライセンス

このプロジェクトは [MIT ライセンス](LICENSE) のもとで公開されています。
