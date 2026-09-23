import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { readHeader } from './httpUtils.js'
import { MappingTable } from './mappingTable.js'
import { PIIFilter } from './piiFilter.js'
import { resolveProvider } from './provider.js'
import type { PIIFilterConfig } from './types.js'
import { cleanExpiredVaults, deleteSessionVault, loadSessionVault, saveSessionVault } from './vault.js'

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
  // Track which (socket, sessionId) pairs already have a vault-save listener
  private readonly registeredSaveListeners = new WeakMap<Socket, Set<string>>()

  constructor(private config?: PIIFilterConfig) {}

  acquire(req: IncomingMessage): PIIFilter {
    this.pruneExpiredSessions()

    // Rebuild mappings from the full conversation in each request by default.
    // This avoids binding restoration to a TCP connection or client session ID.
    if (!this.config?.statefulSessionMappings) {
      const providerOverride = this.config?.providerOverrides?.[resolveProvider(req, this.config?.upstreams).kind]
      const mergedConfig = this.config && providerOverride
        ? { ...this.config, ...providerOverride }
        : this.config
      return new PIIFilter(mergedConfig)
    }

    // Apply provider-specific overrides when configured
    const providerOverride = this.config?.providerOverrides?.[
      resolveProvider(req, this.config?.upstreams).kind
    ]
    if (providerOverride && this.config) {
      const mergedConfig: PIIFilterConfig = { ...this.config, ...providerOverride }
      return new PIIFilter(mergedConfig)
    }

    const explicitSessionId = readHeader(req, SESSION_ID_HEADERS)
    if (explicitSessionId) {
      if (shouldResetSession(req)) {
        this.explicitSessions.delete(explicitSessionId)
        if (this.config?.vaultEnabled) {
          deleteSessionVault(explicitSessionId)
        }
      }
      const filter = this.acquireExplicitSession(explicitSessionId)
      if (this.config?.vaultEnabled) {
        this.registerVaultSaveOnClose(req.socket, explicitSessionId, filter)
      }
      return filter
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

    let mappingTable: MappingTable | undefined
    if (this.config?.vaultEnabled) {
      const vaultData = loadSessionVault(sessionId)
      if (vaultData) {
        mappingTable = MappingTable.fromJSON(vaultData)
      }
    }

    const created = {
      filter: new PIIFilter(this.config, mappingTable),
      expiresAt: Date.now() + DEFAULT_SESSION_TTL_MS,
    }
    this.explicitSessions.set(sessionId, created)
    return created.filter
  }

  private registerVaultSaveOnClose(socket: Socket, sessionId: string, filter: PIIFilter): void {
    let sessions = this.registeredSaveListeners.get(socket)
    if (!sessions) {
      sessions = new Set()
      this.registeredSaveListeners.set(socket, sessions)
    }
    if (sessions.has(sessionId)) return
    sessions.add(sessionId)
    socket.once('close', () => {
      saveSessionVault(sessionId, filter.getMappingTable().toJSON())
    })
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

  activeSessionCount(): number {
    return this.explicitSessions.size + this.socketFilters.size
  }

  private pruneExpiredSessions(): void {
    const now = Date.now()
    if (this.config?.vaultEnabled) {
      const ttlMs = (this.config.vaultTtlMinutes ?? 30) * 60 * 1000
      cleanExpiredVaults(ttlMs)
    }
    for (const [sessionId, entry] of this.explicitSessions.entries()) {
      if (entry.expiresAt <= now) {
        if (this.config?.vaultEnabled) {
          saveSessionVault(sessionId, entry.filter.getMappingTable().toJSON())
        }
        this.explicitSessions.delete(sessionId)
      }
    }
  }
}
