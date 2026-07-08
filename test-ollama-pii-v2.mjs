// Test improved Ollama PII detection
const ENDPOINT = 'http://localhost:11434'
const MODEL = 'gemma3:4b'

const SYSTEM_PROMPT = `You are a PII detector. Extract person names, organization names, and school names from the text.

Output: JSON array only. No markdown fences, no explanation.
Format: [{"text": "exact name", "category": "NAME"|"ORG"|"SCHOOL", "block": N}]

NAME rules:
- Extract the name WITHOUT honorifics/suffixes. "田中太郎さん" → "田中太郎", "Mr. Smith" → "Smith", "鈴木先生" → "鈴木"
- Include full names and family names: 田中太郎, 山田, John Smith, 李明
- Include usernames/handles that are clearly personal identifiers
- Do NOT extract: pronouns (彼, she), generic roles (エンジニア, manager)

ORG rules:
- Company names: Google, Anthropic, 株式会社サイバーエージェント, Meta, OpenAI
- Government agencies: 総務省, FBI, 厚生労働省
- Non-profits, foundations, teams
- Include tech companies, startups, and well-known organizations
- Do NOT extract: product names (Chrome, React), programming terms, package names

SCHOOL rules:
- Universities: 東京大学, MIT, Stanford University
- Schools: 開成高校, 灘中学校
- Do NOT extract: online course platforms, generic "school"

EXCLUDE from all categories:
- File paths, URLs, email addresses (already handled by regex)
- Function names, variable names, CLI commands
- Strings that are already wrapped in [BRACKETS]
- Common nouns, adjectives, generic terms

If no PII found, return []`

// Simulate post-regex text (emails already replaced)
const testText = `---BLOCK_0---
田中太郎さんはAnthropicでエンジニアとして働いています。
彼は東京大学の出身で、以前はGoogleに勤めていました。
連絡先: [EMAIL_1]

---BLOCK_1---
// config.js
const author = "山田花子"
const company = "株式会社サイバーエージェント"
const framework = "React"
const tool = "Claude Code"
`

async function main() {
  console.log('Testing improved Ollama PII detection...\n')

  const response = await fetch(`${ENDPOINT}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: testText },
      ],
      stream: false,
      options: { temperature: 0, num_predict: 1024 },
    }),
    signal: AbortSignal.timeout(30000),
  })

  const data = await response.json()
  const content = data.message?.content ?? ''

  // Strip markdown fences
  const cleaned = content.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim()
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/)
  const detections = JSON.parse(jsonMatch[0])

  console.log('Detections:')
  for (const d of detections) {
    // Strip honorifics for NAME
    let text = d.text
    if (d.category === 'NAME') {
      text = text.replace(/(?:さん|さま|様|殿|氏|先生|くん|君|ちゃん)$/, '')
    }
    const skip = text.includes('@') || text.startsWith('http') || /^\[[A-Z_]+_\d+\]$/.test(text)
    console.log(`  ${skip ? 'SKIP' : 'OK  '} [${d.category}] "${d.text}"${text !== d.text ? ` → "${text}"` : ''} (block ${d.block})`)
  }

  // Check expected
  const expected = {
    '田中太郎': 'NAME',
    '山田花子': 'NAME',
    'Anthropic': 'ORG',
    'Google': 'ORG',
    '東京大学': 'SCHOOL',
    '株式会社サイバーエージェント': 'ORG',
  }
  const shouldNotDetect = ['React', 'Claude Code', '[EMAIL_1]', 'エンジニア']

  console.log('\n--- Accuracy Check ---')
  const foundTexts = detections.map(d => {
    let t = d.text
    if (d.category === 'NAME') t = t.replace(/(?:さん|さま|様|殿|氏|先生|くん|君|ちゃん)$/, '')
    return t
  }).filter(t => !t.includes('@') && !/^\[/.test(t))

  let hits = 0, misses = 0
  for (const [text, cat] of Object.entries(expected)) {
    const found = foundTexts.includes(text)
    console.log(`  ${found ? 'HIT ' : 'MISS'} ${text} (${cat})`)
    found ? hits++ : misses++
  }

  let falsePositives = 0
  for (const text of foundTexts) {
    if (shouldNotDetect.includes(text)) {
      console.log(`  FALSE+ ${text}`)
      falsePositives++
    }
  }

  console.log(`\nPrecision: ${hits}/${hits + misses} expected, ${falsePositives} false positives`)
}

main().catch(console.error)
