import type { IncomingMessage } from 'node:http'

export function isLoopbackHostHeader(value: string | undefined): boolean {
  if (!value) return false

  try {
    const url = new URL(`http://${value}`)
    const hostname = url.hostname.replace(/^\[(.*)\]$/u, '$1').toLowerCase()
    return (
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1')
    )
  } catch {
    return false
  }
}

export function hasControlRequestHeader(req: IncomingMessage): boolean {
  const value = req.headers['x-cloakroom-control']
  return typeof value === 'string' && value.trim() === '1'
}
