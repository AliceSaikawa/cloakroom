import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  disableCategory,
  enableCategory,
  getActiveCategories,
  getControlStatus,
  resetControlState,
  setPassthroughEnabled,
} from '../core/controlState.js'
import { resolveConfiguredCategory } from '../core/controlCategory.js'
import { loadPIIConfig, reloadPIIConfig } from '../core/config.js'
import { resetPluginCache } from '../core/pluginLoader.js'
import { getSnapshot } from '../core/stats.js'
import type { PIICategory, PIIFilterConfig } from '../core/types.js'
import type { SessionFilterStore } from './sessionFilterStore.js'
import { writeJson } from './httpUtils.js'

function getConfiguredCategories(config: PIIFilterConfig): readonly PIICategory[] {
  const customCategories = config.customCategories
    .filter((category) => category.enabled !== false)
    .map((category) => category.name)
  const customPatternCategories = config.customPatterns.map((pattern) => pattern.category ?? pattern.name)
  return [...new Set([...config.categories, ...customCategories, ...customPatternCategories])]
}

export function reloadRuntimeConfig(sessionFilters: SessionFilterStore): void {
  const config = reloadPIIConfig()
  resetPluginCache()
  // Keep each MappingTable so in-flight responses can still restore values.
  sessionFilters.reload(config)
}

function writeControlStatus(res: ServerResponse): void {
  const status = getControlStatus()
  const config = loadPIIConfig()
  writeJson(res, 200, {
    ...status,
    filterEnabled: config.enabled && !status.passthroughEnabled,
    activeCategories: getActiveCategories(getConfiguredCategories(config)),
  })
}

function getControlCategory(req: IncomingMessage, prefix: string): string | undefined {
  const path = req.url?.split('?')[0] ?? '/'
  if (!path.startsWith(prefix)) return undefined
  const rawCategory = path.slice(prefix.length)
  if (!rawCategory) return undefined
  return decodeURIComponent(rawCategory).trim()
}

function escapeMetricLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

export function handleControlRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sessionFilters: SessionFilterStore,
): boolean {
  const path = req.url?.split('?')[0] ?? '/'

  if (req.method === 'GET' && path === '/control/status') {
    writeControlStatus(res)
    return true
  }

  if (req.method === 'GET' && path === '/control/stats') {
    writeJson(res, 200, getSnapshot(sessionFilters.activeSessionCount()))
    return true
  }

  if (req.method === 'GET' && path === '/metrics') {
    const snap = getSnapshot(sessionFilters.activeSessionCount())
    const lines: string[] = [
      `cloakroom_masked_requests_total ${snap.maskedRequests}`,
      `cloakroom_restored_placeholders_total ${snap.restoredPlaceholders}`,
      `cloakroom_unresolved_placeholders_total ${snap.unresolvedPlaceholders}`,
      `cloakroom_passthrough_requests_total ${snap.passthroughRequests}`,
      `cloakroom_active_sessions ${snap.activeSessions}`,
      ...Object.entries(snap.detectionsByCategory).map(
        ([category, count]) => `cloakroom_detections_total{category="${escapeMetricLabel(category)}"} ${count}`,
      ),
      ...Object.entries(snap.passthroughByPath).map(
        ([p, count]) => `cloakroom_passthrough_by_path_total{path="${escapeMetricLabel(p)}"} ${count}`,
      ),
    ]
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
    res.end(lines.join('\n') + '\n')
    return true
  }

  if (req.method === 'POST' && path === '/control/passthrough') {
    setPassthroughEnabled(true)
    writeControlStatus(res)
    return true
  }

  if (req.method === 'POST' && path === '/control/filter') {
    // フィルタ再開 = passthrough解除 + 個別disable も全リセット
    resetControlState()
    writeControlStatus(res)
    return true
  }

  if (req.method === 'POST' && path === '/control/reload') {
    reloadRuntimeConfig(sessionFilters)
    writeControlStatus(res)
    return true
  }

  if (req.method === 'POST') {
    const disabledCategory = getControlCategory(req, '/control/disable/')
    if (disabledCategory) {
      const category = resolveConfiguredCategory(disabledCategory, loadPIIConfig())
      if (!category) {
        writeJson(res, 400, { error: `Unknown PII category: ${disabledCategory}` })
        return true
      }

      disableCategory(category)
      writeControlStatus(res)
      return true
    }

    const enabledCategory = getControlCategory(req, '/control/enable/')
    if (enabledCategory) {
      const category = resolveConfiguredCategory(enabledCategory, loadPIIConfig())
      if (!category) {
        writeJson(res, 400, { error: `Unknown PII category: ${enabledCategory}` })
        return true
      }

      enableCategory(category)
      writeControlStatus(res)
      return true
    }
  }

  return false
}
