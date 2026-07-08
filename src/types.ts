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
  readonly ollamaModel: string
  readonly ollamaEnabled: boolean
  readonly customPatterns: readonly CustomPatternEntry[]
  readonly customCategories: readonly CustomCategoryConfig[]
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
  ollamaModel: 'gemma3:4b',
  ollamaEnabled: false,
  customPatterns: [],
  customCategories: [],
  dictionary: [],
  allowlist: [],
  auditLog: {
    enabled: false,
    destination: 'stderr',
    reviewThreshold: 0.8,
  },
}
