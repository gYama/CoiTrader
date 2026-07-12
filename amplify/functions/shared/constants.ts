/** ダッシュボードに公開してよい trader の設定キー(シークレットは含めない) */
export const PUBLIC_CONFIG_KEYS = [
  'DRY_RUN',
  'ORDER_PCT_OF_ASSETS',
  'MAX_ORDER_JPY_CAP',
  'MAX_ORDERS_PER_CYCLE',
  'MAX_COIN_SHARE_PCT',
  'JPY_RESERVE_PCT',
  'MIN_CONFIDENCE',
  'MIN_LIQUIDITY_JPY',
  'EXCLUDE_PAIRS',
  'GOAL_ASSETS_JPY',
  'GEMINI_MODEL',
] as const;
