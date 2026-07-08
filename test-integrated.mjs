// Integrated PII filter test: regex + Ollama pipeline (matches real behavior)
import { createHash } from 'node:crypto'

const ENDPOINT = 'http://localhost:11434'
const MODEL = 'gemma3:4b'
const JP_HONORIFICS = /(?:さん|さま|様|殿|氏|先生|くん|君|ちゃん|先輩|後輩|部長|課長|社長|会長|教授|博士)$/

// ---- Regex patterns (mirror regexFilter.ts) ----
const REGEX_PATTERNS = [
  { category: 'API_KEY', pattern: /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|AKIA[0-9A-Z]{16})\b/g },
  { category: 'EMAIL', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { category: 'CREDIT_CARD', pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g },
  { category: 'MY_NUMBER', pattern: /\b\d{4}[-\s]\d{4}[-\s]\d{4}\b/g },
  { category: 'PHONE', pattern: /(?:\+81[-\s]?|0)\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}\b/g },
  { category: 'PHONE', pattern: /\+\d{1,3}[-\s]\d{1,14}(?:[-\s]\d{1,14}){0,4}\b/g },
  { category: 'ADDRESS', pattern: /(?:北海道|東京都|(?:大阪|京都)府|.{2,3}県).{1,8}(?:市|区|町|村|郡).{1,20}?(?:\d{1,4}[-ー]\d{1,4}(?:[-ー]\d{1,4})?|[一二三四五六七八九十百]+丁目)/g },
  { category: 'NAME', pattern: /(?:Author|Committer):\s+(.+?)\s+<[^>]+>/g, captureGroup: 1 },
]

// ---- Mapping table ----
const origToPlaceholder = new Map()
const placeholderToOrig = new Map()
const counters = new Map()

function register(original, category) {
  if (origToPlaceholder.has(original)) return origToPlaceholder.get(original)
  const count = (counters.get(category) ?? 0) + 1
  counters.set(category, count)
  const ph = `[${category}_${count}]`
  origToPlaceholder.set(original, ph)
  placeholderToOrig.set(ph, original)
  return ph
}

// ---- Phase 1: Regex ----
function regexFilter(text) {
  const matches = []
  for (const def of REGEX_PATTERNS) {
    const regex = new RegExp(def.pattern.source, def.pattern.flags)
    let m
    while ((m = regex.exec(text)) !== null) {
      const group = def.captureGroup ?? 0
      const matchText = m[group] ?? m[0]
      const start = group > 0 && m[group] ? m.index + m[0].indexOf(m[group]) : m.index
      matches.push({ text: matchText, category: def.category, start, end: start + matchText.length })
    }
  }
  matches.sort((a, b) => b.start - a.start)
  let result = text
  for (const match of matches) {
    const ph = register(match.text, match.category)
    result = result.slice(0, match.start) + ph + result.slice(match.end)
  }
  return result
}

// ---- Phase 2: Ollama ----
const OLLAMA_SYSTEM = `You are a PII detector. Extract person names, organization names, and school names from the text.

Output: JSON array only. No markdown fences, no explanation.
Format: [{"text": "exact name", "category": "NAME"|"ORG"|"SCHOOL", "block": N}]

NAME rules:
- Extract the name WITHOUT honorifics/suffixes. "田中太郎さん" → "田中太郎", "Mr. Smith" → "Smith", "鈴木先生" → "鈴木"
- Include full names and family names
- Do NOT extract: pronouns, generic roles

ORG rules:
- Company names, government agencies, well-known organizations
- Do NOT extract: product names, programming terms, package names

SCHOOL rules:
- Universities, schools
- Do NOT extract: online platforms, generic "school"

EXCLUDE: file paths, URLs, email addresses, function/variable names, strings in [BRACKETS], common nouns.
If no PII found, return []`

async function ollamaFilter(text) {
  try {
    const response = await fetch(`${ENDPOINT}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: OLLAMA_SYSTEM },
          { role: 'user', content: `---BLOCK_0---\n${text}` },
        ],
        stream: false,
        options: { temperature: 0, num_predict: 2048 },
      }),
      signal: AbortSignal.timeout(30000),
    })
    const data = await response.json()
    const content = data.message?.content ?? ''
    const cleaned = content.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim()
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return text

    const detections = JSON.parse(jsonMatch[0])
    const matches = []
    for (const d of detections) {
      if (!d.text || !d.category) continue
      if (d.text.includes('@') || d.text.startsWith('http') || /^\[/.test(d.text)) continue
      let t = d.category === 'NAME' ? d.text.replace(JP_HONORIFICS, '').trim() : d.text
      if (!t) continue
      const idx = text.indexOf(t)
      if (idx >= 0) matches.push({ text: t, category: d.category, start: idx, end: idx + t.length })
    }
    matches.sort((a, b) => b.start - a.start)
    let result = text
    for (const match of matches) {
      const ph = register(match.text, match.category)
      result = result.slice(0, match.start) + ph + result.slice(match.end)
    }
    return result
  } catch { return text }
}

// ---- Full pipeline ----
async function filterPII(text) {
  const afterRegex = regexFilter(text)
  const afterOllama = await ollamaFilter(afterRegex)
  return afterOllama
}

function restore(text) {
  let r = text
  for (const [ph, orig] of placeholderToOrig) {
    while (r.includes(ph)) r = r.replace(ph, orig)
  }
  return r
}

// ---- Test cases (raw input, no pre-processing) ----
const TEST_CASES = [
  {
    name: '1. git log (Author行の完全パイプライン)',
    text: `commit abc1234
Author: Takeshi Yamamoto <yamamoto@company.co.jp>
Date:   Mon Mar 31 2026

    fix: resolve auth issue reported by 高橋

commit def5678
Author: Sarah Chen <sarah.chen@gmail.com>

    feat: add dashboard for 楽天グループ integration`,
    shouldRedact: ['Takeshi Yamamoto', 'yamamoto@company.co.jp', '高橋', 'Sarah Chen', 'sarah.chen@gmail.com', '楽天グループ'],
    shouldKeep: ['auth', 'dashboard', 'commit', 'fix:', 'feat:'],
  },
  {
    name: '2. 混合コンテンツ: コード + コメント + エラーログ',
    text: `// Created by 中村大輔 on 2026-03-15
const API_KEY = "sk-abcdefghijklmnopqrstuvwxyz12345678"

ERROR [2026-03-31 10:23:45] User 小林美咲 (kobayashi@internal.net) failed login
  at /home/deploy/app/src/auth.ts:42
  Stack: Error: Invalid credentials for 渡辺

// Contact: 東京都渋谷区神南1-23-10
// Support: 03-1234-5678`,
    shouldRedact: ['中村大輔', 'sk-abcdefghijklmnopqrstuvwxyz12345678', '小林美咲', 'kobayashi@internal.net', '渡辺', '東京都渋谷区神南1-23-10', '03-1234-5678'],
    shouldKeep: ['/home/deploy/app/src/auth.ts:42', 'Invalid credentials', 'ERROR'],
  },
  {
    name: '3. PR description (Markdown)',
    text: `## Summary
Implemented the reporting feature requested by 佐々木さん from ソフトバンクグループ.
Reviewed by @mike_johnson and 吉田先生 (早稲田大学).

### Changes
- Added API endpoint per 伊藤部長's specification
- Fixed bug reported in #234 by 加藤

cc: team-alpha@company.com, 山口次郎 <yamaguchi@example.com>`,
    shouldRedact: ['佐々木', 'ソフトバンクグループ', 'mike_johnson', '吉田', '早稲田大学', '伊藤', '加藤', 'team-alpha@company.com', '山口次郎', 'yamaguchi@example.com'],
    shouldKeep: ['Summary', 'Changes', 'API endpoint', '#234'],
  },
  {
    name: '4. 設定ファイル + 環境変数',
    text: `{
  "database": {
    "host": "db.internal.rakuten.co.jp",
    "admin": "斉藤管理者",
    "contact": "saito@rakuten.co.jp"
  },
  "aws": {
    "access_key": "AKIAIOSFODNN7EXAMPLE",
    "owner": "田辺エンジニア"
  },
  "slack_webhook": "https://hooks.slack.com/services/T00/B00/xxx",
  "maintainer": "高田真一 <takada@corp.jp>"
}`,
    shouldRedact: ['斉藤管理者', 'saito@rakuten.co.jp', 'AKIAIOSFODNN7EXAMPLE', '田辺', '高田真一', 'takada@corp.jp'],
    shouldKeep: ['database', 'host', 'aws', 'access_key', 'slack_webhook'],
  },
  {
    name: '5. 多言語チャットログ',
    text: `[10:00] 김철수: Hey 田中, did you see the update from Müller at Siemens?
[10:01] 田中: Yes, I forwarded it to 이지은 at 현대자동차.
[10:02] Maria García: @田中 can you loop in Jean-Pierre from Société Générale?
[10:03] 田中: Sure, adding him and 陈伟 from 腾讯 as well.`,
    shouldRedact: ['김철수', '田中', 'Müller', 'Siemens', '이지은', '현대자동차', 'Maria García', 'Jean-Pierre', 'Société Générale', '陈伟', '腾讯'],
    shouldKeep: ['Hey', 'Yes', 'Sure', 'update'],
  },
]

async function main() {
  console.log('=== Integrated PII Filter Test (Regex → Ollama Pipeline) ===\n')

  let totalRedact = 0, totalRedacted = 0
  let totalKeep = 0, totalKept = 0
  const allMissed = []

  for (const tc of TEST_CASES) {
    // Reset state for each test
    origToPlaceholder.clear()
    placeholderToOrig.clear()
    counters.clear()

    console.log(`\n${tc.name}`)
    const filtered = await filterPII(tc.text)
    const restored = restore(filtered)

    // Check redactions
    for (const item of tc.shouldRedact) {
      totalRedact++
      if (!filtered.includes(item)) {
        totalRedacted++
        process.stdout.write(`  REDACTED  ${item}\n`)
      } else {
        allMissed.push({ test: tc.name, text: item })
        process.stdout.write(`  LEAKED    ${item}\n`)
      }
    }

    // Check preservation
    for (const item of tc.shouldKeep) {
      totalKeep++
      if (filtered.includes(item)) {
        totalKept++
      } else {
        process.stdout.write(`  BROKE     ${item} (was incorrectly redacted)\n`)
      }
    }

    // Verify restoration roundtrip
    for (const item of tc.shouldRedact) {
      if (!restored.includes(item) && !filtered.includes(item)) {
        process.stdout.write(`  RESTORE-FAIL  ${item}\n`)
      }
    }
  }

  console.log('\n\n=== SUMMARY ===')
  console.log(`Redaction rate: ${totalRedacted}/${totalRedact} (${(totalRedacted/totalRedact*100).toFixed(0)}%)`)
  console.log(`Preservation rate: ${totalKept}/${totalKeep} (${(totalKept/totalKeep*100).toFixed(0)}%)`)

  if (allMissed.length > 0) {
    console.log('\nLEAKED items (need dictionary or pattern fix):')
    for (const m of allMissed) {
      console.log(`  "${m.text}" — ${m.test}`)
    }
  }
}

main().catch(console.error)
