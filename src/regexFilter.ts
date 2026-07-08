import type { CustomPatternEntry, DictionaryEntry, PIICategory, PIIMatch } from './types.js'

type PatternDef = {
  readonly category: PIICategory
  readonly pattern: RegExp
  readonly validate?: (match: string) => boolean
  readonly captureGroup?: number
}

export function selectNonOverlappingMatches(matches: readonly PIIMatch[]): readonly PIIMatch[] {
  const sorted = [...matches].sort(
    (left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start),
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

function luhnCheck(digits: string): boolean {
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
      /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|AKIA[0-9A-Z]{16}|xox[bpras]-[A-Za-z0-9\-]{10,}|sk-ant-[A-Za-z0-9\-]{20,})\b/g,
  },
  { category: 'EMAIL', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  {
    category: 'CREDIT_CARD',
    pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    validate: luhnCheck,
  },
  { category: 'MY_NUMBER', pattern: /\b\d{4}[-\s]\d{4}[-\s]\d{4}\b/g },
  {
    category: 'MY_NUMBER',
    pattern: /(?:マイナンバー|個人番号)[:：]?\s*(\d{12}|\d{4}[-\s]\d{4}[-\s]\d{4})\b/g,
    captureGroup: 1,
  },
  {
    category: 'PHONE',
    pattern: /(?:\+81[-\s]?|0)\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}\b/g,
    validate: (match: string) => match.replace(/[-\s]/g, '').length >= 10,
  },
  {
    category: 'PHONE',
    pattern: /\+\d{1,3}[-\s]\d{1,14}(?:[-\s]\d{1,14}){0,4}\b/g,
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
  },
  {
    category: 'SSN',
    pattern: /\b(?!000|666|9\d{2})\d{3}[-\s]?(?!00)\d{2}[-\s]?(?!0000)\d{4}\b/g,
  },
  {
    category: 'IP_ADDRESS',
    pattern:
      /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
  },
  {
    category: 'IP_ADDRESS',
    pattern:
      /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
  },
  {
    category: 'POSTAL_CODE',
    pattern: /〒\d{3}-\d{4}/g,
  },
  {
    category: 'POSTAL_CODE',
    pattern: /\b\d{3}-\d{4}(?=\s*(?:$|[^\d]))/g,
    validate: (match: string) => !/^\d{3}-\d{2}-\d{4}$/.test(match),
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
  },
  {
    category: 'BANK_ACCOUNT',
    pattern: /(?:口座番号)[:：]?\s*(普通|当座)?\s*\d{7}\b/g,
  },
  {
    category: 'DRIVER_LICENSE',
    pattern: /(?:運転免許証番号|免許証番号|免許番号)[:：]?\s*(\d{12})\b/g,
    captureGroup: 1,
  },
  {
    category: 'PASSPORT',
    pattern: /(?:旅券番号|パスポート番号|Passport(?: No\.)?)[:：]?\s*([A-Z]{2}\d{7})\b/gi,
    captureGroup: 1,
  },
  {
    category: 'CRYPTO_WALLET',
    pattern: /\b(?:bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|0x[a-fA-F0-9]{40})\b/g,
  },
  {
    category: 'DATE_TIME',
    pattern:
      /(?:生年月日|誕生日|DOB|Date of Birth)[:：]?\s*((?:\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2})|(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4})|(?:(?:明治|大正|昭和|平成|令和)\d{1,2}年\d{1,2}月\d{1,2}日))/gi,
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

  for (const def of PATTERNS) {
    if (!categorySet.has(def.category)) continue

    const regex = new RegExp(def.pattern.source, def.pattern.flags)
    let m: RegExpExecArray | null
    while ((m = regex.exec(text)) !== null) {
      const group = def.captureGroup ?? 0
      const matchText = m[group] ?? m[0]
      if (!matchText) continue
      if (def.validate && !def.validate(matchText)) continue

      const start =
        group > 0 && m[group] ? m.index + m[0].indexOf(m[group]) : m.index

      matches.push({
        text: matchText,
        category: def.category,
        start,
        end: start + matchText.length,
        confidence: 1,
      })
    }
  }

  for (const custom of customPatterns) {
    const category = custom.category ?? custom.name
    if (!categorySet.has(category)) continue

    try {
      const regex = new RegExp(custom.pattern, 'g')
      let m: RegExpExecArray | null
      while ((m = regex.exec(text)) !== null) {
        if (!m[0]) {
          regex.lastIndex += 1
          continue
        }

        matches.push({
          text: m[0],
          category,
          start: m.index,
          end: m.index + m[0].length,
          confidence: 1,
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
