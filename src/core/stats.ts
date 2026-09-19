// カウンタはプロセス生存中のみ保持。PII値は一切格納しない。

export type StatsSnapshot = {
  maskedRequests: number
  restoredPlaceholders: number
  unresolvedPlaceholders: number
  passthroughRequests: number
  activeSessions: number
  detectionsByCategory: Record<string, number>
  passthroughByPath: Record<string, number>
}

let maskedRequests = 0
let restoredPlaceholders = 0
let unresolvedPlaceholders = 0
let passthroughRequests = 0
const detectionsByCategory: Record<string, number> = {}
const passthroughByPath: Record<string, number> = {}

export function incMaskedRequests(): void {
  maskedRequests++
}

export function incRestoredPlaceholders(n: number): void {
  restoredPlaceholders += n
}

export function incUnresolvedPlaceholders(n: number): void {
  unresolvedPlaceholders += n
}

export function incPassthroughRequests(path: string): void {
  passthroughRequests++
  passthroughByPath[path] = (passthroughByPath[path] ?? 0) + 1
}

export function incDetectionsByCategory(category: string): void {
  detectionsByCategory[category] = (detectionsByCategory[category] ?? 0) + 1
}

export function getSnapshot(activeSessions: number): StatsSnapshot {
  return {
    maskedRequests,
    restoredPlaceholders,
    unresolvedPlaceholders,
    passthroughRequests,
    activeSessions,
    detectionsByCategory: { ...detectionsByCategory },
    passthroughByPath: { ...passthroughByPath },
  }
}

export function resetStats(): void {
  maskedRequests = 0
  restoredPlaceholders = 0
  unresolvedPlaceholders = 0
  passthroughRequests = 0
  for (const key of Object.keys(detectionsByCategory)) {
    delete detectionsByCategory[key]
  }
  for (const key of Object.keys(passthroughByPath)) {
    delete passthroughByPath[key]
  }
}
