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
    filteredPaths: ['/v1/messages'],
  },
  openai: {
    kind: 'openai',
    origin: 'https://api.openai.com',
    host: 'api.openai.com',
    filteredPaths: ['/v1/chat/completions'],
  },
}

const PATH_TO_PROVIDER: Record<string, ProviderKind> = {
  '/v1/messages': 'anthropic',
  '/v1/chat/completions': 'openai',
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

export function getRequestPath(req: IncomingMessage): string {
  return req.url?.split('?')[0] ?? '/'
}

export function resolveProvider(req: IncomingMessage): ProviderConfig {
  const path = getRequestPath(req)
  const providerFromPath = PATH_TO_PROVIDER[path]
  if (providerFromPath) return PROVIDERS[providerFromPath]

  // Known API paths are the source of truth. For generic pass-through routes,
  // callers can still steer the upstream explicitly with x-provider.
  const providerHeader = normalizeHeaderValue(req.headers['x-provider'])?.toLowerCase()
  if (providerHeader === 'openai') return PROVIDERS.openai
  if (providerHeader === 'anthropic') return PROVIDERS.anthropic

  return PROVIDERS.anthropic
}

export function shouldFilterMessagesPath(req: IncomingMessage): boolean {
  if (req.method !== 'POST') return false
  const provider = resolveProvider(req)
  return provider.filteredPaths.includes(getRequestPath(req))
}
