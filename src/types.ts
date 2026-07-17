export const PII_CATEGORIES = [
  'EMAIL',
  'PHONE',
  'ADDRESS',
  'URL_USER',
  'API_KEY',
  'CREDIT_CARD',
  'MY_NUMBER',
  'NAME',
  'ORG',
  'SCHOOL',
  'SSN',
  'IP_ADDRESS',
  'POSTAL_CODE',
  'IBAN',
  'BANK_ACCOUNT',
  'DRIVER_LICENSE',
  'PASSPORT',
  'CRYPTO_WALLET',
  'DATE_TIME',
  'MEDICAL_RECORD',
  'HEALTH_INSURANCE',
] as const

export type BuiltInPIICategory = (typeof PII_CATEGORIES)[number]
export type PIICategory = BuiltInPIICategory | (string & {})

// Built-in categories use readable Japanese labels in placeholders. Custom
// categories can override this through customCategories.label or placeholder.
export const CATEGORY_LABELS: Record<BuiltInPIICategory, string> = {
  EMAIL: 'メールアドレス',
  PHONE: '電話番号',
  ADDRESS: '住所',
  URL_USER: '認証URL',
  API_KEY: 'APIキー',
  CREDIT_CARD: 'クレジットカード',
  MY_NUMBER: 'マイナンバー',
  NAME: '人名',
  ORG: '組織名',
  SCHOOL: '学校名',
  SSN: '社会保障番号',
  IP_ADDRESS: 'IPアドレス',
  POSTAL_CODE: '郵便番号',
  IBAN: 'IBAN',
  BANK_ACCOUNT: '銀行口座',
  DRIVER_LICENSE: '運転免許証',
  PASSPORT: 'パスポート',
  CRYPTO_WALLET: '暗号資産ウォレット',
  DATE_TIME: '生年月日',
  MEDICAL_RECORD: '医療記録',
  HEALTH_INSURANCE: '健康保険証',
}

export type PIIMatch = {
  readonly text: string
  readonly category: PIICategory
  readonly start: number
  readonly end: number
  readonly confidence: number
}

export type DictionaryEntry = {
  readonly text: string
  readonly category: PIICategory
  readonly matchMode?: 'partial' | 'exact'
  readonly caseSensitive?: boolean
  readonly normalizeWidth?: boolean
}

export type CustomPatternEntry = {
  readonly name: string
  readonly pattern: string
  readonly category?: PIICategory
}

export type CustomCategoryConfig = {
  readonly name: PIICategory
  readonly label?: string
  readonly placeholder?: string
  readonly enabled?: boolean
  readonly patterns?: readonly string[]
  readonly dictionary?: readonly string[]
}

export type FilterPluginMatch = {
  readonly start: number
  readonly end: number
  readonly value: string
  readonly category?: PIICategory
  readonly confidence?: number
}

export type FilterPlugin = {
  readonly name: string
  detect(text: string): readonly FilterPluginMatch[] | Promise<readonly FilterPluginMatch[]>
}

export type PIIMode = 'pseudonymize' | 'anonymize'

export type AuditLogDestination = 'stderr' | 'file'

export type AuditLogConfig = {
  readonly enabled: boolean
  readonly destination: AuditLogDestination
  readonly path?: string
  readonly reviewThreshold: number
}

export type PIIFilterConfig = {
  readonly enabled: boolean
  readonly mode: PIIMode
  readonly categories: readonly PIICategory[]
  readonly ollamaEndpoint: string
  readonly allowRemoteOllama: boolean
  readonly ollamaModel: string
  readonly ollamaEnabled: boolean
  readonly heuristicNerEnabled: boolean
  readonly customPatterns: readonly CustomPatternEntry[]
  readonly customCategories: readonly CustomCategoryConfig[]
  readonly plugins: readonly string[]
  readonly dictionary: readonly DictionaryEntry[]
  readonly allowlist: readonly string[]
  readonly auditLog: AuditLogConfig
}

export const DEFAULT_CONFIG: PIIFilterConfig = {
  enabled: true,
  mode: 'pseudonymize',
  categories: [
    'EMAIL',
    'PHONE',
    'ADDRESS',
    'API_KEY',
    'CREDIT_CARD',
    'MY_NUMBER',
    'NAME',
    'ORG',
    'SCHOOL',
    'SSN',
    'IP_ADDRESS',
    'POSTAL_CODE',
    'IBAN',
    'BANK_ACCOUNT',
    'DRIVER_LICENSE',
    'PASSPORT',
    'CRYPTO_WALLET',
    'DATE_TIME',
    'MEDICAL_RECORD',
    'HEALTH_INSURANCE',
  ],
  ollamaEndpoint: 'http://localhost:11434',
  allowRemoteOllama: false,
  ollamaModel: 'gemma3:4b',
  ollamaEnabled: false,
  heuristicNerEnabled: true,
  customPatterns: [],
  customCategories: [],
  plugins: [],
  dictionary: [],
  allowlist: [],
  auditLog: {
    enabled: false,
    destination: 'stderr',
    reviewThreshold: 0.8,
  },
}
