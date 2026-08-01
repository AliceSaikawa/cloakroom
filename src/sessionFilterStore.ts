import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { readHeader } from './httpUtils.js'
import { PIIFilter } from './piiFilter.js'
import type { PIIFilterConfig } from './types.js'

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000
const SESSION_ID_HEADERS = ['x-pii-session-id', 'anthropic-session-id', 'x-session-id'] as const
const SESSION_RESET_HEADERS = ['x-pii-session-reset'] as const

type SessionEntry = {
  readonly filter: PIIFilter
  expiresAt: number
}


function shouldResetSession(req: IncomingMessage): boolean {
  const resetValue = readHeader(req, SESSION_RESET_HEADERS)?.toLowerCase()
  return resetValue === '1' || resetValue === 'true'
}

export class SessionFilterStore {
  private readonly explicitSessions = new Map<string, SessionEntry>()
  private socketSessions = new WeakMap<Socket, PIIFilter>()
  private socketFilters = new Set<PIIFilter>()

  constructor(private config?: PIIFilterConfig) {}

  acquire(req: IncomingMessage): PIIFilter {
    this.pruneExpiredSessions()

    const explicitSessionId = readHeader(req, SESSION_ID_HEADERS)
    if (explicitSessionId) {
      if (shouldResetSession(req)) {
        this.explicitSessions.delete(explicitSessionId)
      }
      return this.acquireExplicitSession(explicitSessionId)
    }

    if (shouldResetSession(req)) {
      this.socketSessions.delete(req.socket)
    }
    return this.acquireSocketSession(req.socket)
  }

  clear(): void {
    this.explicitSessions.clear()
    this.socketSessions = new WeakMap<Socket, PIIFilter>()
    this.socketFilters.clear()
  }

  reload(config: PIIFilterConfig): void {
    this.config = config
    this.pruneExpiredSessions()
    for (const entry of this.explicitSessions.values()) {
      entry.filter.updateConfig(config)
    }
    for (const filter of this.socketFilters) {
      filter.updateConfig(config)
    }
  }

  private acquireExplicitSession(sessionId: string): PIIFilter {
    const existing = this.explicitSessions.get(sessionId)
    if (existing) {
      existing.expiresAt = Date.now() + DEFAULT_SESSION_TTL_MS
      return existing.filter
    }

    const created = {
      filter: new PIIFilter(this.config),
      expiresAt: Date.now() + DEFAULT_SESSION_TTL_MS,
    }
    this.explicitSessions.set(sessionId, created)
    return created.filter
  }

  private acquireSocketSession(socket: Socket): PIIFilter {
    const existing = this.socketSessions.get(socket)
    if (existing) return existing

    // When the caller does not provide an explicit session ID, fall back to
    // the keep-alive connection so multi-turn restores still work safely.
    const created = new PIIFilter(this.config)
    this.socketSessions.set(socket, created)
    this.socketFilters.add(created)
    socket.once('close', () => {
      this.socketSessions.delete(socket)
      this.socketFilters.delete(created)
    })
    return created
  }

  private pruneExpiredSessions(): void {
    const now = Date.now()
    for (const [sessionId, entry] of this.explicitSessions.entries()) {
      if (entry.expiresAt <= now) {
        this.explicitSessions.delete(sessionId)
      }
    }
  }
}
