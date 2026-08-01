/**
 * Benchmark: labeled dataset precision/recall/F2 per category (#82)
 * Usage: node test-benchmark.mjs [--update-baseline]
 *
 * First run: writes benchmark-baseline.json.
 * Subsequent runs: fails if any category recall drops >= 5% vs baseline.
 * --update-baseline: overwrites baseline with current scores.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ESBUILD_BIN = join(
  SCRIPT_DIR,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild',
)
const BASELINE_PATH = join(SCRIPT_DIR, 'benchmark-baseline.json')
const UPDATE_BASELINE = process.argv.includes('--update-baseline')

// --- Dataset definition ---
const DUMMY_VALUES = {
  EMAIL: ['tanaka@example.co.jp', 'yamada@test.example.com'],
  PHONE: ['090-1234-5678', '03-9876-5432', '+81-90-1234-5678'],
  CREDIT_CARD: ['4111 1111 1111 1111', '5500 0000 0000 0004'],
  API_KEY: ['sk-test-abcdefghijklmnopqrstuvwxyz123456', 'sk-ant-api03-xxxxxxxxxxxxxxxx'],
  NAME: ['田中太郎', '山田花子'],
}

const TEMPLATES = [
  // EMAIL
  { template: '{NAME}さん({EMAIL})に連絡してください', spans: ['EMAIL'] },
  { template: 'Contact {EMAIL} for details', spans: ['EMAIL'] },
  { template: 'メールアドレスはsample@example.comです', spans: [] }, // サンプル=FP候補
  // PHONE
  { template: '電話番号: {PHONE}', spans: ['PHONE'] },
  { template: 'TEL {PHONE} まで', spans: ['PHONE'] },
  { template: 'サンプル: 090-xxxx-xxxx', spans: [] },
  // CREDIT_CARD
  { template: 'カード番号 {CREDIT_CARD} で決済', spans: ['CREDIT_CARD'] },
  // API_KEY
  { template: 'OPENAI_API_KEY={API_KEY}', spans: ['API_KEY'] },
]

// --- Module loader (same pattern as test-pii-filter.mjs) ---
async function loadActualModules() {
  const bundleDir = mkdtempSync(join(tmpdir(), 'cloakroom-bench-'))
  try {
    execFileSync(
      ESBUILD_BIN,
      [
        join(SCRIPT_DIR, 'src', 'regexFilter.ts'),
        '--bundle',
        '--platform=node',
        '--format=esm',
        `--outfile=${join(bundleDir, 'regexFilter.mjs')}`,
      ],
      { cwd: SCRIPT_DIR, stdio: 'pipe' },
    )
    const regexFilter = await import(pathToFileURL(join(bundleDir, 'regexFilter.mjs')).href)
    return { regexFilter, bundleDir }
  } catch (error) {
    rmSync(bundleDir, { recursive: true, force: true })
    throw error
  }
}

// --- Dataset generation (template × dummy values) ---
function generateDataset() {
  const items = []

  for (const { template, spans } of TEMPLATES) {
    const tokens = [...new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))]

    if (tokens.length === 0) {
      items.push({ text: template, expectedCategories: new Set(spans) })
      continue
    }

    // Iterate dummy values for the first expected span category; fix others to first value
    const primaryToken = spans.find((s) => tokens.includes(s)) ?? tokens[0]
    const primaryValues = DUMMY_VALUES[primaryToken] ?? [primaryToken]

    for (const primaryValue of primaryValues) {
      let text = template
      for (const token of tokens) {
        const value = token === primaryToken ? primaryValue : (DUMMY_VALUES[token]?.[0] ?? token)
        text = text.replace(`{${token}}`, value)
      }
      items.push({ text, expectedCategories: new Set(spans) })
    }
  }

  return items
}

// --- Scorer ---
// precision = TP / (TP + FP)
// recall    = TP / (TP + FN)
// F2        = 5 * P * R / (4 * P + R)  (β=2 weights recall twice as heavily)
function computeScore(results, benchmarkCategories) {
  const stats = {}
  for (const cat of benchmarkCategories) {
    stats[cat] = { tp: 0, fp: 0, fn: 0 }
  }

  for (const { expectedCategories, detectedCategories } of results) {
    const detected = new Set(detectedCategories)
    for (const cat of benchmarkCategories) {
      const expected = expectedCategories.has(cat)
      const found = detected.has(cat)
      if (expected && found) stats[cat].tp++
      else if (!expected && found) stats[cat].fp++
      else if (expected && !found) stats[cat].fn++
      // TN: not expected, not found — not counted
    }
  }

  const scores = {}
  for (const [cat, { tp, fp, fn }] of Object.entries(stats)) {
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0
    const denom = 4 * precision + recall
    const f2 = denom > 0 ? (5 * precision * recall) / denom : 0
    scores[cat] = { precision, recall, f2, tp, fp, fn }
  }
  return scores
}

// --- CI regression check ---
function checkRegression(scores) {
  const THRESHOLD = 0.05

  if (!existsSync(BASELINE_PATH) || UPDATE_BASELINE) {
    const baseline = {}
    for (const [cat, s] of Object.entries(scores)) {
      baseline[cat] = { recall: s.recall }
    }
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n')
    const action = UPDATE_BASELINE ? 'updated' : 'created'
    console.log(`\nBaseline ${action}: ${BASELINE_PATH}`)
    return true
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  let passed = true

  for (const [cat, s] of Object.entries(scores)) {
    const base = baseline[cat]
    if (!base) continue // new category not in baseline — skip
    const drop = base.recall - s.recall
    if (drop >= THRESHOLD) {
      console.error(
        `FAIL [${cat}] recall dropped ${(drop * 100).toFixed(1)}%` +
          ` (${(base.recall * 100).toFixed(1)}% -> ${(s.recall * 100).toFixed(1)}%)`,
      )
      passed = false
    }
  }

  return passed
}

// --- Main ---
async function runBenchmark() {
  console.log('=== cloakroom benchmark (#82) ===\n')

  const { regexFilter, bundleDir } = await loadActualModules()
  const { detectRegexPII } = regexFilter

  try {
    // 1. Generate dataset
    const dataset = generateDataset()
    const benchmarkCategories = [...new Set(TEMPLATES.flatMap((t) => t.spans))]
    console.log(`Dataset: ${dataset.length} items  Categories: ${benchmarkCategories.join(', ')}`)

    // 2. Run detection on each item
    const results = dataset.map(({ text, expectedCategories }) => {
      const matches = detectRegexPII(text, benchmarkCategories)
      const detectedCategories = [...new Set(matches.map((m) => m.category))]
      return { text, expectedCategories, detectedCategories }
    })

    // 3. Compute per-category scores
    const scores = computeScore(results, benchmarkCategories)

    // 4. Display table
    console.log('\nCategory       Precision   Recall      F2          TP   FP   FN')
    console.log('─'.repeat(66))
    for (const [cat, s] of Object.entries(scores).sort()) {
      const p = `${(s.precision * 100).toFixed(1)}%`.padStart(8)
      const r = `${(s.recall * 100).toFixed(1)}%`.padStart(8)
      const f = `${(s.f2 * 100).toFixed(1)}%`.padStart(8)
      console.log(
        `${cat.padEnd(15)}${p}    ${r}    ${f}    ${String(s.tp).padStart(3)}  ${String(s.fp).padStart(3)}  ${String(s.fn).padStart(3)}`,
      )
    }

    // 5. Baseline comparison / creation
    const passed = checkRegression(scores)
    if (!passed) {
      console.error('\nBenchmark FAILED: recall regression detected')
      process.exit(1)
    }

    console.log('\nBenchmark PASSED')
  } finally {
    rmSync(bundleDir, { recursive: true, force: true })
  }
}

runBenchmark().catch((error) => {
  console.error('Benchmark error:', error)
  process.exit(1)
})
