import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { deriveKey, loadOrCreateKey } from './keys.js'
import type { PIICategory, PIIMatch } from './types.js'

type CachedMatch = {
  readonly start: number
  readonly end: number
  readonly category: PIICategory
  readonly confidence: number
}

type CacheEntry = {
  readonly savedAt: number
  readonly matches: readonly CachedMatch[]
}

type CacheFile = {
  readonly version: 1
  readonly entries: Record<string, CacheEntry>
}

const CACHE_PATH = join(homedir(), '.claude', 'cloakroom-ollama-cache.json')
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 2_000
// Bump when the detection prompt or match interpretation changes.
const DETECTOR_VERSION = 'v1'

let loaded = false
let cache = new Map<string, CacheEntry>()
let cacheKey: Buffer | undefined

function getCacheKey(): Buffer {
  cacheKey ??= deriveKey(loadOrCreateKey(), 'cloakroom-ollama-cache-v1')
  return cacheKey
}

function makeCacheId(text: string, endpoint: string, model: string): string {
  return createHmac('sha256', getCacheKey())
    .update(DETECTOR_VERSION)
    .update('\0')
    .update(endpoint)
    .update('\0')
    .update(model)
    .update('\0')
    .update(text)
    .digest('hex')
}

function isCachedMatch(value: unknown): value is CachedMatch {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  const start = item['start']
  const end = item['end']
  const category = item['category']
  const confidence = item['confidence']
  return (
    typeof start === 'number' &&
    Number.isInteger(start) &&
    start >= 0 &&
    typeof end === 'number' &&
    Number.isInteger(end) &&
    end > start &&
    typeof category === 'string' &&
    ['NAME', 'ORG', 'SCHOOL'].includes(category) &&
    typeof confidence === 'number' &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1
  )
}

function loadCache(): void {
  if (loaded) return
  loaded = true
  if (!existsSync(CACHE_PATH)) return

  try {
    const data = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as CacheFile
    if (data.version !== 1 || !data.entries || typeof data.entries !== 'object') return

    const now = Date.now()
    cache = new Map(
      Object.entries(data.entries)
        .filter(([, entry]) => {
          return (
            entry &&
            typeof entry.savedAt === 'number' &&
            Number.isFinite(entry.savedAt) &&
            entry.savedAt <= now &&
            now - entry.savedAt <= CACHE_TTL_MS &&
            Array.isArray(entry.matches) &&
            entry.matches.every(isCachedMatch)
          )
        })
        .slice(-MAX_CACHE_ENTRIES),
    )
  } catch {
    cache = new Map()
  }
}

function saveCache(): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true, mode: 0o700 })
    const tempPath = `${CACHE_PATH}.${process.pid}.tmp`
    const entries = Object.fromEntries(cache)
    writeFileSync(tempPath, JSON.stringify({ version: 1, entries }), { mode: 0o600 })
    renameSync(tempPath, CACHE_PATH)
  } catch {
    // Cache failures must never prevent filtering from continuing.
  }
}

export function getCachedOllamaMatches(
  text: string,
  endpoint: string,
  model: string,
): readonly PIIMatch[] | undefined {
  try {
    loadCache()
    const id = makeCacheId(text, endpoint, model)
    const entry = cache.get(id)
    if (!entry) return undefined

    cache.delete(id)
    cache.set(id, entry)
    return entry.matches.flatMap((match) => {
      if (match.start < 0 || match.end <= match.start || match.end > text.length) return []
      const value = text.slice(match.start, match.end)
      return value
        ? [{ text: value, category: match.category, start: match.start, end: match.end, confidence: match.confidence }]
        : []
    })
  } catch {
    return undefined
  }
}

export function cacheOllamaMatches(
  text: string,
  endpoint: string,
  model: string,
  matches: readonly PIIMatch[],
): void {
  try {
    loadCache()

    const entry: CacheEntry = {
      savedAt: Date.now(),
      matches: matches.map(({ start, end, category, confidence }) => ({ start, end, category, confidence })),
    }
    cache.set(makeCacheId(text, endpoint, model), entry)

    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value as string | undefined
      if (!oldest) break
      cache.delete(oldest)
    }
    saveCache()
  } catch {
    // Cache failures must never prevent filtering from continuing.
  }
}
