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
] as const

export type PIICategory = (typeof PII_CATEGORIES)[number]

export type PIIMatch = {
  readonly text: string
  readonly category: PIICategory
  readonly start: number
  readonly end: number
}

export type DictionaryEntry = {
  readonly text: string
  readonly category: PIICategory
}

export type PIIFilterConfig = {
  readonly enabled: boolean
  readonly categories: readonly PIICategory[]
  readonly ollamaEndpoint: string
  readonly ollamaModel: string
  readonly ollamaEnabled: boolean
  readonly customPatterns: readonly { readonly name: string; readonly pattern: string }[]
  readonly dictionary: readonly DictionaryEntry[]
  readonly allowlist: readonly string[]
}

export const DEFAULT_CONFIG: PIIFilterConfig = {
  enabled: true,
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
  ],
  ollamaEndpoint: 'http://localhost:11434',
  ollamaModel: 'gemma3:4b',
  ollamaEnabled: true,
  customPatterns: [],
  dictionary: [],
  allowlist: [],
}
