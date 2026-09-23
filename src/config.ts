import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type CategoryAction, type CategoryOption, type FpeConfig, type PIIFilterConfig, type ResponseDetectionConfig } from './types.js'

const CONFIG_PATH = join(homedir(), '.claude', 'pii-filter.json')

let loadedConfig: PIIFilterConfig | null = null

const VALID_CATEGORY_ACTIONS = new Set<string>(['mask', 'block', 'warn'])

function parseFpeConfig(raw: unknown): FpeConfig {
  const defaults = DEFAULT_CONFIG.fpe ?? { enabled: false }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults
  const obj = raw as Record<string, unknown>
  const enabled = typeof obj['enabled'] === 'boolean' ? obj['enabled'] : defaults.enabled
  const categories = Array.isArray(obj['categories'])
    ? obj['categories'].filter((c): c is string => typeof c === 'string')
    : undefined
  return { enabled, ...(categories ? { categories } : {}) }
}

function parseResponseDetection(raw: unknown): ResponseDetectionConfig {
  const defaults = DEFAULT_CONFIG.responseDetection!
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults
  const obj = raw as Record<string, unknown>
  return {
    enabled: typeof obj['enabled'] === 'boolean' ? obj['enabled'] : defaults.enabled,
    action: 'warn',
  }
}

function parseProviderOverride(
  raw: unknown,
): Partial<Pick<PIIFilterConfig, 'enabled' | 'categories' | 'categoryActions'>> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const result: {
    enabled?: PIIFilterConfig['enabled']
    categories?: PIIFilterConfig['categories']
    categoryActions?: PIIFilterConfig['categoryActions']
  } = {}
  if (typeof obj['enabled'] === 'boolean') result.enabled = obj['enabled']
  if (Array.isArray(obj['categories'])) {
    result.categories = obj['categories'].filter((c): c is string => typeof c === 'string')
  }
  if (obj['categoryActions']) result.categoryActions = parseCategoryActions(obj['categoryActions'])
  return Object.keys(result).length > 0 ? result : undefined
}

function parseProviderOverrides(
  raw: unknown,
): Partial<Record<'anthropic' | 'openai', Partial<Pick<PIIFilterConfig, 'enabled' | 'categories' | 'categoryActions'>>>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const obj = raw as Record<string, unknown>
  const result: Partial<Record<'anthropic' | 'openai', Partial<Pick<PIIFilterConfig, 'enabled' | 'categories' | 'categoryActions'>>>> = {}
  for (const kind of ['anthropic', 'openai'] as const) {
    const override = parseProviderOverride(obj[kind])
    if (override) result[kind] = override
  }
  return result
}

function parseCategoryOptions(raw: unknown): Partial<Record<string, CategoryOption>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: Partial<Record<string, CategoryOption>> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>
      if (typeof obj['preserve'] === 'string') {
        result[key] = { preserve: obj['preserve'] } as CategoryOption
      }
    }
  }
  return result
}

function parseCategoryActions(raw: unknown): Partial<Record<string, CategoryAction>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: Partial<Record<string, CategoryAction>> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && VALID_CATEGORY_ACTIONS.has(value)) {
      result[key] = value as CategoryAction
    }
  }
  return result
}

function normalizeMaxRequestBodyBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return DEFAULT_CONFIG.maxRequestBodyBytes
  }
  return value
}

function parseUpstreams(raw: unknown): Partial<Record<'anthropic' | 'openai', string>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}

  const parsed: Partial<Record<'anthropic' | 'openai', string>> = {}
  for (const provider of ['anthropic', 'openai'] as const) {
    const value = (raw as Record<string, unknown>)[provider]
    if (typeof value !== 'string') continue

    try {
      const url = new URL(value)
      const isLoopback = isLoopbackHost(url.hostname)
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        (url.protocol === 'http:' && !isLoopback) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        continue
      }

      parsed[provider] = url.toString().replace(/\/$/u, '')
    } catch {
      // Invalid custom URLs fall back to the built-in provider endpoint.
    }
  }

  return parsed
}

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
      mode:
        parsed.mode === 'anonymize' || parsed.mode === 'fake'
          ? parsed.mode
          : DEFAULT_CONFIG.mode,
      maxRequestBodyBytes: normalizeMaxRequestBodyBytes(parsed.maxRequestBodyBytes),
      categories: parsed.categories ?? DEFAULT_CONFIG.categories,
      ollamaEndpoint: normalizeOllamaEndpoint(parsed.ollamaEndpoint, allowRemoteOllama),
      allowRemoteOllama,
      ollamaModel: parsed.ollamaModel ?? DEFAULT_CONFIG.ollamaModel,
      ollamaEnabled: parsed.ollamaEnabled ?? DEFAULT_CONFIG.ollamaEnabled,
      heuristicNerEnabled: parsed.heuristicNerEnabled ?? DEFAULT_CONFIG.heuristicNerEnabled,
      customPatterns: parsed.customPatterns ?? DEFAULT_CONFIG.customPatterns,
      customCategories: parsed.customCategories ?? DEFAULT_CONFIG.customCategories,
      plugins: Array.isArray(parsed.plugins)
        ? parsed.plugins.filter((plugin: unknown): plugin is string => typeof plugin === 'string')
        : DEFAULT_CONFIG.plugins,
      dictionary: parsed.dictionary ?? DEFAULT_CONFIG.dictionary,
      allowlist: parsed.allowlist ?? DEFAULT_CONFIG.allowlist,
      categoryActions: parseCategoryActions(parsed.categoryActions),
      categoryOptions: parseCategoryOptions(parsed.categoryOptions),
      responseDetection: parseResponseDetection(parsed.responseDetection),
      providerOverrides: parseProviderOverrides(parsed.providerOverrides),
      vaultEnabled: parsed.vaultEnabled === true,
      vaultTtlMinutes:
        typeof parsed.vaultTtlMinutes === 'number' && parsed.vaultTtlMinutes > 0
          ? parsed.vaultTtlMinutes
          : DEFAULT_CONFIG.vaultTtlMinutes,
      fpe: parseFpeConfig(parsed.fpe),
      upstreams: parseUpstreams(parsed.upstreams),
      allowUnfilteredBodyRequests: parsed.allowUnfilteredBodyRequests === true,
      statefulSessionMappings: parsed.statefulSessionMappings === true,
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

  if (loadedConfig.fpe?.enabled && loadedConfig.mode === 'anonymize') {
    process.stderr.write(
      'Warning: fpe.enabled has no effect in anonymize mode — responses are never restored.\n',
    )
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
