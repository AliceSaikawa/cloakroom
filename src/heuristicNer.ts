// Zero-dependency heuristic NER for NAME/ORG/SCHOOL. Runs entirely on static
// dictionaries and regular expressions (src/heuristicNerData.ts) so cloakroom can
// mask common Japanese proper nouns without Ollama or any other runtime dependency.
import {
  GENERIC_SCHOOL_PREFIXES,
  HONORIFICS,
  NON_NAME_BEFORE_HONORIFIC,
  ORG_LEGAL_FORMS,
  SCHOOL_SUFFIXES,
  SURNAMES_JA,
  SURNAMES_ROMAJI,
} from './heuristicNerData.js'
import type { PIICategory, PIIMatch } from './types.js'

const SURNAME_SET = new Set(SURNAMES_JA)
const ROMAJI_SURNAME_SET = new Set(SURNAMES_ROMAJI)

const MAX_ORG_NAME_LENGTH = 20
const MAX_SCHOOL_PREFIX_LENGTH = 12

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Honorifics/surnames are pre-sorted longest-first so alternation doesn't stop at a
// shorter option when a longer one also matches at the same position.
const HONORIFIC_PATTERN = new RegExp(
  [...HONORIFICS].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'),
  'g',
)

const SURNAME_PATTERN = new RegExp(
  [...SURNAMES_JA].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'),
  'g',
)

const STOP_AFTER_SURNAME = [...HONORIFICS, 'は', 'が', 'を', 'に', 'と', 'で', 'も', 'の', 'や', 'へ']
  .sort((a, b) => b.length - a.length)

const NAME_LABEL_PATTERN =
  /(?:氏名|名前|担当者|担当|宛名|お名前|申請者|報告者|作成者|承認者|受取人|依頼主)[:：]\s*([^\s、。,.!?:：;；[\]]{2,20})/g

const ROMAJI_NAME_PATTERN = /\b[A-Z][a-z]{1,15} [A-Z][a-z]{1,15}\b/g

const ORG_ENGLISH_PATTERN =
  /\b[A-Z][A-Za-z0-9&.-]*(?:[ ][A-Z][A-Za-z0-9&.-]*){0,3},?[ ](?:Inc|Corp|Corporation|LLC|Ltd|GmbH|K\.K)\.?(?=\b)/g

const HAN_CHAR = /\p{Script=Han}/u
const KANA_CHAR = /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u
const KANJI_RUN = /^\p{Script=Han}{1,3}/u
const KANA_RUN = /^[\p{Script=Hiragana}\p{Script=Katakana}ー]{2,4}/u

// Org/school proper-noun charsets deliberately exclude hiragana. Japanese particles
// (は/が/を/に/と/で/も/の...) are hiragana, and including them here would let a
// greedy backward/forward scan swallow unrelated leading text (e.g. "私はX社" could
// otherwise capture "私は" as part of the name). Excluding hiragana trades a little
// recall (rare hiragana-only company/school names) for avoiding that failure mode.
const ORG_NAME_CHAR = /[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9・ー]/u
const SCHOOL_NAME_CHAR = /[\p{Script=Han}\p{Script=Katakana}A-Za-z]/u
const SCHOOL_SUFFIX_CONTINUATION = /[\p{Script=Han}\p{Script=Katakana}A-Za-z]/u

function clonePattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags)
}

function findPlaceholderRanges(text: string): ReadonlyArray<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = []
  const pattern = /\[[^[\]]*\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    ranges.push([match.index, match.index + match[0].length])
  }
  return ranges
}

function overlapsPlaceholder(
  start: number,
  end: number,
  ranges: ReadonlyArray<readonly [number, number]>,
): boolean {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart)
}

// R1/R2: surname (or surname-shaped kanji run) immediately before an honorific.
function detectNameHonorifics(text: string, ranges: ReadonlyArray<readonly [number, number]>): PIIMatch[] {
  const matches: PIIMatch[] = []
  const pattern = clonePattern(HONORIFIC_PATTERN)
  let m: RegExpExecArray | null

  while ((m = pattern.exec(text)) !== null) {
    const honorificStart = m.index
    if (overlapsPlaceholder(honorificStart, honorificStart + m[0].length, ranges)) continue

    let hanStart = honorificStart
    while (hanStart > 0 && HAN_CHAR.test(text[hanStart - 1] ?? '')) hanStart--
    const hanRun = text.slice(hanStart, honorificStart)
    if (hanRun.length === 0) continue

    let matchedR1 = false
    for (let len = Math.min(3, hanRun.length); len >= 1; len--) {
      const candidate = hanRun.slice(hanRun.length - len)
      if (!SURNAME_SET.has(candidate)) continue

      const start = honorificStart - len
      if (!overlapsPlaceholder(start, honorificStart, ranges)) {
        matches.push({ text: candidate, category: 'NAME', start, end: honorificStart, confidence: 0.9 })
      }
      matchedR1 = true
      break
    }

    if (matchedR1 || hanRun.length < 2) continue

    const len = Math.min(3, hanRun.length)
    const candidate = hanRun.slice(hanRun.length - len)
    const start = honorificStart - len

    const denylisted = NON_NAME_BEFORE_HONORIFIC.some(
      (entry) => entry.length > 0 && text.slice(honorificStart - entry.length, honorificStart) === entry,
    )
    if (denylisted) continue
    if (overlapsPlaceholder(start, honorificStart, ranges)) continue

    matches.push({ text: candidate, category: 'NAME', start, end: honorificStart, confidence: 0.75 })
  }

  return matches
}

// R3: surname + short given name (kanji or kana), ending at a word boundary.
function detectFullNames(text: string, ranges: ReadonlyArray<readonly [number, number]>): PIIMatch[] {
  const matches: PIIMatch[] = []
  const pattern = clonePattern(SURNAME_PATTERN)
  let m: RegExpExecArray | null

  while ((m = pattern.exec(text)) !== null) {
    const surname = m[0]
    const surnameStart = m.index
    const surnameEnd = surnameStart + surname.length
    if (overlapsPlaceholder(surnameStart, surnameEnd, ranges)) continue

    let cursor = surnameEnd
    if (text[cursor] === ' ' || text[cursor] === '　') cursor += 1

    const rest = text.slice(cursor)
    if (STOP_AFTER_SURNAME.some((prefix) => rest.startsWith(prefix))) continue

    const kanjiMatch = KANJI_RUN.exec(rest)
    const kanaMatch = kanjiMatch ? null : KANA_RUN.exec(rest)
    const givenName = kanjiMatch?.[0] ?? kanaMatch?.[0]
    if (!givenName) continue

    const nextChar = rest[givenName.length]
    const boundaryOk = kanjiMatch ? !nextChar || !HAN_CHAR.test(nextChar) : !nextChar || !KANA_CHAR.test(nextChar)
    if (!boundaryOk) continue

    const end = cursor + givenName.length
    if (overlapsPlaceholder(surnameStart, end, ranges)) continue

    matches.push({
      text: text.slice(surnameStart, end),
      category: 'NAME',
      start: surnameStart,
      end,
      confidence: 0.8,
    })
  }

  return matches
}

// R4: labeled context, e.g. "氏名: 珍名一郎".
function detectLabeledNames(text: string, ranges: ReadonlyArray<readonly [number, number]>): PIIMatch[] {
  const matches: PIIMatch[] = []
  const pattern = clonePattern(NAME_LABEL_PATTERN)
  let m: RegExpExecArray | null

  while ((m = pattern.exec(text)) !== null) {
    const captured = m[1]
    if (!captured) continue

    const start = m.index + m[0].length - captured.length
    const end = start + captured.length
    if (overlapsPlaceholder(start, end, ranges)) continue

    matches.push({ text: captured, category: 'NAME', start, end, confidence: 0.85 })
  }

  return matches
}

// R5: "Taro Yamada" style romaji names, where either token is a known surname.
function detectRomajiNames(text: string, ranges: ReadonlyArray<readonly [number, number]>): PIIMatch[] {
  const matches: PIIMatch[] = []
  const pattern = clonePattern(ROMAJI_NAME_PATTERN)
  let m: RegExpExecArray | null

  while ((m = pattern.exec(text)) !== null) {
    const [first, second] = m[0].split(' ')
    if (!first || !second) continue
    if (!ROMAJI_SURNAME_SET.has(first.toLowerCase()) && !ROMAJI_SURNAME_SET.has(second.toLowerCase())) continue

    const start = m.index
    const end = start + m[0].length
    if (overlapsPlaceholder(start, end, ranges)) continue

    matches.push({ text: m[0], category: 'NAME', start, end, confidence: 0.8 })
  }

  return matches
}

function extendForward(text: string, from: number, maxLength: number, charClass: RegExp): number {
  let end = from
  while (end < text.length && end - from < maxLength && charClass.test(text[end] ?? '')) end++
  return end
}

function extendBackward(text: string, from: number, maxLength: number, charClass: RegExp): number {
  let start = from
  while (start > 0 && from - start < maxLength && charClass.test(text[start - 1] ?? '')) start--
  return start
}

// ORG: legal form (株式会社 etc.) immediately before or after a proper noun.
function detectOrgLegalForms(text: string, ranges: ReadonlyArray<readonly [number, number]>): PIIMatch[] {
  const matches: PIIMatch[] = []

  for (const form of ORG_LEGAL_FORMS) {
    // Prefix form: 株式会社XXX
    for (let searchFrom = 0; ; ) {
      const idx = text.indexOf(form, searchFrom)
      if (idx === -1) break
      searchFrom = idx + form.length
      const formEnd = idx + form.length

      const nameEnd = extendForward(text, formEnd, MAX_ORG_NAME_LENGTH, ORG_NAME_CHAR)
      const name = text.slice(formEnd, nameEnd)
      if (name.length < 2) continue
      if (overlapsPlaceholder(idx, nameEnd, ranges)) continue

      matches.push({ text: text.slice(idx, nameEnd), category: 'ORG', start: idx, end: nameEnd, confidence: 0.9 })
    }

    // Suffix form: XXX株式会社
    for (let searchFrom = 0; ; ) {
      const idx = text.indexOf(form, searchFrom)
      if (idx === -1) break
      searchFrom = idx + form.length
      const formEnd = idx + form.length

      const nameStart = extendBackward(text, idx, MAX_ORG_NAME_LENGTH, ORG_NAME_CHAR)
      const name = text.slice(nameStart, idx)
      if (name.length < 2) continue
      if (overlapsPlaceholder(nameStart, formEnd, ranges)) continue

      matches.push({
        text: text.slice(nameStart, formEnd),
        category: 'ORG',
        start: nameStart,
        end: formEnd,
        confidence: 0.9,
      })
    }
  }

  return matches
}

function detectEnglishOrgs(text: string, ranges: ReadonlyArray<readonly [number, number]>): PIIMatch[] {
  const matches: PIIMatch[] = []
  const pattern = clonePattern(ORG_ENGLISH_PATTERN)
  let m: RegExpExecArray | null

  while ((m = pattern.exec(text)) !== null) {
    const start = m.index
    const end = start + m[0].length
    if (overlapsPlaceholder(start, end, ranges)) continue

    matches.push({ text: m[0], category: 'ORG', start, end, confidence: 0.85 })
  }

  return matches
}

// SCHOOL: proper noun + school suffix, resolving overlapping suffixes (大学院大学
// vs 大学) by keeping the longest suffix that ends at a given position.
function detectSchools(text: string, ranges: ReadonlyArray<readonly [number, number]>): PIIMatch[] {
  const bestByEnd = new Map<number, { readonly start: number; readonly length: number }>()

  for (const suffix of SCHOOL_SUFFIXES) {
    for (let searchFrom = 0; ; ) {
      const idx = text.indexOf(suffix, searchFrom)
      if (idx === -1) break
      searchFrom = idx + 1 // allow overlapping occurrences, e.g. 大学 inside 大学院大学

      const end = idx + suffix.length
      const existing = bestByEnd.get(end)
      if (!existing || suffix.length > existing.length) {
        bestByEnd.set(end, { start: idx, length: suffix.length })
      }
    }
  }

  const matches: PIIMatch[] = []
  for (const [end, { start }] of bestByEnd) {
    const nextChar = text[end]
    if (nextChar && SCHOOL_SUFFIX_CONTINUATION.test(nextChar)) continue

    const prefixStart = extendBackward(text, start, MAX_SCHOOL_PREFIX_LENGTH, SCHOOL_NAME_CHAR)
    const prefix = text.slice(prefixStart, start)
    if (prefix.length < 2) continue
    if (GENERIC_SCHOOL_PREFIXES.includes(prefix)) continue
    if (overlapsPlaceholder(prefixStart, end, ranges)) continue

    matches.push({
      text: text.slice(prefixStart, end),
      category: 'SCHOOL',
      start: prefixStart,
      end,
      confidence: 0.85,
    })
  }

  return matches
}

export function detectHeuristicPII(text: string, categories: readonly PIICategory[]): readonly PIIMatch[] {
  if (!text) return []

  const categorySet = new Set(categories)
  const wantsName = categorySet.has('NAME')
  const wantsOrg = categorySet.has('ORG')
  const wantsSchool = categorySet.has('SCHOOL')
  if (!wantsName && !wantsOrg && !wantsSchool) return []

  const ranges = findPlaceholderRanges(text)
  const matches: PIIMatch[] = []

  // ORG/SCHOOL run first: a legal-form or school suffix is stronger evidence
  // than a name-shaped kanji run, so a span like 東都大学 (surname 東 + given-name
  // pattern 都大学) must resolve to SCHOOL/ORG, not NAME. Overlapping NAME
  // candidates are dropped below.
  if (wantsOrg) {
    matches.push(...detectOrgLegalForms(text, ranges))
    matches.push(...detectEnglishOrgs(text, ranges))
  }

  if (wantsSchool) {
    matches.push(...detectSchools(text, ranges))
  }

  if (wantsName) {
    const claimed = matches.map((match) => [match.start, match.end] as const)
    const nameMatches = [
      ...detectNameHonorifics(text, ranges),
      ...detectFullNames(text, ranges),
      ...detectLabeledNames(text, ranges),
      ...detectRomajiNames(text, ranges),
    ].filter((match) => !claimed.some(([start, end]) => match.start < end && match.end > start))
    matches.push(...nameMatches)
  }

  return matches
}
