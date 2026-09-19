import { completionsApi } from './completions/index.js'
import { messagesApi } from './messages/index.js'
import type { ApiAdapter } from './types.js'

const adapters: readonly ApiAdapter[] = [messagesApi, completionsApi]

export function resolveApiAdapter(path: string): ApiAdapter | undefined {
  return adapters.find((adapter) => adapter.paths.includes(path))
}
