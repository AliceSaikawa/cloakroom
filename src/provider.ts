import type { IncomingMessage } from 'node:http'
import { normalizeHeaderValue } from './httpUtils.js'

export type ProviderKind = 'anthropic' | 'openai'

export type ProviderConfig = {
  readonly kind: ProviderKind
  readonly origin: string
  readonly host: string
  readonly basePath: string
  readonly filteredPaths: readonly string[]
}

const PROVIDERS: Record<ProviderKind, ProviderConfig> = {
  anthropic: {
    kind: 'anthropic',
    origin: 'https://api.anthropic.com',
    host: 'api.anthropic.com',
    basePath: '',
    filteredPaths: ['/v1/messages', '/v1/messages/count_tokens'],
  },
  openai: {
    kind: 'openai',
    origin: 'https://api.openai.com',
    host: 'api.openai.com',
    basePath: '',
    filteredPaths: ['/v1/chat/completions', '/v1/responses'],
  },
}

const PATH_TO_PROVIDER: Record<string, ProviderKind> = {
  '/v1/messages': 'anthropic',
  '/v1/messages/count_tokens': 'anthropic',
  '/v1/chat/completions': 'openai',
  '/v1/responses': 'openai',
  '/v1/embeddings': 'openai',
  '/v1/files': 'openai',
}

export function getRequestPath(req: IncomingMessage): string {
  return req.url?.split('?')[0] ?? '/'
}

export function resolveProvider(
  req: IncomingMessage,
  upstreams: Partial<Record<ProviderKind, string>> = {},
): ProviderConfig {
  const path = getRequestPath(req)
  let providerFromPath = PATH_TO_PROVIDER[path]
  if (!providerFromPath && /^\/v1\/(?:embeddings|files)(?:\/|$)/u.test(path)) {
    providerFromPath = 'openai'
  } else if (!providerFromPath && /^\/v1\/messages\/batches(?:\/|$)/u.test(path)) {
    providerFromPath = 'anthropic'
  }

  // Known API paths are the source of truth. For generic pass-through routes,
  // callers can still steer the upstream explicitly with x-provider.
  const providerHeader = normalizeHeaderValue(req.headers['x-provider'])?.toLowerCase()
  let kind: ProviderKind = 'anthropic'
  if (providerFromPath) {
    kind = providerFromPath
  } else if (providerHeader === 'openai' || providerHeader === 'anthropic') {
    kind = providerHeader
  }
  const configuredUrl = upstreams[kind]
  if (!configuredUrl) return PROVIDERS[kind]

  try {
    const url = new URL(configuredUrl)
    return {
      ...PROVIDERS[kind],
      origin: url.origin,
      host: url.host,
      basePath: url.pathname.replace(/\/$/u, ''),
    }
  } catch {
    return PROVIDERS[kind]
  }
}

export function getUpstreamTarget(req: IncomingMessage, provider: ProviderConfig): string {
  const requestPath = getRequestPath(req)
  let path = requestPath

  // Custom OpenAI-compatible gateways commonly include `/v1` in their base URL.
  if (provider.basePath.endsWith('/v1') && requestPath.startsWith('/v1/')) {
    path = `${provider.basePath}${requestPath.slice(3)}`
  } else {
    path = `${provider.basePath}${requestPath}`
  }

  const query = req.url?.slice(requestPath.length) ?? ''
  return `${provider.origin}${path || '/'}${query}`
}

export function shouldFilterMessagesPath(
  req: IncomingMessage,
  upstreams: Partial<Record<ProviderKind, string>> = {},
): boolean {
  if (req.method !== 'POST') return false
  const provider = resolveProvider(req, upstreams)
  return provider.filteredPaths.includes(getRequestPath(req))
}

export function isUnfilteredBodyEndpoint(req: IncomingMessage): boolean {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method ?? '')) return false

  const path = getRequestPath(req)
  return /^\/v1\/(?:embeddings|files|messages\/batches)(?:\/|$)/u.test(path)
}
