import type { DictionaryEntry, PIICategory, PIIMatch } from './types.js'

type PatternDef = {
  readonly category: PIICategory
  readonly pattern: RegExp
  readonly validate?: (match: string) => boolean
  readonly captureGroup?: number
}

function selectNonOverlappingMatches(matches: readonly PIIMatch[]): readonly PIIMatch[] {
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
    let start = 0
    while (true) {
      const idx = text.indexOf(entry.text, start)
      if (idx === -1) break
      matches.push({
        text: entry.text,
        category: entry.category,
        start: idx,
        end: idx + entry.text.length,
      })
      start = idx + entry.text.length
    }
  }

  return matches.sort((a, b) => b.start - a.start)
}

export function detectRegexPII(
  text: string,
  enabledCategories: readonly PIICategory[],
  customPatterns: readonly { readonly name: string; readonly pattern: string }[] = [],
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
      })
    }
  }

  for (const custom of customPatterns) {
    try {
      const regex = new RegExp(custom.pattern, 'g')
      let m: RegExpExecArray | null
      while ((m = regex.exec(text)) !== null) {
        matches.push({
          text: m[0],
          category: 'NAME',
          start: m.index,
          end: m.index + m[0].length,
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
  register: (original: string, category: PIICategory) => string,
): string {
  // Resolve overlaps before editing so one PII value never turns into nested placeholders.
  const winners = selectNonOverlappingMatches(matches)
  let result = text

  for (const match of winners) {
    const placeholder = register(match.text, match.category)
    result = result.slice(0, match.start) + placeholder + result.slice(match.end)
  }

  return result
}
