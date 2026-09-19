import type { Server } from 'node:http'
import { togglePassthrough } from '../core/controlState.js'
import { createProxyServer } from './app.js'
import { reloadRuntimeConfig } from './control.js'
import { SessionFilterStore } from './sessionFilterStore.js'

export function startServer(port: number): Server {
  const sessionFilters = new SessionFilterStore()
  const server = createProxyServer({ sessionFilters })
  server.listen(port, '127.0.0.1')

  server.on('listening', () => {
    const address = server.address()
    if (address && typeof address === 'object') {
      process.stdout.write(`PII proxy listening on http://127.0.0.1:${address.port}\n`)
    }
  })

  process.on('SIGUSR1', () => {
    const status = togglePassthrough()
    const mode = status.passthroughEnabled ? 'passthrough' : 'filtering'
    process.stdout.write(`PII proxy control mode: ${mode}\n`)
  })

  process.on('SIGHUP', () => {
    reloadRuntimeConfig(sessionFilters)
    process.stdout.write('PII proxy config reloaded\n')
  })

  process.on('SIGINT', () => {
    server.close(() => process.exit(0))
  })

  process.on('SIGTERM', () => {
    server.close(() => process.exit(0))
  })
  return server
}
