import { isIP } from 'node:net'
import type { CustomPatternEntry, DictionaryEntry, PIICategory, PIIMatch } from './types.js'

type ContextEnhancer = {
  readonly boostWords: readonly string[]
  readonly suppressWords: readonly string[]
  readonly boostAmount: number
  readonly suppressAmount: number
  readonly windowChars: number
}

type PatternDef = {
  readonly category: PIICategory
  readonly pattern: RegExp
  readonly validate?: (match: string) => boolean
  readonly captureGroup?: number
  readonly contextEnhancer?: ContextEnhancer
  readonly baseConfidence?: number
  readonly minimumConfidence?: number
  readonly defaultAction?: 'mask' | 'block' | 'warn'
}

type NormalizedSearchText = {
  readonly text: string
  readonly sourceStarts: readonly number[]
  readonly sourceEnds: readonly number[]
}

function buildNormalizedSearchText(text: string): NormalizedSearchText {
  let normalized = ''
  const sourceStarts: number[] = []
  const sourceEnds: number[] = []

  for (let sourceStart = 0; sourceStart < text.length;) {
    const codePoint = text.codePointAt(sourceStart) ?? 0
    const originalCharacter = String.fromCodePoint(codePoint)
    const sourceEnd = sourceStart + originalCharacter.length
    const normalizedCharacter = originalCharacter.normalize('NFKC')
    normalized += normalizedCharacter
    for (let index = 0; index < normalizedCharacter.length; index++) {
      sourceStarts.push(sourceStart)
      sourceEnds.push(sourceEnd)
    }
    sourceStart = sourceEnd
  }

  return { text: normalized, sourceStarts, sourceEnds }
}

function mapNormalizedRange(
  search: NormalizedSearchText,
  start: number,
  end: number,
  sourceLength: number,
): { readonly start: number; readonly end: number } {
  return {
    start: search.sourceStarts[start] ?? sourceLength,
    end: end > start ? search.sourceEnds[end - 1] ?? sourceLength : sourceLength,
  }
}

function applyContextEnhancer(
  text: string,
  start: number,
  end: number,
  enhancer: ContextEnhancer,
  confidence: number,
): number {
  const windowStart = Math.max(0, start - enhancer.windowChars)
  const windowEnd = Math.min(text.length, end + enhancer.windowChars)
  const context = text.slice(windowStart, start) + text.slice(end, windowEnd)

  let adjusted = confidence

  for (const word of enhancer.boostWords) {
    if (context.includes(word)) {
      adjusted = Math.min(1, adjusted + enhancer.boostAmount)
      break
    }
  }

  for (const word of enhancer.suppressWords) {
    if (context.includes(word)) {
      adjusted = Math.max(0, adjusted - enhancer.suppressAmount)
      break
    }
  }

  return adjusted
}

export function selectNonOverlappingMatches(matches: readonly PIIMatch[]): readonly PIIMatch[] {
  const sorted = [...matches].sort(
    (left, right) =>
      left.start - right.start ||
      right.confidence - left.confidence ||
      (right.end - right.start) - (left.end - left.start),
  )

  const winners: PIIMatch[] = []
  let lastEnd = -1

  for (const match of sorted) {
    if (match.start >= lastEnd) {
      winners.push(match)
      lastEnd = match.end
    }
  }

  return winners.sort((left, right) => right.start - left.start)
}

export function luhnCheck(digits: string): boolean {
  const nums = digits.replace(/\D/g, '')
  let sum = 0
  let alternate = false
  for (let i = nums.length - 1; i >= 0; i--) {
    let n = Number.parseInt(nums[i] ?? '0', 10)
    if (alternate) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alternate = !alternate
  }
  return sum % 10 === 0
}

function ibanCheck(input: string): boolean {
  const iban = input.replace(/\s/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false

  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`
  let remainder = 0
  for (const char of rearranged) {
    const value = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char
    for (const digit of value) {
      remainder = (remainder * 10 + Number.parseInt(digit, 10)) % 97
    }
  }
  return remainder === 1
}

export function myNumberCheck(input: string): boolean {
  const digits = input.replace(/[-\s]/g, '').split('').map((digit) => Number.parseInt(digit, 10))
  if (digits.length !== 12 || digits.some((digit) => !Number.isInteger(digit))) return false

  const weights = [6, 5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const sum = weights.reduce((acc, weight, index) => acc + weight * (digits[index] ?? 0), 0)
  const remainder = sum % 11
  const checkDigit = remainder <= 1 ? 0 : 11 - remainder
  return checkDigit === digits[11]
}

function jwtCheck(input: string): boolean {
  const [header] = input.split('.')
  if (!header) return false

  try {
    const decoded = Buffer.from(header, 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded) as Record<string, unknown>
    return typeof parsed['alg'] === 'string' && parsed['alg'].length > 0
  } catch {
    return false
  }
}

function shannonEntropy(input: string): number {
  const counts = new Map<string, number>()
  for (const char of input) counts.set(char, (counts.get(char) ?? 0) + 1)

  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / input.length
    entropy -= probability * Math.log2(probability)
  }
  return entropy
}

function highEntropySecretCheck(input: string): boolean {
  return input.length >= 20 && shannonEntropy(input) >= 3.5
}

function creditCardCheck(input: string): boolean {
  const digits = input.replace(/\D/gu, '')
  return !TEST_CARD_NUMBERS.has(digits) && luhnCheck(digits)
}

const TEST_CARD_NUMBERS = new Set([
  '4242424242424242',
  '4000000000000002',
  '4000000000009995',
  '4000000000003220',
  '5555555555554444',
  '2223003122003222',
])

const NON_PERSONAL_HOME_ACCOUNTS = new Set([
  'shared',
  'public',
  'default',
  'administrator',
  'admin',
  'user',
  'runner',
  'root',
])

function parseIPv4(input: string): readonly number[] | undefined {
  const parts = input.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined
  }
  return parts
}

function isPublicIPv4(input: string): boolean {
  if (isIP(input) !== 4) return false
  const octets = parseIPv4(input)
  if (!octets) return false
  const [first = 0, second = 0, third = 0] = octets

  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  )
}

function parseIPv6(input: string): bigint | undefined {
  if (isIP(input) !== 6) return undefined

  const halves = input.toLowerCase().split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missingGroups = 8 - left.length - right.length
  if ((halves.length === 1 && missingGroups !== 0) || (halves.length === 2 && missingGroups < 1)) {
    return undefined
  }

  const groups = [...left, ...Array.from({ length: missingGroups }, () => '0'), ...right]
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return undefined
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n)
}

function isInIPv6Prefix(address: bigint, prefix: string, prefixLength: number): boolean {
  const prefixAddress = parseIPv6(prefix)
  if (prefixAddress === undefined) return false
  const shift = BigInt(128 - prefixLength)
  return address >> shift === prefixAddress >> shift
}

function isPublicIPv6(input: string): boolean {
  const address = parseIPv6(input)
  if (address === undefined) return false

  // Only global-unicast space is eligible; exclude protocol, benchmark,
  // documentation, and transition ranges within it as well.
  if (!isInIPv6Prefix(address, '2000::', 3)) return false
  const reservedPrefixes: readonly (readonly [string, number])[] = [
    ['2001::', 23],
    ['2001:2::', 48],
    ['2001:10::', 28],
    ['2001:20::', 28],
    ['2001:db8::', 32],
    ['2002::', 16],
  ]
  return !reservedPrefixes.some(([prefix, length]) => isInIPv6Prefix(address, prefix, length))
}

function isHomeAccount(input: string): boolean {
  return !NON_PERSONAL_HOME_ACCOUNTS.has(input.toLowerCase())
}

function macAddressCheck(input: string): boolean {
  return /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/iu.test(input)
}

function withIndices(regex: RegExp): RegExp {
  return regex.flags.includes('d') ? new RegExp(regex.source, regex.flags) : new RegExp(regex.source, `${regex.flags}d`)
}

function getCustomFlags(flags: string | undefined): string {
  const allowed = new Set(['i', 's', 'u'])
  const selected = [...new Set([...(flags ?? '')].filter((flag) => allowed.has(flag)))].join('')
  return `g${selected}`
}

function normalizeDictionaryChar(char: string, caseSensitive: boolean): string {
  const code = char.charCodeAt(0)
  const halfWidth =
    code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : char
  return caseSensitive ? halfWidth : halfWidth.toLowerCase()
}

function buildDictionarySearchText(
  text: string,
  entry: DictionaryEntry,
): { readonly text: string; readonly indexMap: readonly number[] } {
  const indexMap: number[] = []
  let output = ''

  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? ''
    const normalized = entry.normalizeWidth
      ? normalizeDictionaryChar(char, entry.caseSensitive === true)
      : entry.caseSensitive === true
        ? char
        : char.toLowerCase()
    output += normalized
    indexMap.push(index)
  }

  return { text: output, indexMap }
}

function normalizeDictionaryNeedle(entry: DictionaryEntry): string {
  if (entry.normalizeWidth) {
    return [...entry.text]
      .map((char) => normalizeDictionaryChar(char, entry.caseSensitive === true))
      .join('')
  }
  return entry.caseSensitive === true ? entry.text : entry.text.toLowerCase()
}

function isDictionaryBoundary(char: string | undefined): boolean {
  return !char || !/[\p{Letter}\p{Number}_]/u.test(char)
}

function hasExactDictionaryBoundary(text: string, start: number, end: number): boolean {
  return isDictionaryBoundary(text[start - 1]) && isDictionaryBoundary(text[end])
}

const PATTERNS: readonly PatternDef[] = [
  {
    category: 'API_KEY',
    pattern:
      /\b(sk-(?:proj-|ant-)?[A-Za-z0-9\-]{20,}|gh[pous]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[bpras]-[A-Za-z0-9\-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35})\b/g,
  },
  {
    category: 'API_KEY',
    pattern:
      /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*([A-Za-z0-9/+=]{40})\b/g,
    captureGroup: 1,
  },
  {
    category: 'API_KEY',
    pattern: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]+?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g,
  },
  {
    category: 'API_KEY',
    pattern: /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    captureGroup: 1,
    validate: jwtCheck,
  },
  {
    category: 'API_KEY',
    pattern: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*([A-Za-z0-9+/_-]{20,}={0,2})(?![A-Za-z0-9+/_=-])/gi,
    captureGroup: 1,
    validate: highEntropySecretCheck,
  },
  { category: 'EMAIL', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  {
    category: 'CREDIT_CARD',
    pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    validate: creditCardCheck,
  },
  {
    category: 'MY_NUMBER',
    pattern: /\b\d{4}[-\s]\d{4}[-\s]\d{4}\b/g,
    validate: myNumberCheck,
    contextEnhancer: {
      boostWords: ['マイナンバー', '個人番号', '番号通知'],
      suppressWords: ['サンプル', '例', 'test'],
      boostAmount: 0.2,
      suppressAmount: 0.3,
      windowChars: 30,
    },
  },
  {
    category: 'MY_NUMBER',
    pattern: /(?:マイナンバー|個人番号)[:：]?\s*(\d{12}|\d{4}[-\s]\d{4}[-\s]\d{4})\b/g,
    captureGroup: 1,
    validate: myNumberCheck,
    contextEnhancer: {
      boostWords: ['マイナンバー', '個人番号', '番号通知'],
      suppressWords: ['サンプル', '例', 'test'],
      boostAmount: 0.2,
      suppressAmount: 0.3,
      windowChars: 30,
    },
  },
  {
    category: 'PHONE',
    pattern: /(?:\+81[-\s]?|0)\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}\b/g,
    validate: (match: string) => match.replace(/[-\s]/g, '').length >= 10,
    baseConfidence: 0.5,
    minimumConfidence: 0.7,
    contextEnhancer: {
      boostWords: ['電話', '電話番号', '携帯電話', 'TEL', 'tel', 'PHONE', '連絡先', 'Phone', 'phone'],
      suppressWords: ['サンプル', '例', 'test', 'example', 'dummy', 'xxx'],
      boostAmount: 0.2,
      suppressAmount: 0.3,
      windowChars: 30,
    },
  },
  {
    category: 'PHONE',
    pattern: /\+\d{1,3}[-\s]\d{1,14}(?:[-\s]\d{1,14}){0,4}\b/g,
    baseConfidence: 0.5,
    minimumConfidence: 0.7,
    contextEnhancer: {
      boostWords: ['電話', '電話番号', '携帯電話', 'TEL', 'tel', 'PHONE', '連絡先', 'Phone', 'phone'],
      suppressWords: ['サンプル', '例', 'test', 'example', 'dummy', 'xxx'],
      boostAmount: 0.2,
      suppressAmount: 0.3,
      windowChars: 30,
    },
  },
  {
    category: 'ADDRESS',
    pattern:
      /(?:北海道|東京都|(?:大阪|京都)府|.{2,3}県).{1,8}(?:市|区|町|村|郡).{1,20}?(?:\d{1,4}[-ー]\d{1,4}(?:[-ー]\d{1,4})?|[一二三四五六七八九十百]+丁目)/g,
  },
  {
    category: 'ADDRESS',
    pattern:
      /(?:[一二三四五六七八九十百千〇零\d]+丁目)?[一二三四五六七八九十百千〇零\d]+番(?:地)?(?:[一二三四五六七八九十百千〇零\d]+号)?/g,
  },
  {
    category: 'ADDRESS',
    pattern:
      /\d{1,4}[-ー]\d{1,4}(?:[-ー]\d{1,4})?\s*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9ー・\-\s]{2,30}(?:マンション|アパート|ハイツ|コーポ|レジデンス|ビル|タワー|荘)\s*\d{1,4}(?:号室|号)?/gu,
  },
  {
    category: 'URL_USER',
    pattern: /https?:\/\/[^\s/@]+:[^\s/@]+@[^\s/]+/g,
  },
  {
    category: 'NAME',
    pattern: /(?:Author|Committer):\s+(.+?)\s+<[^>]+>/g,
    captureGroup: 1,
    defaultAction: 'warn',
  },
  {
    category: 'SSN',
    pattern: /\b(?!000|666|9\d{2})\d{3}[-\s]?(?!00)\d{2}[-\s]?(?!0000)\d{4}\b/g,
  },
  {
    category: 'IP_ADDRESS',
    pattern:
      /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    validate: isPublicIPv4,
  },
  {
    category: 'IP_ADDRESS',
    pattern: /(?<![0-9a-fA-F:])(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}(?![0-9a-fA-F:])/g,
    validate: isPublicIPv6,
  },
  {
    category: 'IP_ADDRESS',
    pattern: /(?<![0-9a-fA-F:])(?:[0-9a-fA-F]{1,4}:){0,7}:(?:[0-9a-fA-F]{1,4}:?){0,7}(?![0-9a-fA-F:])/g,
    validate: isPublicIPv6,
  },
  {
    category: 'POSTAL_CODE',
    pattern: /〒\d{3}-\d{4}/g,
  },
  {
    category: 'POSTAL_CODE',
    pattern: /(?:郵便番号|ZIP(?:\s*code)?)[:：\s]+(\d{3}-\d{4})/gi,
    captureGroup: 1,
  },
  {
    category: 'IBAN',
    pattern: /\b[A-Z]{2}\d{2}(?:[\s-]?[A-Z0-9]){11,30}\b/g,
    validate: ibanCheck,
  },
  {
    category: 'BANK_ACCOUNT',
    pattern:
      /(?:金融機関コード|銀行コード)[:：]?\s*\d{4}[、,\s]+(?:支店コード|支店番号)[:：]?\s*\d{3}[、,\s]+(?:口座番号)[:：]?\s*\d{7}\b/g,
    contextEnhancer: {
      boostWords: ['口座', '振込', '銀行', '口座番号'],
      suppressWords: ['サンプル', '例', 'test'],
      boostAmount: 0.2,
      suppressAmount: 0.3,
      windowChars: 30,
    },
  },
  {
    category: 'BANK_ACCOUNT',
    pattern: /(?:口座番号)[:：]?\s*(普通|当座)?\s*\d{7}\b/g,
    contextEnhancer: {
      boostWords: ['口座', '振込', '銀行', '口座番号'],
      suppressWords: ['サンプル', '例', 'test'],
      boostAmount: 0.2,
      suppressAmount: 0.3,
      windowChars: 30,
    },
  },
  {
    category: 'DRIVER_LICENSE',
    pattern: /(?:運転免許証番号|免許証番号|免許番号)[:：]?\s*(\d{12}|\d{2}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{2})\b/g,
    captureGroup: 1,
  },
  {
    category: 'PASSPORT',
    pattern: /(?:旅券番号|パスポート番号|Passport(?: No\.| Number)?)[:：]?\s*([A-Z]{2}\d{7}|\d{9})\b/gi,
    captureGroup: 1,
  },
  {
    category: 'CRYPTO_WALLET',
    pattern: /\b(?:bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|0x[a-fA-F0-9]{40})\b/g,
  },
  {
    category: 'DATE_TIME',
    pattern:
      /(?:生年月日|誕生日|Birthday|DOB|Date of Birth)[:：]?\s*((?:\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2})|(?:\d{4}年\d{1,2}月\d{1,2}日)|(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4})|(?:[A-Z][a-z]+ \d{1,2}, \d{4})|(?:(?:明治|大正|昭和|平成|令和)\d{1,2}年\d{1,2}月\d{1,2}日))/g,
    captureGroup: 1,
  },
  {
    category: 'MEDICAL_RECORD',
    pattern: /(?:診察券番号|患者番号|カルテ番号|医療記録番号)[:：]?\s*([A-Z0-9-]{6,20})\b/gi,
    captureGroup: 1,
  },
  {
    category: 'HEALTH_INSURANCE',
    pattern:
      /(?:保険証番号|健康保険証番号)[:：]?\s*(?:記号\s*)?([A-Z0-9-]{2,12})[、,\s]+(?:番号\s*)?([A-Z0-9-]{2,12})/gi,
  },
  {
    category: 'HEALTH_INSURANCE',
    pattern: /(?:保険証番号|健康保険証番号)[:：]?\s*(\d{8})\b/g,
    captureGroup: 1,
  },
  {
    category: 'HEALTH_INSURANCE',
    pattern: /(?:被保険者番号)[:：]?\s*([A-Z0-9-]{6,20})\b/gi,
    captureGroup: 1,
  },
  {
    category: 'MEDICAL_RECORD',
    pattern: /(?:医師免許証番号|医師免許番号)[:：]?\s*(\d{6})\b/g,
    captureGroup: 1,
  },
  {
    category: 'USERNAME',
    pattern: /(?<!\w)@([A-Za-z0-9_-]{3,30})\b/g,
    captureGroup: 1,
  },
  {
    category: 'CREDENTIAL_PAIR',
    pattern: /(?<!\w:\/\/)\b([A-Za-z0-9._-]{2,64}):([A-Za-z0-9!@#$%^&*_+=-]{4,128})(?=\s|$)/g,
  },
  {
    category: 'PASSWORD',
    pattern: /(?:password|passwd|pwd|pass)\s*[:=]\s*["']?([^\s"',;]{4,128})/gi,
    captureGroup: 1,
  },
  {
    category: 'CREDENTIAL_PAIR',
    pattern: /Authorization\s*:\s*Basic\s+([A-Za-z0-9+/]{8,}={0,2})/gi,
    captureGroup: 1,
  },
  {
    category: 'CREDENTIAL_PAIR',
    pattern: /(?:cookie|set-cookie|session[_-]?id)\s*[:=]\s*([^;\s,]{8,128})/gi,
    captureGroup: 1,
  },
  {
    category: 'HOME_PATH',
    pattern: /(?:\/Users\/|\/home\/)([^/\\\s"'<>]+)/g,
    captureGroup: 1,
    validate: isHomeAccount,
  },
  {
    category: 'HOME_PATH',
    pattern: /[A-Za-z]:\\Users\\([^\\/\s"'<>]+)/gi,
    captureGroup: 1,
    validate: isHomeAccount,
  },
  {
    category: 'MAC_ADDRESS',
    pattern: /(?:MAC(?: address)?|BSSID)[:=\s]+((?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2})/gi,
    captureGroup: 1,
    validate: macAddressCheck,
  },
  {
    category: 'DEVICE_ID',
    pattern: /(?:MEID|device[_ -]?id|端末識別子)[:：\s]+([A-F0-9-]{8,32})/gi,
    captureGroup: 1,
  },
  {
    category: 'DEVICE_ID',
    pattern: /(?:IMEI|International Mobile Equipment Identity)[:：\s]+(\d{15})/gi,
    captureGroup: 1,
    validate: luhnCheck,
  },
]

export function detectDictionaryPII(
  text: string,
  enabledCategories: readonly PIICategory[],
  dictionary: readonly DictionaryEntry[],
): readonly PIIMatch[] {
  const categorySet = new Set(enabledCategories)
  const matches: PIIMatch[] = []

  for (const entry of dictionary) {
    if (!categorySet.has(entry.category)) continue
    if (!entry.text) continue

    const searchable = buildDictionarySearchText(text, entry)
    const needle = normalizeDictionaryNeedle(entry)
    if (!needle) continue

    let start = 0
    while (true) {
      const idx = searchable.text.indexOf(needle, start)
      if (idx === -1) break
      const originalStart = searchable.indexMap[idx] ?? idx
      const lastNeedleIndex = idx + needle.length - 1
      const originalEnd = (searchable.indexMap[lastNeedleIndex] ?? lastNeedleIndex) + 1

      if (
        entry.matchMode !== 'exact' ||
        hasExactDictionaryBoundary(text, originalStart, originalEnd)
      ) {
        matches.push({
          text: text.slice(originalStart, originalEnd),
          category: entry.category,
          start: originalStart,
          end: originalEnd,
          confidence: 0.9,
        })
      }

      start = idx + Math.max(needle.length, 1)
    }
  }

  return matches.sort((a, b) => b.start - a.start)
}

export function detectRegexPII(
  text: string,
  enabledCategories: readonly PIICategory[],
  customPatterns: readonly CustomPatternEntry[] = [],
): readonly PIIMatch[] {
  const categorySet = new Set(enabledCategories)
  const matches: PIIMatch[] = []
  const searchable = buildNormalizedSearchText(text)

  for (const def of PATTERNS) {
    if (!categorySet.has(def.category)) continue

    const regex = withIndices(def.pattern)
    let m: RegExpExecArray | null
    while ((m = regex.exec(searchable.text)) !== null) {
      const group = def.captureGroup ?? 0
      const normalizedText = m[group] ?? m[0]
      if (!normalizedText) continue
      const groupIndex = m.indices?.[group]
      const normalizedStart = groupIndex?.[0] ?? m.index
      const normalizedEnd = groupIndex?.[1] ?? normalizedStart + normalizedText.length
      const { start, end } = mapNormalizedRange(searchable, normalizedStart, normalizedEnd, text.length)
      const matchText = text.slice(start, end)
      if (!matchText || (def.validate && !def.validate(normalizedText))) continue

      const baseConfidence = def.baseConfidence ?? 1
      const confidence = def.contextEnhancer
        ? applyContextEnhancer(text, start, end, def.contextEnhancer, baseConfidence)
        : baseConfidence
      if (def.minimumConfidence !== undefined && confidence < def.minimumConfidence) continue

      matches.push({
        text: matchText,
        category: def.category,
        start,
        end,
        confidence,
        ...(def.defaultAction ? { suggestedAction: def.defaultAction } : {}),
      })
    }
  }

  for (const custom of customPatterns) {
    const category = custom.category ?? custom.name
    if (!categorySet.has(category)) continue

    try {
      const regex = withIndices(new RegExp(custom.pattern, getCustomFlags(custom.flags)))
      let m: RegExpExecArray | null
      while ((m = regex.exec(searchable.text)) !== null) {
        if (!m[0]) {
          regex.lastIndex += 1
          continue
        }

        const group = custom.captureGroup ?? 0
        const normalizedText = m[group] ?? m[0]
        const groupIndex = m.indices?.[group]
        const normalizedStart = groupIndex?.[0] ?? m.index
        const normalizedEnd = groupIndex?.[1] ?? normalizedStart + normalizedText.length
        const { start, end } = mapNormalizedRange(searchable, normalizedStart, normalizedEnd, text.length)
        const matchText = text.slice(start, end)
        if (!normalizedText || !matchText) continue

        const hasCustomContext =
          (custom.contextWords && custom.contextWords.length > 0) ||
          (custom.suppressWords && custom.suppressWords.length > 0)
        const customConfidence = hasCustomContext
          ? applyContextEnhancer(
              text,
              start,
              end,
              {
                boostWords: custom.contextWords ?? [],
                suppressWords: custom.suppressWords ?? [],
                boostAmount: 0.2,
                suppressAmount: 0.2,
                windowChars: 30,
              },
              1,
            )
          : 1

        matches.push({
          text: matchText,
          category,
          start,
          end,
          confidence: customConfidence,
        })
      }
    } catch {
      // Ignore invalid custom patterns
    }
  }

  return matches.sort((a, b) => b.start - a.start)
}

export function applyReplacements(
  text: string,
  matches: readonly PIIMatch[],
  register: (match: PIIMatch) => string,
): string {
  // Resolve overlaps before editing so one PII value never turns into nested placeholders.
  const winners = selectNonOverlappingMatches(matches)
  let result = text

  for (const match of winners) {
    const placeholder = register(match)
    result = result.slice(0, match.start) + placeholder + result.slice(match.end)
  }

  return result
}
