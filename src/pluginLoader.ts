import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FilterPlugin, FilterPluginMatch, PIICategory, PIIMatch } from './types.js'

const pluginCache = new Map<string, Promise<readonly FilterPlugin[]>>()

// Plugin detect() receives unmasked text, so an error message may embed raw
// PII. Log only the first line, hard-capped, to keep it out of stderr.
const MAX_ERROR_MESSAGE_LENGTH = 160

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split('\n', 1)[0] ?? ''
  return firstLine.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${firstLine.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : firstLine
}

function resolvePluginPath(input: string): string | undefined {
  const expanded = input === '~' ? homedir() : input.replace(/^~\//, `${homedir()}/`)
  if (!isAbsolute(expanded)) return undefined

  const path = resolve(expanded)
  return existsSync(path) ? path : undefined
}

function isFilterPlugin(value: unknown): value is FilterPlugin {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as FilterPlugin).name === 'string' &&
    typeof (value as FilterPlugin).detect === 'function'
  )
}

async function loadPlugin(path: string): Promise<readonly FilterPlugin[]> {
  const loaded = await import(pathToFileURL(path).href)
  const candidates = [loaded.default, loaded.plugin, ...(Array.isArray(loaded.plugins) ? loaded.plugins : [])]
  return candidates.filter(isFilterPlugin)
}

export async function loadFilterPlugins(paths: readonly string[] = []): Promise<readonly FilterPlugin[]> {
  const plugins = await Promise.all(
    paths.map(async (configuredPath) => {
      const path = resolvePluginPath(configuredPath)
      if (!path) {
        process.stderr.write(`Ignoring PII plugin path: ${configuredPath}\n`)
        return []
      }

      let pending = pluginCache.get(path)
      if (!pending) {
        pending = loadPlugin(path).catch((error: unknown) => {
          process.stderr.write(`Failed to load PII plugin ${path}: ${describeError(error)}\n`)
          return []
        })
        pluginCache.set(path, pending)
      }
      return pending
    }),
  )

  return plugins.flat()
}

function isValidPluginMatch(match: FilterPluginMatch, text: string): boolean {
  return (
    Number.isInteger(match.start) &&
    Number.isInteger(match.end) &&
    match.start >= 0 &&
    match.end > match.start &&
    match.end <= text.length &&
    text.slice(match.start, match.end) === match.value
  )
}

export async function detectPluginPII(
  text: string,
  plugins: readonly FilterPlugin[],
): Promise<readonly PIIMatch[]> {
  const matches: PIIMatch[] = []

  for (const plugin of plugins) {
    try {
      const detected = await plugin.detect(text)
      for (const match of detected) {
        if (!isValidPluginMatch(match, text)) continue
        matches.push({
          text: match.value,
          category: match.category ?? plugin.name,
          start: match.start,
          end: match.end,
          confidence:
            typeof match.confidence === 'number' && match.confidence >= 0 && match.confidence <= 1
              ? match.confidence
              : 1,
        })
      }
    } catch (error) {
      process.stderr.write(`PII plugin ${plugin.name} failed: ${describeError(error)}\n`)
    }
  }

  return matches
}

export function resetPluginCache(): void {
  pluginCache.clear()
}
