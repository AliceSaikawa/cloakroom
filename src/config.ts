import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  DEFAULT_CONFIG,
  type CategoryAction,
  type CategoryOption,
  type CustomCategoryConfig,
  type CustomPatternEntry,
  type DictionaryEntry,
  type FpeConfig,
  type PIICategory,
  type PIIFilterConfig,
  type ResponseDetectionConfig,
} from './types.js'

const DEFAULT_CONFIG_PATH = join(homedir(), '.claude', 'pii-filter.json')

let loadedConfig: PIIFilterConfig | null = null

const VALID_CATEGORY_ACTIONS = new Set<string>(['mask', 'block', 'warn'])

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isCustomPattern(value: unknown): value is CustomPatternEntry {
  return isJsonObject(value) && typeof value['name'] === 'string' && typeof value['pattern'] === 'string'
}

function isCustomCategory(value: unknown): value is CustomCategoryConfig {
  return isJsonObject(value) && typeof value['name'] === 'string'
}

function isDictionaryEntry(value: unknown): value is DictionaryEntry {
  return isJsonObject(value) && typeof value['text'] === 'string' && typeof value['category'] === 'string'
}

function readStringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : fallback
}

function mergeConfigObjects(base: JsonObject, override: JsonObject): JsonObject {
  const merged: JsonObject = { ...base }

  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key]
    if (isJsonObject(existing) && isJsonObject(value)) {
      merged[key] = mergeConfigObjects(existing, value)
    } else {
      // Arrays replace earlier arrays so an including file can set a full list.
      merged[key] = value
    }
  }

  return merged
}

function readConfigFile(path: string, ancestors: ReadonlySet<string> = new Set()): JsonObject {
  const absolutePath = resolve(path)
  if (ancestors.has(absolutePath)) {
    throw new Error(`Circular config include: ${absolutePath}`)
  }

  const parsed: unknown = JSON.parse(readFileSync(absolutePath, 'utf8'))
  if (!isJsonObject(parsed)) {
    throw new Error(`Config must contain a JSON object: ${absolutePath}`)
  }

  const nextAncestors = new Set(ancestors)
  nextAncestors.add(absolutePath)
  const includes = typeof parsed['include'] === 'string'
    ? [parsed['include']]
    : Array.isArray(parsed['include'])
      ? parsed['include']
      : []

  let combined: JsonObject = {}
  for (const include of includes) {
    if (typeof include !== 'string' || !include.trim()) {
      throw new Error(`Config include entries must be non-empty paths: ${absolutePath}`)
    }
    const includePath = isAbsolute(include) ? include : join(dirname(absolutePath), include)
    combined = mergeConfigObjects(combined, readConfigFile(includePath, nextAncestors))
  }

  const ownConfig = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'include'))
  return mergeConfigObjects(combined, ownConfig)
}

export function getConfigPath(): string {
  const configuredPath = process.env['PII_FILTER_CONFIG']
  return configuredPath ? resolve(configuredPath) : DEFAULT_CONFIG_PATH
}

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
  const result = {
    ...(typeof obj['enabled'] === 'boolean' ? { enabled: obj['enabled'] } : {}),
    ...(Array.isArray(obj['categories'])
      ? { categories: obj['categories'].filter((c): c is string => typeof c === 'string') as PIICategory[] }
      : {}),
    ...(obj['categoryActions'] ? { categoryActions: parseCategoryActions(obj['categoryActions']) } : {}),
  }
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
    const parsed = readConfigFile(getConfigPath())
    const auditLog = {
      ...DEFAULT_CONFIG.auditLog,
      ...(isJsonObject(parsed['auditLog']) ? parsed['auditLog'] : {}),
    }
    const allowRemoteOllama = parsed['allowRemoteOllama'] === true

    const config: PIIFilterConfig = {
      enabled: typeof parsed['enabled'] === 'boolean' ? parsed['enabled'] : DEFAULT_CONFIG.enabled,
      mode:
        parsed['mode'] === 'anonymize' || parsed['mode'] === 'fake'
          ? parsed['mode']
          : DEFAULT_CONFIG.mode,
      placeholderFormat: parsed['placeholderFormat'] === 'legacy' ? 'legacy' : 'xml',
      placeholderInstructionEnabled: parsed['placeholderInstructionEnabled'] === true,
      blockNonText: parsed['blockNonText'] === true,
      maxRequestBodyBytes: normalizeMaxRequestBodyBytes(parsed['maxRequestBodyBytes']),
      categories: readStringArray(parsed['categories'], DEFAULT_CONFIG.categories) as readonly PIICategory[],
      ollamaEndpoint: normalizeOllamaEndpoint(parsed['ollamaEndpoint'], allowRemoteOllama),
      allowRemoteOllama,
      ollamaModel: typeof parsed['ollamaModel'] === 'string' ? parsed['ollamaModel'] : DEFAULT_CONFIG.ollamaModel,
      ollamaEnabled: typeof parsed['ollamaEnabled'] === 'boolean' ? parsed['ollamaEnabled'] : DEFAULT_CONFIG.ollamaEnabled,
      heuristicNerEnabled: typeof parsed['heuristicNerEnabled'] === 'boolean' ? parsed['heuristicNerEnabled'] : DEFAULT_CONFIG.heuristicNerEnabled,
      customPatterns: Array.isArray(parsed['customPatterns'])
        ? parsed['customPatterns'].filter(isCustomPattern)
        : DEFAULT_CONFIG.customPatterns,
      customCategories: Array.isArray(parsed['customCategories'])
        ? parsed['customCategories'].filter(isCustomCategory)
        : DEFAULT_CONFIG.customCategories,
      plugins: Array.isArray(parsed['plugins'])
        ? parsed['plugins'].filter((plugin: unknown): plugin is string => typeof plugin === 'string')
        : DEFAULT_CONFIG.plugins,
      dictionary: Array.isArray(parsed['dictionary'])
        ? parsed['dictionary'].filter(isDictionaryEntry)
        : DEFAULT_CONFIG.dictionary,
      allowlist: readStringArray(parsed['allowlist'], DEFAULT_CONFIG.allowlist),
      categoryActions: parseCategoryActions(parsed['categoryActions']),
      categoryOptions: parseCategoryOptions(parsed['categoryOptions']),
      responseDetection: parseResponseDetection(parsed['responseDetection']),
      providerOverrides: parseProviderOverrides(parsed['providerOverrides']),
      vaultEnabled: parsed['vaultEnabled'] === true,
      vaultTtlMinutes:
        typeof parsed['vaultTtlMinutes'] === 'number' && parsed['vaultTtlMinutes'] > 0
          ? parsed['vaultTtlMinutes']
          : DEFAULT_CONFIG.vaultTtlMinutes,
      fpe: parseFpeConfig(parsed['fpe']),
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
    loadedConfig = config
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      process.stderr.write(`Unable to load PII filter config: ${String(error)}\n`)
    }
    loadedConfig = DEFAULT_CONFIG
  }

  const config = loadedConfig ?? DEFAULT_CONFIG
  if (config.fpe?.enabled && config.mode === 'anonymize') {
    process.stderr.write(
      'Warning: fpe.enabled has no effect in anonymize mode — responses are never restored.\n',
    )
  }

  return config
}

export function resetPIIConfigCache(): void {
  loadedConfig = null
}

export function reloadPIIConfig(): PIIFilterConfig {
  resetPIIConfigCache()
  return loadPIIConfig()
}
