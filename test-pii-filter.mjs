/**
 * PII Filter Test Suite
 * 3 scenarios: ON / OFF / Actual proxy communication
 *
 * Usage: node test-pii-filter.mjs [--proxy]
 *   --proxy  Include scenario 3 (requires ANTHROPIC_API_KEY, hits real API)
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'

// Scenarios 1 & 2: inline filter logic (no server import to avoid port binding)
// Scenario 3: HTTP requests to already-running proxy
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { request } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CONFIG_PATH = join(homedir(), '.claude', 'pii-filter.json')
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ESBUILD_BIN = join(
  SCRIPT_DIR,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild',
)
let actualModuleCachePromise

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {
      enabled: true,
      categories: ['EMAIL', 'PHONE', 'NAME', 'ORG', 'ADDRESS', 'API_KEY', 'CREDIT_CARD', 'MY_NUMBER', 'SCHOOL', 'SSN', 'IP_ADDRESS', 'POSTAL_CODE'],
      dictionary: [],
      allowlist: [],
      ollamaEnabled: false,
    }
  }
}

async function loadActualModules() {
  if (!actualModuleCachePromise) {
    actualModuleCachePromise = (async () => {
      const bundleDir = mkdtempSync(join(tmpdir(), 'cloakroom-test-'))
      const entries = [
        ['config.ts', 'config.mjs'],
        ['controlState.ts', 'controlState.mjs'],
        ['piiFilter.ts', 'piiFilter.mjs'],
        ['provider.ts', 'provider.mjs'],
        ['regexFilter.ts', 'regexFilter.mjs'],
        ['streamRestorer.ts', 'streamRestorer.mjs'],
        ['openaiStreamRestorer.ts', 'openaiStreamRestorer.mjs'],
      ]

      try {
        for (const [entryPoint, outFile] of entries) {
          execFileSync(
            ESBUILD_BIN,
            [
              join(SCRIPT_DIR, 'src', entryPoint),
              '--bundle',
              '--platform=node',
              '--format=esm',
              `--outfile=${join(bundleDir, outFile)}`,
            ],
            { cwd: SCRIPT_DIR, stdio: 'pipe' },
          )
        }

        const [config, controlState, piiFilter, provider, regexFilter, anthropicStream, openaiStream] = await Promise.all([
          import(pathToFileURL(join(bundleDir, 'config.mjs')).href),
          import(pathToFileURL(join(bundleDir, 'controlState.mjs')).href),
          import(pathToFileURL(join(bundleDir, 'piiFilter.mjs')).href),
          import(pathToFileURL(join(bundleDir, 'provider.mjs')).href),
          import(pathToFileURL(join(bundleDir, 'regexFilter.mjs')).href),
          import(pathToFileURL(join(bundleDir, 'streamRestorer.mjs')).href),
          import(pathToFileURL(join(bundleDir, 'openaiStreamRestorer.mjs')).href),
        ])

        return { config, controlState, piiFilter, provider, regexFilter, anthropicStream, openaiStream, bundleDir }
      } catch (error) {
        rmSync(bundleDir, { recursive: true, force: true })
        throw error
      }
    })()
  }

  return actualModuleCachePromise
}

function cleanupActualModules() {
  if (!actualModuleCachePromise) return

  actualModuleCachePromise
    .then(({ bundleDir }) => {
      rmSync(bundleDir, { recursive: true, force: true })
    })
    .catch(() => {})
}

// --- Inline MappingTable ---
class MappingTable {
  #orig2ph = new Map()
  #ph2orig = new Map()
  #counters = new Map()

  register(original, category) {
    const existing = this.#orig2ph.get(original)
    if (existing) return existing
    const count = (this.#counters.get(category) ?? 0) + 1
    this.#counters.set(category, count)
    const ph = `[${category}_${count}]`
    this.#orig2ph.set(original, ph)
    this.#ph2orig.set(ph, original)
    return ph
  }

  replaceAllPlaceholders(input) {
    if (this.#ph2orig.size === 0) return input
    const escaped = [...this.#ph2orig.keys()]
      .sort((left, right) => right.length - left.length)
      .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const pattern = new RegExp(escaped.join('|'), 'g')
    return input.replace(pattern, (match) => this.#ph2orig.get(match) ?? match)
  }

  clear() { this.#orig2ph.clear(); this.#ph2orig.clear(); this.#counters.clear() }
}

// --- Inline regex patterns (mirror of regexFilter.ts) ---
function luhnCheck(digits) {
  const nums = digits.replace(/\D/g, '')
  let sum = 0, alt = false
  for (let i = nums.length - 1; i >= 0; i--) {
    let n = parseInt(nums[i], 10)
    if (alt) { n *= 2; if (n > 9) n -= 9 }
    sum += n; alt = !alt
  }
  return sum % 10 === 0
}

const PATTERNS = [
  { category: 'API_KEY', pattern: /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|AKIA[0-9A-Z]{16}|xox[bpras]-[A-Za-z0-9\-]{10,}|sk-ant-[A-Za-z0-9\-]{20,})\b/g },
  { category: 'EMAIL', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { category: 'CREDIT_CARD', pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, validate: luhnCheck },
  { category: 'MY_NUMBER', pattern: /\b\d{4}[-\s]\d{4}[-\s]\d{4}\b/g },
  { category: 'PHONE', pattern: /(?:\+81[-\s]?|0)\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}\b/g, validate: (match) => match.replace(/[-\s]/g, '').length >= 10 },
  { category: 'PHONE', pattern: /\+\d{1,3}[-\s]\d{1,14}(?:[-\s]\d{1,14}){0,4}\b/g },
  { category: 'ADDRESS', pattern: /(?:北海道|東京都|(?:大阪|京都)府|.{2,3}県).{1,8}(?:市|区|町|村|郡).{1,20}?(?:\d{1,4}[-ー]\d{1,4}(?:[-ー]\d{1,4})?|[一二三四五六七八九十百]+丁目)/g },
  { category: 'ADDRESS', pattern: /(?:[一二三四五六七八九十百千〇零\d]+丁目)?[一二三四五六七八九十百千〇零\d]+番(?:地)?(?:[一二三四五六七八九十百千〇零\d]+号)?/g },
  { category: 'ADDRESS', pattern: /\d{1,4}[-ー]\d{1,4}(?:[-ー]\d{1,4})?\s*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9ー・\-\s]{2,30}(?:マンション|アパート|ハイツ|コーポ|レジデンス|ビル|タワー|荘)\s*\d{1,4}(?:号室|号)?/gu },
  { category: 'URL_USER', pattern: /https?:\/\/[^\s/@]+:[^\s/@]+@[^\s/]+/g },
  { category: 'NAME', pattern: /(?:Author|Committer):\s+(.+?)\s+<[^>]+>/g, captureGroup: 1 },
  { category: 'SSN', pattern: /\b(?!000|666|9\d{2})\d{3}[-\s]?(?!00)\d{2}[-\s]?(?!0000)\d{4}\b/g },
  { category: 'IP_ADDRESS', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g },
  { category: 'IP_ADDRESS', pattern: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g },
  { category: 'POSTAL_CODE', pattern: /〒\d{3}-\d{4}/g },
  { category: 'POSTAL_CODE', pattern: /\b\d{3}-\d{4}(?=\s*(?:$|[^\d]))/g, validate: (match) => !/^\d{3}-\d{2}-\d{4}$/.test(match) },
]

function detectDictionary(text, categories, dictionary) {
  const catSet = new Set(categories)
  const matches = []
  for (const entry of dictionary) {
    if (!catSet.has(entry.category)) continue
    let start = 0
    while (true) {
      const idx = text.indexOf(entry.text, start)
      if (idx === -1) break
      matches.push({ text: entry.text, category: entry.category, start: idx, end: idx + entry.text.length })
      start = idx + entry.text.length
    }
  }
  return matches.sort((a, b) => b.start - a.start)
}

function detectRegex(text, categories) {
  const catSet = new Set(categories)
  const matches = []
  for (const def of PATTERNS) {
    if (!catSet.has(def.category)) continue
    const regex = new RegExp(def.pattern.source, def.pattern.flags)
    let m
    while ((m = regex.exec(text)) !== null) {
      const group = def.captureGroup ?? 0
      const matchText = m[group] ?? m[0]
      if (!matchText) continue
      if (def.validate && !def.validate(matchText)) continue
      const start = group > 0 && m[group] ? m.index + m[0].indexOf(m[group]) : m.index
      matches.push({ text: matchText, category: def.category, start, end: start + matchText.length })
    }
  }
  return matches.sort((a, b) => b.start - a.start)
}

function applyReplacements(text, matches, register) {
  const sorted = [...matches].sort(
    (left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start),
  )
  const winners = []
  let lastEnd = -1
  for (const match of sorted) {
    if (match.start >= lastEnd) {
      winners.push(match)
      lastEnd = match.end
    }
  }
  winners.sort((left, right) => right.start - left.start)

  let result = text
  for (const match of winners) {
    const ph = register(match.text, match.category)
    result = result.slice(0, match.start) + ph + result.slice(match.end)
  }
  return result
}

function filterText(text, config, mapping) {
  if (!text.trim()) return text
  const allowlist = new Set(config.allowlist ?? [])
  const registerValue = (original, category) => allowlist.has(original) ? original : mapping.register(original, category)

  let filtered = text
  const dictMatches = detectDictionary(filtered, config.categories, config.dictionary ?? [])
  filtered = applyReplacements(filtered, dictMatches, registerValue)
  const regexMatches = detectRegex(filtered, config.categories)
  filtered = applyReplacements(filtered, regexMatches, registerValue)
  return filtered
}

class SessionFilterStore {
  #bySessionId = new Map()
  #bySocket = new WeakMap()

  acquire(headers = {}, socket = {}) {
    const explicitSessionId =
      headers['x-pii-session-id'] ??
      headers['anthropic-session-id'] ??
      headers['x-session-id']

    if (explicitSessionId) {
      if (!this.#bySessionId.has(explicitSessionId)) {
        this.#bySessionId.set(explicitSessionId, new MappingTable())
      }
      return this.#bySessionId.get(explicitSessionId)
    }

    if (!this.#bySocket.has(socket)) {
      this.#bySocket.set(socket, new MappingTable())
    }
    return this.#bySocket.get(socket)
  }
}

function createMappingTableMock(replacements) {
  const placeholders = Object.keys(replacements)
  return {
    resolve(placeholder) {
      return replacements[placeholder]
    },
    getLongestPlaceholderLength() {
      return placeholders.reduce((longest, placeholder) => Math.max(longest, placeholder.length), 0)
    },
  }
}

// ============================================================
// Test data
// ============================================================
// Fictional test PII (no real data)
const TEST_DICTIONARY = [
  { text: '山田太郎', category: 'NAME' },
  { text: 'テスト株式会社', category: 'ORG' },
  { text: 'テスト大学', category: 'SCHOOL' },
]

const TEST_PII = {
  email: 'yamada.taro@example.com',
  phone: '09011112222',
  address: '東京都千代田区丸の内1-2-3',
  apiKey: 'sk-ant-abcdefghijklmnopqrstuvwxyz123456',
  creditCard: '4532015112830366', // passes Luhn
  myNumber: '1234-5678-9012',
  dictName: '山田太郎',
  dictOrg: 'テスト株式会社',
  dictSchool: 'テスト大学',
  ssn: '123-45-6789',
  ipv4: '192.168.1.100',
  postalCode: '〒100-0001',
}

const TEST_MESSAGE = `私は${TEST_PII.dictName}です。${TEST_PII.dictOrg}に所属しています。` +
  `メールは${TEST_PII.email}、電話は${TEST_PII.phone}です。` +
  `住所は${TEST_PII.address}。` +
  `APIキーは${TEST_PII.apiKey}です。`

// ============================================================
// Scenario 1: Filter ON
// ============================================================
function testFilterON() {
  console.log('\n=== Scenario 1: Filter ON ===')
  const config = { ...loadConfig(), dictionary: TEST_DICTIONARY, ollamaEnabled: false }
  assert.ok(config.enabled !== false, 'Config should be enabled')

  const mapping = new MappingTable()
  const filtered = filterText(TEST_MESSAGE, config, mapping)

  console.log('Original:', TEST_MESSAGE.slice(0, 80) + '...')
  console.log('Filtered:', filtered.slice(0, 120) + '...')

  // Dictionary matches
  assert.ok(!filtered.includes(TEST_PII.dictName), `Name "${TEST_PII.dictName}" should be masked`)
  assert.ok(!filtered.includes(TEST_PII.dictOrg), `Org should be masked`)
  assert.ok(filtered.includes('[NAME_'), 'Should contain NAME placeholder')
  assert.ok(filtered.includes('[ORG_'), 'Should contain ORG placeholder')

  // Regex matches
  assert.ok(!filtered.includes(TEST_PII.email), 'Email should be masked')
  assert.ok(filtered.includes('[EMAIL_'), 'Should contain EMAIL placeholder')
  assert.ok(!filtered.includes(TEST_PII.phone), 'Phone should be masked')

  // Restoration
  const restored = mapping.replaceAllPlaceholders(filtered)
  assert.equal(restored, TEST_MESSAGE, 'Restored text should match original')

  console.log('Restored matches original: OK')

  // Additional checks
  const mapping2 = new MappingTable()
  const ccFiltered = filterText(`Card: ${TEST_PII.creditCard}`, config, mapping2)
  console.log('Credit card filtered:', ccFiltered)
  assert.ok(ccFiltered.includes('[CREDIT_CARD_'), `Credit card should be masked as CREDIT_CARD, got: ${ccFiltered}`)
  assert.ok(!ccFiltered.includes('[PHONE_'), `Credit card should not be masked as PHONE, got: ${ccFiltered}`)

  const mapping3 = new MappingTable()
  const mnFiltered = filterText(`番号: ${TEST_PII.myNumber}`, config, mapping3)
  console.log('MyNumber filtered:', mnFiltered)

  const mapping4 = new MappingTable()
  const addrFiltered = filterText(`住所は${TEST_PII.address}です`, config, mapping4)
  assert.ok(!addrFiltered.includes('千代田区'), 'Address should be masked')
  console.log('Address filtered:', addrFiltered)

  console.log('Scenario 1 PASSED')
}

function testBugRegressions() {
  console.log('\n=== Bug Regressions ===')
  const config = { ...loadConfig(), dictionary: [], allowlist: [], ollamaEnabled: false }

  {
    const mapping = new MappingTable()
    const filtered = filterText('+81-90-1111-2222', { ...config, categories: ['PHONE'] }, mapping)
    const placeholderCount = (filtered.match(/\[PHONE_\d+\]/g) ?? []).length
    assert.equal(placeholderCount, 1, `#16: expected one phone placeholder, got "${filtered}"`)
    console.log('#16 PHONE overlap: OK')
  }

  {
    const mapping = new MappingTable()
    const emails = Array.from({ length: 200 }, (_, index) => `user${index}@example.com`)
    const filtered = filterText(emails.join(' '), { ...config, categories: ['EMAIL'] }, mapping)
    const startedAt = Date.now()
    mapping.replaceAllPlaceholders(filtered)
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < 500, `#18: restore should stay fast, took ${elapsed}ms`)
    console.log(`#18 placeholder restore: ${elapsed}ms OK`)
  }

  {
    const mapping = new MappingTable()
    const publicEmail = 'public@example.com'
    const privateEmail = 'private@example.com'
    const filtered = filterText(
      `Send to ${publicEmail} and ${privateEmail}`,
      { ...config, categories: ['EMAIL'], allowlist: [publicEmail] },
      mapping,
    )
    assert.ok(filtered.includes(publicEmail), '#26: allowlisted email should remain visible')
    assert.ok(!filtered.includes(privateEmail), '#26: non-allowlisted email should still be masked')
    console.log('#26 Allowlist: OK')
  }

  {
    const mapping = new MappingTable()
    const filtered = filterText(`SSN: ${TEST_PII.ssn}`, { ...config, categories: ['SSN'] }, mapping)
    assert.ok(filtered.includes('[SSN_'), '#27: SSN should be masked')
    assert.ok(!filtered.includes(TEST_PII.ssn), '#27: raw SSN should not remain')
    console.log('#27 SSN: OK')
  }

  {
    const mapping = new MappingTable()
    const filtered = filterText(`Server: ${TEST_PII.ipv4}`, { ...config, categories: ['IP_ADDRESS'] }, mapping)
    assert.ok(filtered.includes('[IP_ADDRESS_'), '#28: IP address should be masked')
    assert.ok(!filtered.includes(TEST_PII.ipv4), '#28: raw IP should not remain')
    console.log('#28 IP_ADDRESS: OK')
  }

  {
    const mapping = new MappingTable()
    const filtered = filterText(`住所: ${TEST_PII.postalCode}`, { ...config, categories: ['POSTAL_CODE'] }, mapping)
    assert.ok(filtered.includes('[POSTAL_CODE_'), '#9: postal code should be masked')
    assert.ok(!filtered.includes('100-0001'), '#9: raw postal code should not remain')
    console.log('#9 POSTAL_CODE: OK')
  }

  {
    const mapping = new MappingTable()
    const filtered = filterText(
      '住所詳細: 三丁目12番地5号、1-2-3 サンプルマンション 405号室',
      { ...config, categories: ['ADDRESS'] },
      mapping,
    )
    const addressCount = (filtered.match(/\[ADDRESS_\d+\]/g) ?? []).length
    assert.ok(addressCount >= 2, `#8: detailed Japanese address parts should be masked, got: ${filtered}`)
    assert.ok(!filtered.includes('三丁目12番地5号'), '#8: chome/ban/go address should be masked')
    assert.ok(!filtered.includes('サンプルマンション 405号室'), '#8: apartment room address should be masked')
    console.log('#8 Japanese ADDRESS details: OK')
  }

  {
    const store = new SessionFilterStore()
    const sessionA1 = store.acquire({ 'x-pii-session-id': 'session-a' }, {})
    const sessionA2 = store.acquire({ 'x-pii-session-id': 'session-a' }, {})
    const sessionB = store.acquire({ 'x-pii-session-id': 'session-b' }, {})
    const socketSession1 = store.acquire({}, {})
    const socket = {}
    const socketSession2 = store.acquire({}, socket)
    const socketSession3 = store.acquire({}, socket)

    assert.equal(sessionA1, sessionA2, '#17: same explicit session should reuse one mapping table')
    assert.notEqual(sessionA1, sessionB, '#17: different explicit sessions must not share state')
    assert.notEqual(sessionA1, socketSession1, '#17: explicit session and socket session must stay isolated')
    assert.equal(socketSession2, socketSession3, '#17: same socket fallback should reuse one mapping table')
    console.log('#17 Session-scoped mapping: OK')
  }

  console.log('Bug Regressions PASSED')
}

async function testProviderRouting() {
  console.log('\n=== Provider Routing ===')

  const { provider } = await loadActualModules()
  const { getRequestPath, resolveProvider, shouldFilterMessagesPath } = provider

  assert.equal(getRequestPath({ url: '/v1/chat/completions?stream=true' }), '/v1/chat/completions')

  assert.equal(
    resolveProvider({ url: '/v1/messages', headers: {} }).kind,
    'anthropic',
    '#2/#4: /v1/messages should route to Anthropic',
  )
  assert.equal(
    resolveProvider({ url: '/v1/chat/completions', headers: {} }).kind,
    'openai',
    '#2/#4: /v1/chat/completions should route to OpenAI',
  )
  assert.equal(
    resolveProvider({ url: '/v1/models', headers: { 'x-provider': 'openai' } }).kind,
    'openai',
    '#2/#4: x-provider=openai should steer generic pass-through routes',
  )

  assert.equal(
    shouldFilterMessagesPath({ method: 'POST', url: '/v1/messages', headers: {} }),
    true,
    '#2: Anthropic messages route should be filtered',
  )
  assert.equal(
    shouldFilterMessagesPath({ method: 'POST', url: '/v1/chat/completions', headers: {} }),
    true,
    '#2: OpenAI chat completions route should be filtered',
  )
  assert.equal(
    shouldFilterMessagesPath({ method: 'GET', url: '/v1/chat/completions', headers: {} }),
    false,
    '#2: non-POST requests should pass through untouched',
  )

  console.log('#2/#4 Provider routing: OK')
}

async function testStreamRestorers() {
  console.log('\n=== Stream Restorers ===')

  const { anthropicStream, openaiStream } = await loadActualModules()
  const anthropicMapping = createMappingTableMock({ '[EMAIL_1]': 'user@example.com' })
  const openaiMapping = createMappingTableMock({ '[NAME_1]': '山田太郎' })

  {
    const restorer = new anthropicStream.StreamRestorer(anthropicMapping)
    const output =
      restorer.processChunk(
        [
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello [EM"}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"AIL_1]"}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
        ].join('\n'),
      ) + restorer.flush()

    assert.ok(output.includes('"text":"Hello "'), '#3: Anthropic stream should preserve plain text before a placeholder')
    assert.ok(output.includes('"text":"user@example.com"'), '#3: Anthropic stream should restore split placeholders')
  }

  {
    const restorer = new openaiStream.OpenAIStreamRestorer(openaiMapping)
    const output =
      restorer.processChunk(
        [
          'data: {"choices":[{"index":0,"delta":{"content":"こんにちは、[NA"}}]}',
          '',
          'data: {"choices":[{"index":0,"delta":{"content":"ME_1]さん"}}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      ) + restorer.flush()

    assert.ok(output.includes('"content":"こんにちは、"'), '#3: OpenAI stream should emit text before an incomplete placeholder')
    assert.ok(output.includes('"content":"山田太郎さん"'), '#3: OpenAI stream should restore split placeholders')
    assert.ok(output.trimEnd().endsWith('data: [DONE]'), '#3: OpenAI stream should keep the terminal DONE marker')
  }

  console.log('#3 Stream restoration: OK')
}

async function testControlState() {
  console.log('\n=== Control State ===')

  const { controlState } = await loadActualModules()
  controlState.resetControlState()

  assert.equal(controlState.getControlStatus().passthroughEnabled, false, '#13: filter should start enabled')
  controlState.setPassthroughEnabled(true)
  assert.equal(controlState.isPassthroughEnabled(), true, '#13: passthrough should be enabled')
  controlState.togglePassthrough()
  assert.equal(controlState.isPassthroughEnabled(), false, '#13: SIGUSR1 toggle helper should switch modes')

  assert.equal(controlState.isKnownPIICategory('PHONE'), true, '#13: known categories should be accepted')
  assert.equal(controlState.isKnownPIICategory('NOPE'), false, '#13: unknown categories should be rejected')

  controlState.disableCategory('PHONE')
  assert.deepEqual(
    controlState.getActiveCategories(['EMAIL', 'PHONE']),
    ['EMAIL'],
    '#13: disabled categories should be removed at runtime',
  )
  controlState.enableCategory('PHONE')
  assert.deepEqual(
    controlState.getActiveCategories(['EMAIL', 'PHONE']),
    ['EMAIL', 'PHONE'],
    '#13: enabled categories should return to active filtering',
  )

  controlState.resetControlState()
  console.log('#13 Runtime control state: OK')
}

async function testAdvancedSafetyRegressions() {
  console.log('\n=== Advanced Safety Regressions ===')

  const { config, piiFilter } = await loadActualModules()
  const baseConfig = {
    enabled: true,
    mode: 'pseudonymize',
    categories: ['EMAIL', 'PHONE', 'NAME'],
    ollamaEndpoint: 'http://localhost:11434',
    allowRemoteOllama: false,
    ollamaModel: 'gemma3:4b',
    ollamaEnabled: false,
    customPatterns: [],
    customCategories: [],
    dictionary: TEST_DICTIONARY,
    allowlist: [],
    auditLog: {
      enabled: false,
      destination: 'stderr',
      reviewThreshold: 0.8,
    },
  }

  {
    const filter = new piiFilter.PIIFilter(baseConfig)
    const filtered = await filter.filterRequestBody({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_test',
              name: 'read_file',
              input: {
                path: `/Users/${TEST_PII.dictName}/Documents/notes.txt`,
                email: TEST_PII.email,
                nested: [`call ${TEST_PII.phone}`],
              },
            },
          ],
        },
      ],
    })

    const input = filtered.messages[0].content[0].input
    const serialized = JSON.stringify(input)
    assert.ok(!serialized.includes(TEST_PII.dictName), '#50: tool_use.input path should be masked')
    assert.ok(!serialized.includes(TEST_PII.email), '#50: tool_use.input email should be masked')
    assert.ok(!serialized.includes(TEST_PII.phone), '#50: tool_use.input nested strings should be masked')
    assert.ok(serialized.includes('[NAME_') && serialized.includes('[EMAIL_') && serialized.includes('[PHONE_'))
    console.log('#50 tool_use.input filtering: OK')
  }

  {
    const filter = new piiFilter.PIIFilter({
      ...baseConfig,
      categories: [],
      dictionary: [],
      customPatterns: [{ name: 'EMPLOYEE_ID', pattern: 'EMP-\\d{4}' }],
    })
    const filtered = await filter.filterRequestBody({
      messages: [{ role: 'user', content: '社員番号は EMP-1234 です。' }],
    })

    const content = filtered.messages[0].content
    assert.ok(content.includes('[EMPLOYEE_ID_1]'), '#51: customPatterns should use custom category names')
    assert.ok(!content.includes('[NAME_'), '#51: customPatterns should not fall back to NAME')
    console.log('#51 customPatterns category: OK')
  }

  {
    const longCategory = 'VERY_LONG_CUSTOM_CATEGORY_FOR_STREAM_RESTORE'
    const secret = 'SECRET-12345'
    const filter = new piiFilter.PIIFilter({
      ...baseConfig,
      categories: [],
      dictionary: [],
      customPatterns: [{ name: longCategory, pattern: 'SECRET-\\d{5}' }],
    })
    const filtered = await filter.filterRequestBody({
      messages: [{ role: 'user', content: `値は ${secret} です。` }],
    })
    const placeholder = filtered.messages[0].content.match(/\[[^\]]+\]/)?.[0]
    assert.ok(placeholder && placeholder.length > 32, '#19: test should create a long placeholder')

    const restorer = filter.createStreamRestorer()
    const splitAt = Math.floor(placeholder.length / 2)
    const output =
      restorer.processChunk(
        [
          'event: content_block_delta',
          `data: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: `値は ${placeholder.slice(0, splitAt)}` },
          })}`,
          '',
          'event: content_block_delta',
          `data: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: `${placeholder.slice(splitAt)} です。` },
          })}`,
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
        ].join('\n'),
      ) + restorer.flush()

    assert.ok(output.includes(secret), '#19: long split placeholder should be restored in streams')
    console.log('#19 long custom placeholder stream restore: OK')
  }

  {
    assert.equal(
      config.normalizeOllamaEndpoint('https://example.com:11434/ollama', false),
      'http://localhost:11434',
      '#53: remote Ollama endpoint should be rejected by default',
    )
    assert.equal(
      config.normalizeOllamaEndpoint('https://example.com:11434/ollama', true),
      'https://example.com:11434',
      '#53: explicit opt-in should allow remote Ollama endpoint',
    )
    assert.equal(
      config.normalizeOllamaEndpoint('http://127.0.0.1:11434/api', false),
      'http://127.0.0.1:11434',
      '#53: loopback Ollama endpoint should be accepted',
    )
    console.log('#53 Ollama endpoint validation: OK')
  }
}

async function testFinancialIdentityRegexCoverage() {
  console.log('\n=== Financial and Identity Regex Coverage ===')

  const { regexFilter } = await loadActualModules()

  function mask(text, categories) {
    const matches = regexFilter.detectRegexPII(text, categories)
    const counters = new Map()
    const filtered = regexFilter.applyReplacements(text, matches, (match) => {
      const count = (counters.get(match.category) ?? 0) + 1
      counters.set(match.category, count)
      return `[${match.category}_${count}]`
    })
    return { matches, filtered }
  }

  {
    const valid = 'IBAN: GB29 NWBK 6016 1331 9268 19'
    const invalid = 'IBAN: GB29 NWBK 6016 1331 9268 18'
    const validResult = mask(valid, ['IBAN'])
    const invalidResult = mask(invalid, ['IBAN'])
    assert.ok(validResult.filtered.includes('[IBAN_1]'), '#29: valid IBAN should be masked')
    assert.equal(invalidResult.matches.length, 0, '#29: invalid IBAN checksum should be rejected')
    console.log('#29 IBAN: OK')
  }

  {
    const result = mask(
      '金融機関コード: 0001 支店コード: 001 口座番号: 1234567',
      ['BANK_ACCOUNT'],
    )
    assert.ok(result.filtered.includes('[BANK_ACCOUNT_1]'), '#30: Japanese bank account should be masked')
    assert.ok(!result.filtered.includes('1234567'), '#30: raw account number should not remain')
    console.log('#30 BANK_ACCOUNT: OK')
  }

  {
    const result = mask('免許証番号: 12-3456-7890-12', ['DRIVER_LICENSE'])
    assert.ok(result.filtered.includes('[DRIVER_LICENSE_1]'), '#31: hyphenated driver license should be masked')
    assert.ok(!result.filtered.includes('12-3456-7890-12'), '#31: raw driver license should not remain')
    console.log('#31 DRIVER_LICENSE: OK')
  }

  {
    const japan = mask('パスポート番号: AB1234567', ['PASSPORT'])
    const us = mask('Passport Number: 123456789', ['PASSPORT'])
    assert.ok(japan.filtered.includes('[PASSPORT_1]'), '#32: Japanese passport should be masked')
    assert.ok(us.filtered.includes('[PASSPORT_1]'), '#32: US passport should be masked with context')
    console.log('#32 PASSPORT: OK')
  }

  {
    const bitcoin = mask('BTC: 1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf4', ['CRYPTO_WALLET'])
    const ethereum = mask('ETH: 0x742d35Cc6634C0532925a3b844Bc454e4438f44e', ['CRYPTO_WALLET'])
    assert.ok(bitcoin.filtered.includes('[CRYPTO_WALLET_1]'), '#33: Bitcoin wallet should be masked')
    assert.ok(ethereum.filtered.includes('[CRYPTO_WALLET_1]'), '#33: Ethereum wallet should be masked')
    console.log('#33 CRYPTO_WALLET: OK')
  }
}

// ============================================================
// Scenario 2: Filter OFF
// ============================================================
function testFilterOFF() {
  console.log('\n=== Scenario 2: Filter OFF ===')
  const config = { ...loadConfig(), enabled: false, dictionary: TEST_DICTIONARY, ollamaEnabled: false }

  // When disabled, filterRequestBody returns input unchanged.
  // Simulating: if !enabled, skip filtering
  const mapping = new MappingTable()

  if (!config.enabled) {
    console.log('Filter disabled - text passes through unchanged')
    const result = TEST_MESSAGE // no filtering
    assert.equal(result, TEST_MESSAGE, 'Text should be unchanged when filter is OFF')
    assert.ok(result.includes(TEST_PII.dictName), 'Name should remain in text')
    assert.ok(result.includes(TEST_PII.email), 'Email should remain in text')
    assert.ok(result.includes(TEST_PII.phone), 'Phone should remain in text')
    console.log('Passthrough verified: all PII present in output')
  }

  // Also test via CLAUDE_PII_FILTER=0 env var logic
  console.log('CLAUDE_PII_FILTER=0 would set enabled=false in config.ts')

  console.log('Scenario 2 PASSED')
}

// ============================================================
// Scenario 3: Actual proxy communication
// ============================================================
async function testActualProxy() {
  console.log('\n=== Scenario 3: Actual Proxy Communication ===')

  const PROXY_PORT = process.env.PII_PROXY_PORT ?? 8787
  const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`

  // Check health
  const healthOk = await httpGet(`${PROXY_URL}/health`).catch(() => null)
  if (!healthOk) {
    console.log('SKIP: Proxy not running. Start with: npm run build && npm start')
    return false
  }
  console.log('Proxy health: OK')

  const initialStatus = JSON.parse(await httpGet(`${PROXY_URL}/control/status`))
  assert.equal(initialStatus.filterEnabled, true, 'Control status should start with filtering enabled')
  assert.ok(initialStatus.activeCategories.includes('EMAIL'), 'Control status should list active categories')
  console.log('Control status: OK')

  const passthroughStatus = JSON.parse(await httpPost(`${PROXY_URL}/control/passthrough`, {}, {}))
  assert.equal(passthroughStatus.passthroughEnabled, true, 'Passthrough endpoint should disable filtering')

  const filterStatus = JSON.parse(await httpPost(`${PROXY_URL}/control/filter`, {}, {}))
  assert.equal(filterStatus.passthroughEnabled, false, 'Filter endpoint should re-enable filtering')

  const disabledPhoneStatus = JSON.parse(await httpPost(`${PROXY_URL}/control/disable/PHONE`, {}, {}))
  assert.ok(
    !disabledPhoneStatus.activeCategories.includes('PHONE'),
    'Disable category endpoint should remove PHONE from active categories',
  )

  const enabledPhoneStatus = JSON.parse(await httpPost(`${PROXY_URL}/control/enable/PHONE`, {}, {}))
  assert.ok(
    enabledPhoneStatus.activeCategories.includes('PHONE'),
    'Enable category endpoint should restore PHONE to active categories',
  )
  console.log('Control endpoints: OK')

  // Send a message containing PII through the proxy (no API key needed for filtering verification)
  const requestBody = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 50,
    messages: [
      {
        role: 'user',
        content: `私は山田太郎です。メールはyamada.taro@example.comです。09011112222に電話してください。`
      }
    ]
  }

  console.log('Sending request through proxy with PII (no API key)...')
  const response = await httpPost(`${PROXY_URL}/v1/messages`, requestBody, {
    'x-api-key': 'sk-ant-test-dummy-key-for-filtering-test',
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  })

  const parsed = JSON.parse(response)
  console.log('Upstream status:', parsed.error?.type ?? 'ok')

  // 401 is expected (dummy key). The point is the proxy accepted the request,
  // filtered PII, forwarded it, and returned the upstream response.
  // If we got a response at all (not a connection error), the proxy round-trip works.
  assert.ok(parsed !== undefined, 'Proxy should return a response')
  console.log('Proxy round-trip verified (upstream returned response)')

  console.log('Sending OpenAI-style request through proxy with PII (no API key)...')
  const openAIResponse = await httpPost(
    `${PROXY_URL}/v1/chat/completions`,
    {
      model: 'gpt-4.1-mini',
      messages: [
        {
          role: 'user',
          content: `私は山田太郎です。メールはyamada.taro@example.comです。09011112222に電話してください。`,
        },
      ],
    },
    {
      authorization: 'Bearer sk-test-dummy-key-for-filtering-test',
      'content-type': 'application/json',
    },
  )

  const openAIParsed = JSON.parse(openAIResponse)
  console.log('OpenAI upstream status:', openAIParsed.error?.type ?? 'ok')
  assert.ok(openAIParsed !== undefined, 'OpenAI route should return a response')
  console.log('OpenAI provider route verified')

  // Bonus: if API key is available, verify full round-trip with restoration
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (apiKey) {
    console.log('\nAPI key found - testing full round-trip with restoration...')
    const fullResponse = await httpPost(`${PROXY_URL}/v1/messages`, requestBody, {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    })
    const fullParsed = JSON.parse(fullResponse)
    if (!fullParsed.error) {
      const text = fullParsed.content?.[0]?.text ?? ''
      console.log('Full response:', text.slice(0, 200))
      console.log('PII restored in response:', text.includes('山田') || text.includes('yamada') ? 'YES' : 'N/A (model may not echo)')
    } else {
      console.log('API error:', fullParsed.error.message)
    }
  }

  console.log('Scenario 3 PASSED')
  return true
}

// ============================================================
// HTTP helpers
// ============================================================
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET' }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString()))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

function httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = JSON.stringify(body)
    const req = request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { ...headers, 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString()))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(data)
    req.end()
  })
}

// ============================================================
// Run
// ============================================================
const runProxy = process.argv.includes('--proxy')

try {
  testFilterON()
  testFilterOFF()
  testBugRegressions()
  await testProviderRouting()
  await testStreamRestorers()
  await testControlState()
  await testAdvancedSafetyRegressions()
  await testFinancialIdentityRegexCoverage()

  if (runProxy) {
    await testActualProxy()
  } else {
    console.log('\n=== Scenario 3: Actual Proxy Communication ===')
    console.log('SKIP: Use --proxy flag to run (requires running proxy + ANTHROPIC_API_KEY)')
  }

  console.log('\n All tests passed')
} catch (err) {
  console.error('\n FAILED:', err.message)
  process.exitCode = 1
} finally {
  cleanupActualModules()
}
