// Hard PII detection test cases
// Tests edge cases that are difficult for both regex and LLM
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

const JP_HONORIFICS = /(?:さん|さま|様|殿|氏|先生|くん|君|ちゃん|先輩|後輩|部長|課長|社長|会長|教授|博士)$/

// ---- Test cases ----
const TEST_CASES = [
  {
    name: '1. 人名 vs 一般名詞の区別',
    text: `森さんが森林公園で待っている。橋本部長から橋についての報告書が届いた。
松本さんは松本市の出身です。川上課長と川上ダムの視察に行った。`,
    expected: { hit: ['森', '橋本', '松本', '川上'], miss: ['森林公園', '橋', '松本市', '川上ダム'] },
  },
  {
    name: '2. コード中の人名 vs 変数名',
    text: `const tanaka = getUserById(123) // 田中さんのデータ
function suzuki_handler() { return "鈴木" }
// Author: 佐藤健太 <[EMAIL_1]>
// Reviewer: yamada-taro
const COMPANY_NAME = "LINE株式会社"`,
    expected: { hit: ['田中', '鈴木', '佐藤健太', 'LINE株式会社'], miss: ['tanaka', 'suzuki_handler', 'getUserById'] },
  },
  {
    name: '3. 英語の曖昧な固有名詞',
    text: `Jordan reviewed the PR. The Jordan River flows through the valley.
Apple released a new SDK. Cook announced the changes at Apple Park.
Amazon Web Services had an outage. They shipped the package via Amazon.`,
    expected: { hit: ['Jordan', 'Cook', 'Apple', 'Amazon Web Services', 'Amazon'], miss: ['Jordan River', 'SDK', 'PR'] },
  },
  {
    name: '4. 日本の組織名バリエーション',
    text: `株式会社サイバーエージェントの決算報告。メルカリが新サービスを発表。
厚生労働省のガイドラインに従う。NTTドコモとKDDIが提携。
弊社ディー・エヌ・エーとしては対応を検討中。`,
    expected: { hit: ['株式会社サイバーエージェント', 'メルカリ', '厚生労働省', 'NTTドコモ', 'KDDI', 'ディー・エヌ・エー'], miss: ['ガイドライン', '決算報告'] },
  },
  {
    name: '5. 学校名のバリエーション',
    text: `慶應義塾大学を卒業後、MIT Media Labで研究。
開成高校から東京大学理科三類に合格。Stanford Universityの博士課程。
プログラミングスクールに通った。school変数を初期化する。`,
    expected: { hit: ['慶應義塾大学', 'MIT Media Lab', '開成高校', '東京大学', 'Stanford University'], miss: ['プログラミングスクール', 'school'] },
  },
  {
    name: '6. git log / コミットメッセージ',
    text: `commit abc1234
Author: Takeshi Yamamoto <[EMAIL_2]>
Date:   Mon Mar 31 2026

    fix: resolve auth issue reported by 高橋

commit def5678
Author: Sarah Chen <[EMAIL_3]>

    feat: add dashboard for 楽天グループ integration`,
    expected: { hit: ['Takeshi Yamamoto', '高橋', 'Sarah Chen', '楽天グループ'], miss: ['auth', 'dashboard'] },
  },
  {
    name: '7. 中国語・韓国語の人名',
    text: `李明さんと王小红が北京大学の同窓会に参加。
김민수エンジニアがSamsungのプロジェクトをリード。
张伟がHuaweiからBaiduに転職した。`,
    expected: { hit: ['李明', '王小红', '北京大学', '김민수', 'Samsung', '张伟', 'Huawei', 'Baidu'], miss: ['同窓会', 'プロジェクト'] },
  },
  {
    name: '8. SNSハンドル・ユーザー名',
    text: `@tanaka_dev がissueを報告。GitHubユーザー yamada-123 がPRを送った。
Slackで suzuki.ichiro に連絡してください。`,
    expected: { hit: ['tanaka_dev', 'yamada-123', 'suzuki.ichiro'], miss: ['issue', 'PR', 'Slack', 'GitHub'] },
  },
]

async function runTest(testCase) {
  const text = `---BLOCK_0---\n${testCase.text}`

  try {
    const response = await fetch(`${ENDPOINT}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
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
    if (!jsonMatch) return { detections: [], raw: content }

    const detections = JSON.parse(jsonMatch[0])
    // Post-process: strip honorifics
    return {
      detections: detections.map(d => ({
        ...d,
        text: d.category === 'NAME' ? d.text.replace(JP_HONORIFICS, '').trim() : d.text,
      })).filter(d => !d.text.includes('@') && !/^\[/.test(d.text) && d.text.length > 0),
      raw: content,
    }
  } catch (err) {
    return { detections: [], raw: `ERROR: ${err.message}` }
  }
}

async function main() {
  console.log('=== Hard PII Detection Test Suite ===\n')

  let totalExpectedHits = 0, totalActualHits = 0
  let totalFalsePositives = 0
  const allMissed = []

  for (const tc of TEST_CASES) {
    console.log(`\n${tc.name}`)
    const { detections } = await runTest(tc)
    const foundTexts = detections.map(d => d.text)

    // Check expected hits
    for (const exp of tc.expected.hit) {
      totalExpectedHits++
      const found = foundTexts.some(f => f === exp || f.includes(exp) || exp.includes(f))
      if (found) {
        totalActualHits++
        process.stdout.write(`  HIT  ${exp}\n`)
      } else {
        allMissed.push({ test: tc.name, text: exp })
        process.stdout.write(`  MISS ${exp}\n`)
      }
    }

    // Check false positives
    for (const fp of tc.expected.miss) {
      const falsely = foundTexts.some(f => f === fp || f.includes(fp))
      if (falsely) {
        totalFalsePositives++
        process.stdout.write(`  FALSE+ ${fp}\n`)
      }
    }

    // Show unexpected detections
    const allExpected = [...tc.expected.hit, ...tc.expected.miss]
    for (const d of detections) {
      if (!allExpected.some(e => e === d.text || e.includes(d.text) || d.text.includes(e))) {
        process.stdout.write(`  EXTRA [${d.category}] "${d.text}"\n`)
      }
    }
  }

  console.log('\n\n=== SUMMARY ===')
  console.log(`Hit rate: ${totalActualHits}/${totalExpectedHits} (${(totalActualHits/totalExpectedHits*100).toFixed(0)}%)`)
  console.log(`False positives: ${totalFalsePositives}`)

  if (allMissed.length > 0) {
    console.log('\nMissed items (candidates for dictionary):')
    for (const m of allMissed) {
      console.log(`  "${m.text}" — ${m.test}`)
    }
  }
}

main().catch(console.error)
