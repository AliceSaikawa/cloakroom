import type { PIICategory, PIIMatch } from './types.js'
import { cacheOllamaMatches, getCachedOllamaMatches } from './ollamaCache.js'

type OllamaDetection = {
  readonly text: string
  readonly category: 'NAME' | 'ORG' | 'SCHOOL'
  readonly block: number
}

const OLLAMA_CATEGORIES: ReadonlySet<PIICategory> = new Set(['NAME', 'ORG', 'SCHOOL'])
const TIMEOUT_MS = 4_000
const TOTAL_BUDGET_MS = 4_000
const MAX_BATCH_CHARS = 3500

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

type ChunkDetectionResult = {
  readonly matches: readonly PIIMatch[]
  readonly cacheable: boolean
}

export async function detectOllamaPII(
  blocks: readonly { readonly index: number; readonly text: string }[],
  endpoint: string,
  model: string,
  enabledCategories: readonly PIICategory[],
): Promise<readonly PIIMatch[]> {
  const categorySet = new Set(enabledCategories)
  const shouldRun = [...OLLAMA_CATEGORIES].some((category) => categorySet.has(category))
  if (!shouldRun || blocks.length === 0) return []

  const uncachedBlocks: { readonly index: number; readonly text: string }[] = []
  const allMatches: PIIMatch[] = []
  for (const block of blocks) {
    const cached = getCachedOllamaMatches(block.text, endpoint, model)
    if (cached) allMatches.push(...cached)
    else uncachedBlocks.push(block)
  }

  const chunks = chunkBlocks(uncachedBlocks, MAX_BATCH_CHARS)
  const startedAt = Date.now()

  for (const chunk of chunks) {
    const elapsed = Date.now() - startedAt
    const remainingBudget = TOTAL_BUDGET_MS - elapsed
    if (remainingBudget <= 0) break

    const result = await detectChunk(chunk, endpoint, model, Math.min(TIMEOUT_MS, remainingBudget))
    allMatches.push(...result.matches)

    // Cache both positive and negative detections only after a valid model reply.
    if (result.cacheable) {
      for (const block of chunk) {
        cacheOllamaMatches(
          block.text,
          endpoint,
          model,
          result.matches.filter(
            (match) =>
              match.blockIndex === block.index &&
              match.start >= 0 &&
              match.end <= block.text.length &&
              block.text.slice(match.start, match.end) === match.text,
          ),
        )
      }
    }
  }

  return allMatches
}

function chunkBlocks(
  blocks: readonly { readonly index: number; readonly text: string }[],
  maxChars: number,
): readonly (readonly { readonly index: number; readonly text: string }[])[] {
  const chunks: { readonly index: number; readonly text: string }[][] = []
  let current: { readonly index: number; readonly text: string }[] = []
  let currentChars = 0

  for (const block of blocks) {
    if (currentChars + block.text.length > maxChars && current.length > 0) {
      chunks.push(current)
      current = []
      currentChars = 0
    }

    current.push(block)
    currentChars += block.text.length
  }

  if (current.length > 0) chunks.push(current)
  return chunks
}

async function detectChunk(
  blocks: readonly { readonly index: number; readonly text: string }[],
  endpoint: string,
  model: string,
  timeoutMs: number,
): Promise<ChunkDetectionResult> {
  const userPrompt = blocks.map((b) => `---BLOCK_${b.index}---\n${b.text}`).join('\n')
  const controller = new AbortController()

  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<ChunkDetectionResult>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort()
      resolve({ matches: [], cacheable: false })
    }, timeoutMs)
  })

  const requestPromise = (async (): Promise<ChunkDetectionResult> => {
    try {
      const response = await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          options: { temperature: 0, num_predict: 1024 },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: controller.signal,
      })

      if (!response.ok) return { matches: [], cacheable: false }

      const data = (await response.json()) as { readonly message?: { readonly content?: string } }
      if (typeof data.message?.content !== 'string') return { matches: [], cacheable: false }
      const matches = parseDetections(data.message.content, blocks)
      return matches ? { matches, cacheable: true } : { matches: [], cacheable: false }
    } catch {
      return { matches: [], cacheable: false }
    }
  })()

  try {
    return await Promise.race([requestPromise, timeoutPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function parseDetections(
  content: string,
  blocks: readonly { readonly index: number; readonly text: string }[],
): readonly PIIMatch[] | undefined {
  const cleaned = content
    .replace(/^```(?:json)?\s*\n?/m, '')
    .replace(/\n?```\s*$/m, '')
    .trim()

  const jsonMatch = cleaned.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return undefined

  let detections: readonly OllamaDetection[]
  try {
    detections = JSON.parse(jsonMatch[0]) as readonly OllamaDetection[]
  } catch {
    return undefined
  }

  if (!Array.isArray(detections)) return undefined

  const matches: PIIMatch[] = []
  for (const det of detections) {
    if (!det?.text || !det?.category) continue
    if (!['NAME', 'ORG', 'SCHOOL'].includes(det.category)) continue
    if (det.text.includes('@') || det.text.startsWith('http')) continue
    if (/^\[[A-Z_]+_\d+\]$/.test(det.text)) continue

    let normalizedText = det.text
    if (det.category === 'NAME') normalizedText = stripHonorifics(normalizedText)
    if (!normalizedText) continue

    const block = blocks.find((b) => b.index === det.block)
    if (!block) continue

    let searchStart = 0
    while (true) {
      const idx = block.text.indexOf(normalizedText, searchStart)
      if (idx === -1) break
      matches.push({
        text: normalizedText,
        category: det.category,
        start: idx,
        end: idx + normalizedText.length,
        confidence: 0.8,
        blockIndex: block.index,
      })
      searchStart = idx + normalizedText.length
    }
  }

  return matches
}

function stripHonorifics(name: string): string {
  return name.replace(JP_HONORIFICS, '').trim()
}
