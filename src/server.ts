import { startServer } from './server/runtime.js'

const DEFAULT_PORT = 8787

function getPort(): number {
  const raw = process.env['PII_PROXY_PORT']
  if (!raw) return DEFAULT_PORT
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : DEFAULT_PORT
}

startServer(getPort())
