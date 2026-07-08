import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type PIIFilterConfig } from './types.js'

const CONFIG_PATH = join(homedir(), '.claude', 'pii-filter.json')

let loadedConfig: PIIFilterConfig | null = null

export function loadPIIConfig(): PIIFilterConfig {
  if (loadedConfig) return loadedConfig

  if (process.env['CLAUDE_PII_FILTER'] === '0') {
    loadedConfig = { ...DEFAULT_CONFIG, enabled: false }
    return loadedConfig
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    loadedConfig = {
      enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
      categories: parsed.categories ?? DEFAULT_CONFIG.categories,
      customPatterns: parsed.customPatterns ?? DEFAULT_CONFIG.customPatterns,
      dictionary: parsed.dictionary ?? DEFAULT_CONFIG.dictionary,
      allowlist: parsed.allowlist ?? DEFAULT_CONFIG.allowlist,
    }
  } catch {
    loadedConfig = DEFAULT_CONFIG
  }

  return loadedConfig
}

export function resetPIIConfigCache(): void {
  loadedConfig = null
}
