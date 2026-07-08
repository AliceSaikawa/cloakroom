import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AuditLogConfig, PIICategory, PIIMode } from './types.js'

const DEFAULT_AUDIT_LOG_PATH = join(homedir(), '.claude', 'pii-audit.jsonl')

export type AuditLogEvent = {
  readonly timestamp: string
  readonly category: PIICategory
  readonly placeholder: string
  readonly confidence: number
  readonly position: {
    readonly start: number
    readonly end: number
  }
  readonly mode: PIIMode
  readonly reviewRequired: boolean
}

export function writeAuditLog(config: AuditLogConfig, event: AuditLogEvent): void {
  if (!config.enabled) return

  // Deliberately write metadata only. Raw PII must never be copied into logs.
  const line = `${JSON.stringify(event)}\n`
  if (config.destination === 'file') {
    const path = config.path ?? DEFAULT_AUDIT_LOG_PATH
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, line, 'utf8')
    return
  }

  process.stderr.write(line)
}
