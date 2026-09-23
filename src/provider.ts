import type { IncomingMessage } from 'node:http'

export type ProviderKind = 'anthropic' | 'openai'

export type ProviderConfig = {
  readonly kind: ProviderKind
  readonly origin: string
  readonly host: string
  readonly filteredPaths: readonly string[]
}

const PROVIDERS: Record<ProviderKind, ProviderConfig> = {
  anthropic: {
    kind: 'anthropic',
    origin: 'https://api.anthropic.com',
    host: 'api.anthropic.com',
    filteredPaths: ['/v1/messages', '/v1/messages/count_tokens'],
  },
  openai: {
    kind: 'openai',
    origin: 'https://api.openai.com',
    host: 'api.openai.com',
    filteredPaths: ['/v1/chat/completions', '/v1/responses'],
  },
}

const PROVIDER_PREFIXES: Readonly<Record<string, ProviderKind>> = {
  '/anthropic': 'anthropic',
  '/openai': 'openai',
}

const PATH_TO_PROVIDER: Record<string, ProviderKind> = {
  '/v1/messages': 'anthropic',
  '/v1/messages/count_tokens': 'anthropic',
  '/v1/chat/completions': 'openai',
  '/v1/responses': 'openai',
}

export function getRequestPath(req: IncomingMessage): string {
  return req.url?.split('?')[0] ?? '/'
}

function removeProviderPrefix(path: string): string {
  for (const prefix of Object.keys(PROVIDER_PREFIXES)) {
    if (path === prefix) return '/'
    if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length)
  }
  return path
}

export function getUpstreamPath(req: IncomingMessage): string {
  const rawUrl = req.url ?? '/'
  const queryIndex = rawUrl.indexOf('?')
  const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex)
  const query = queryIndex === -1 ? '' : rawUrl.slice(queryIndex)
  return `${removeProviderPrefix(path)}${query}`
}

export function resolveProvider(req: IncomingMessage): ProviderConfig {
  const rawPath = getRequestPath(req)
  const prefix = Object.keys(PROVIDER_PREFIXES).find(
    (item) => rawPath === item || rawPath.startsWith(`${item}/`),
  )
  if (prefix) return PROVIDERS[PROVIDER_PREFIXES[prefix] ?? 'anthropic']

  const path = removeProviderPrefix(rawPath)
  const providerFromPath = PATH_TO_PROVIDER[path]
  if (providerFromPath) return PROVIDERS[providerFromPath]

  // Legacy unprefixed routes keep their historical Anthropic default.
  // x-provider is intentionally ignored; callers should use a path prefix.
  return PROVIDERS.anthropic
}

export function shouldFilterMessagesPath(req: IncomingMessage): boolean {
  if (req.method !== 'POST') return false
  const provider = resolveProvider(req)
  return provider.filteredPaths.includes(removeProviderPrefix(getRequestPath(req)))
}
