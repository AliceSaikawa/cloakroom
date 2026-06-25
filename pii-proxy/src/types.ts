export type PIICategory =
  | 'EMAIL'
  | 'PHONE'
  | 'ADDRESS'
  | 'URL_USER'
  | 'API_KEY'
  | 'CREDIT_CARD'
  | 'MY_NUMBER'
  | 'NAME'
  | 'ORG'
  | 'SCHOOL'

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
  ],
  ollamaEndpoint: 'http://localhost:11434',
  ollamaModel: 'gemma3:4b',
  ollamaEnabled: true,
  customPatterns: [],
  dictionary: [],
}
