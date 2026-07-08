import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type PIIFilterConfig } from './types.js'

const CONFIG_PATH = join(homedir(), '.claude', 'pii-filter.json')

let loadedConfig: PIIFilterConfig | null = null

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.')
}

export function normalizeOllamaEndpoint(endpoint: unknown, allowRemote: boolean): string {
  if (typeof endpoint !== 'string') return DEFAULT_CONFIG.ollamaEndpoint

  try {
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol)) return DEFAULT_CONFIG.ollamaEndpoint
    if (allowRemote || isLoopbackHost(url.hostname)) return url.origin
  } catch {
    return DEFAULT_CONFIG.ollamaEndpoint
  }

  process.stderr.write(
    `Ignoring non-loopback ollamaEndpoint "${endpoint}". Set allowRemoteOllama: true to allow it.\n`,
  )
  return DEFAULT_CONFIG.ollamaEndpoint
}

export function loadPIIConfig(): PIIFilterConfig {
  if (loadedConfig) return loadedConfig

  if (process.env['CLAUDE_PII_FILTER'] === '0') {
    loadedConfig = { ...DEFAULT_CONFIG, enabled: false }
    return loadedConfig
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    const auditLog = {
      ...DEFAULT_CONFIG.auditLog,
      ...(parsed.auditLog ?? {}),
    }
    const allowRemoteOllama = parsed.allowRemoteOllama === true

    loadedConfig = {
      enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
      mode: parsed.mode === 'anonymize' ? 'anonymize' : DEFAULT_CONFIG.mode,
      categories: parsed.categories ?? DEFAULT_CONFIG.categories,
      ollamaEndpoint: normalizeOllamaEndpoint(parsed.ollamaEndpoint, allowRemoteOllama),
      allowRemoteOllama,
      ollamaModel: parsed.ollamaModel ?? DEFAULT_CONFIG.ollamaModel,
      ollamaEnabled: parsed.ollamaEnabled ?? DEFAULT_CONFIG.ollamaEnabled,
      customPatterns: parsed.customPatterns ?? DEFAULT_CONFIG.customPatterns,
      customCategories: parsed.customCategories ?? DEFAULT_CONFIG.customCategories,
      dictionary: parsed.dictionary ?? DEFAULT_CONFIG.dictionary,
      allowlist: parsed.allowlist ?? DEFAULT_CONFIG.allowlist,
      auditLog: {
        enabled: Boolean(auditLog.enabled),
        destination: auditLog.destination === 'file' ? 'file' : 'stderr',
        path: typeof auditLog.path === 'string' ? auditLog.path : undefined,
        reviewThreshold:
          typeof auditLog.reviewThreshold === 'number'
            ? auditLog.reviewThreshold
            : DEFAULT_CONFIG.auditLog.reviewThreshold,
      },
    }
  } catch {
    loadedConfig = DEFAULT_CONFIG
  }

  return loadedConfig
}

export function resetPIIConfigCache(): void {
  loadedConfig = null
}

export function reloadPIIConfig(): PIIFilterConfig {
  resetPIIConfigCache()
  return loadPIIConfig()
}
