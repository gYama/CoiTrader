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
    // 24時間売買代金がこの額(円)未満のペアには新規買いを入れない(自分の注文が
    // 日次出来高の1%未満に収まる水準)。売却は脱出手段としてこの1/10まで許容される
    // ため、床を上げても既存の薄い保有銘柄の現金化は妨げない
    MIN_LIQUIDITY_JPY: '300000',
    // 同時保有銘柄数の上限。小資本で銘柄を増やしても分散効果より
    // スリッページ・最低数量制約のコストが勝るため、少数に集中させる
    MAX_HOLDINGS: '5',
    // Gemini への売買判断を行う間隔(分)。15分ごとの再判断はほぼ同一データへの
    // 再抽選となりノイズ売買を生むだけだったため1時間に間引く。
    // スナップショット記録・ストップロス・サーキットブレーカーは15分ごとのまま。
    // 15の倍数(15/30/60)のみサポート
    DECISION_INTERVAL_MINUTES: '15',
    // 買ってからこの時間(h)は売らない(機械的ストップロスは例外)。
    // 買いの15〜30分後に「集中リスク」を理由とした反転売りが頻発し、
    // 往復コストだけが積み上がった実績(3勝9敗・実現損益-70円)への対策
    MIN_HOLD_HOURS: '6',
    // 売ってからこの時間(h)は同じ通貨を買い直さない(往復売買の防止。
    // 実績: XRP を24時間で3往復し、売値より高く買い戻していた)
    REBUY_COOLDOWN_HOURS: '6',
    // 対象から外すペア(カンマ区切り。空なら取引所の全ペアが対象)
    EXCLUDE_PAIRS: '',
    // 目標資産額(円)。売買判断には渡さず、進捗ログとメトリクスにのみ使う
    GOAL_ASSETS_JPY: '1300000000',
    // 使用する Gemini モデル（カンマ区切りで複数指定した場合、フォールバックとして順に試行）
    GEMINI_MODEL: 'gemini-3.1-flash-lite,gemini-3.5-flash,gemini-3.0-flash,gemini-2.5-flash,gemini-2.5-flash-lite',
    // 複数モデル・複数APIキー指定時のフォールバック順序 ('KEY_FIRST' | 'MODEL_FIRST')
    FALLBACK_STRATEGY: 'KEY_FIRST',
  },
});
