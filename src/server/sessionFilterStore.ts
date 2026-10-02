import { loadPIIConfig } from '../core/config.js'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { readHeader } from './httpUtils.js'
import { MappingTable } from '../core/mappingTable.js'
import { PIIFilter } from '../core/piiFilter.js'
import { resolveProvider, type ProviderKind } from './provider.js'
import type { PIIFilterConfig } from '../core/types.js'
import { cleanExpiredVaults, deleteSessionVault, loadSessionVault, saveSessionVault } from '../core/vault.js'

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000
const SESSION_ID_HEADERS = ['x-pii-session-id', 'anthropic-session-id', 'x-session-id'] as const
const SESSION_RESET_HEADERS = ['x-pii-session-reset'] as const

type FilterEntry = {
  readonly provider: ProviderKind
  readonly filter: PIIFilter
}
type SessionEntry = FilterEntry & {
  readonly sessionId: string
  expiresAt: number
}

function shouldResetSession(req: IncomingMessage): boolean {
  const resetValue = readHeader(req, SESSION_RESET_HEADERS)?.toLowerCase()
  return resetValue === '1' || resetValue === 'true'
}

export class SessionFilterStore {
  private readonly explicitSessions = new Map<string, SessionEntry>()
  private socketSessions = new WeakMap<Socket, Map<ProviderKind, FilterEntry>>()
  private socketFilters = new Set<FilterEntry>()
  private vaultRegistrations = new WeakMap<Socket, Map<string, SessionEntry>>()

  // Load the same initial configuration used by filters, before any reload.
  constructor(private config: PIIFilterConfig = loadPIIConfig()) {}

  private effectiveConfig(provider: ProviderKind): PIIFilterConfig {
    return { ...this.config, ...this.config.providerOverrides?.[provider] }
  }

  acquire(req: IncomingMessage): PIIFilter {
    this.pruneExpiredSessions()
    const provider = resolveProvider(req).kind
    const explicitSessionId = readHeader(req, SESSION_ID_HEADERS)
    if (explicitSessionId) {
      // Tuple encoding avoids ambiguous IDs and does not depend on override presence.
      const key = JSON.stringify([provider, explicitSessionId])
      if (shouldResetSession(req)) {
        this.explicitSessions.delete(key)
        // Reset also invalidates persisted mappings while vault use is disabled.
        deleteSessionVault(explicitSessionId, provider)
      }
      const entry = this.acquireExplicitSession(key, explicitSessionId, provider)
      if (this.config.vaultEnabled) this.registerVaultSaveOnClose(req.socket, key, entry)
      return entry.filter
    }

    if (shouldResetSession(req)) {
      const entries = this.socketSessions.get(req.socket)
      const previous = entries?.get(provider)
      if (previous) {
        entries!.delete(provider)
        this.socketFilters.delete(previous)
      }
    }
    return this.acquireSocketSession(req.socket, provider)
  }

  clear(): void {
    this.explicitSessions.clear()
    this.socketSessions = new WeakMap()
    this.socketFilters.clear()
    this.vaultRegistrations = new WeakMap()
  }

  reload(config: PIIFilterConfig): void {
    this.config = config
    this.pruneExpiredSessions()
    for (const entry of this.explicitSessions.values()) {
      entry.filter.updateConfig(this.effectiveConfig(entry.provider))
    }
    for (const entry of this.socketFilters) {
      entry.filter.updateConfig(this.effectiveConfig(entry.provider))
    }
  }

  private acquireExplicitSession(key: string, sessionId: string, provider: ProviderKind): SessionEntry {
    const existing = this.explicitSessions.get(key)
    if (existing) {
      existing.expiresAt = Date.now() + DEFAULT_SESSION_TTL_MS
      return existing
    }

    let mappingTable: MappingTable | undefined
    if (this.config.vaultEnabled) {
      // Legacy vaults have no provider identity, so they are not imported here.
      const vaultData = loadSessionVault(sessionId, provider)
      if (vaultData) mappingTable = MappingTable.fromJSON(vaultData)
    }
    const created: SessionEntry = {
      provider,
      sessionId,
      filter: new PIIFilter(this.effectiveConfig(provider), mappingTable),
      expiresAt: Date.now() + DEFAULT_SESSION_TTL_MS,
    }
    this.explicitSessions.set(key, created)
    return created
  }

  private registerVaultSaveOnClose(socket: Socket, key: string, entry: SessionEntry): void {
    let registrations = this.vaultRegistrations.get(socket)
    if (!registrations) {
      registrations = new Map()
      this.vaultRegistrations.set(socket, registrations)
      const captured = registrations
      socket.once('close', () => {
        for (const [sessionKey, current] of captured) {
          // Reset/expiry/clear may have replaced this entry while the socket lived.
          if (this.config.vaultEnabled && this.explicitSessions.get(sessionKey) === current) {
            saveSessionVault(current.sessionId, current.filter.getMappingTable().toJSON(), current.provider)
          }
        }
        this.vaultRegistrations.delete(socket)
      })
    }
    // One close listener per socket; same-socket reset updates its saved generation.
    registrations.set(key, entry)
  }

  private acquireSocketSession(socket: Socket, provider: ProviderKind): PIIFilter {
    let entries = this.socketSessions.get(socket)
    if (!entries) {
      entries = new Map()
      this.socketSessions.set(socket, entries)
      const captured = entries
      socket.once('close', () => {
        if (this.socketSessions.get(socket) === captured) this.socketSessions.delete(socket)
        for (const entry of captured.values()) this.socketFilters.delete(entry)
      })
    }
    const existing = entries.get(provider)
    if (existing) return existing.filter

    const created: FilterEntry = {
      provider,
      filter: new PIIFilter(this.effectiveConfig(provider)),
    }
    entries.set(provider, created)
    this.socketFilters.add(created)
    return created.filter
  }

  activeSessionCount(): number {
    return this.explicitSessions.size + this.socketFilters.size
  }

  private pruneExpiredSessions(): void {
    const now = Date.now()
    if (this.config.vaultEnabled) {
      cleanExpiredVaults((this.config.vaultTtlMinutes ?? 30) * 60 * 1000)
    }
    for (const [key, entry] of this.explicitSessions) {
      if (entry.expiresAt <= now) {
        if (this.config.vaultEnabled) {
          saveSessionVault(entry.sessionId, entry.filter.getMappingTable().toJSON(), entry.provider)
        }
        this.explicitSessions.delete(key)
      }
    }
  }
}
