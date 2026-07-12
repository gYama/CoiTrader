import { defineFunction, secret } from '@aws-amplify/backend';

/**
 * 定期実行される自動売買関数。
 * schedule を変えると売買判断の頻度が変わる(例: 'every 5m', 'every 1h')。
 */
export const trader = defineFunction({
  name: 'trader',
  entry: './handler.ts',
  timeoutSeconds: 120,
  memoryMB: 256,
  schedule: 'every 15m',
  environment: {
    COINCHECK_API_KEY: secret('COINCHECK_API_KEY'),
    COINCHECK_API_SECRET: secret('COINCHECK_API_SECRET'),
    GEMINI_API_KEY: secret('GEMINI_API_KEY'),
    GEMINI_API_KEY_FALLBACK: secret('GEMINI_API_KEY_FALLBACK'),

    // ---- 安全設定(コード側で強制されるガードレール) ----
    // 'true' の間は注文を送信せず、判断結果をログに出すだけ
    DRY_RUN: 'false',
    // 1注文のサイズ = 総資産 × この割合(%)。資産の成長に自動で追従する。
    // 20% = 5分割相当。最低注文額500円の壁を小資本でも越えやすくしつつ、
    // 1判断ミスの損失を総資産の1/5以下に限定する
    ORDER_PCT_OF_ASSETS: '20',
    // 1注文の絶対上限(円)。資産が大きく育った後の暴走防止。育ったら引き上げる
    MAX_ORDER_JPY_CAP: '30000',
    // 1サイクル(1回の起動)で執行する注文数の上限
    MAX_ORDERS_PER_CYCLE: '3',
    // 1銘柄がポートフォリオ全体に占めてよい上限割合(%)。分散の強制
    MAX_COIN_SHARE_PCT: '25',
    // 総資産のこの割合(%)は常に円で保持する(下落時の買い余力を残す)。
    // 小資本のうちは現金がボトルネックになるため薄めに設定
    JPY_RESERVE_PCT: '5',
    // Gemini の判断確信度がこの値未満なら見送り(0〜1)
    MIN_CONFIDENCE: '0.7',
    // 取得単価からこの割合(%)下落した銘柄は Gemini の判断を待たず全量売却する
    // (機械的ストップロス)。'0' で無効化。取得単価が復元できる銘柄のみ対象
    STOP_LOSS_PCT: '10',
    // 24時間売買代金がこの額(円)未満のペアは板が薄すぎるため取引しない。
    // 注文サイズが数百〜数千円のうちは滑りは限定的なので、保有アルトの
    // リバランス(売却→現金化)を可能にするため床を下げている
    MIN_LIQUIDITY_JPY: '30000',
    // 対象から外すペア(カンマ区切り。空なら取引所の全ペアが対象)
    EXCLUDE_PAIRS: '',
    // 目標資産額(円)。売買判断には渡さず、進捗ログとメトリクスにのみ使う
    GOAL_ASSETS_JPY: '1300000000',
    // 使用する Gemini モデル
    GEMINI_MODEL: 'gemini-3.5-flash',
  },
});
