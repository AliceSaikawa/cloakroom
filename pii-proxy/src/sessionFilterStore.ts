import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { PIIFilter } from './piiFilter.js'

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000
const SESSION_ID_HEADERS = ['x-pii-session-id', 'anthropic-session-id', 'x-session-id'] as const
const SESSION_RESET_HEADERS = ['x-pii-session-reset'] as const

type SessionEntry = {
  readonly filter: PIIFilter
  expiresAt: number
}

function normalizeHeaderValue(value: string | readonly string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = item.trim()
      if (normalized) return normalized
    }
    return undefined
  }

  if (typeof value !== 'string') return undefined

  const normalized = value.trim()
  return normalized ? normalized : undefined
}

function readHeader(req: IncomingMessage, headerNames: readonly string[]): string | undefined {
  for (const headerName of headerNames) {
    const normalized = normalizeHeaderValue(req.headers[headerName])
    if (normalized) return normalized
  }
  return undefined
}

function shouldResetSession(req: IncomingMessage): boolean {
  const resetValue = readHeader(req, SESSION_RESET_HEADERS)?.toLowerCase()
  return resetValue === '1' || resetValue === 'true'
}

export class SessionFilterStore {
  private readonly explicitSessions = new Map<string, SessionEntry>()
  private readonly socketSessions = new WeakMap<Socket, PIIFilter>()

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

  private acquireExplicitSession(sessionId: string): PIIFilter {
    const existing = this.explicitSessions.get(sessionId)
    if (existing) {
      existing.expiresAt = Date.now() + DEFAULT_SESSION_TTL_MS
      return existing.filter
    }

    const created = {
      filter: new PIIFilter(),
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
    const created = new PIIFilter()
    this.socketSessions.set(socket, created)
    socket.once('close', () => {
      this.socketSessions.delete(socket)
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
