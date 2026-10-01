import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadPIIConfig } from '../core/config.js'
import { readRequestBody } from './requestBody.js'

export function normalizeHeaderValue(
  value: string | readonly string[] | undefined,
): string | undefined {
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

export function readHeader(
  req: IncomingMessage,
  headerNames: readonly string[],
): string | undefined {
  for (const headerName of headerNames) {
    const normalized = normalizeHeaderValue(req.headers[headerName])
    if (normalized) return normalized
  }
  return undefined
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return readRequestBody(req, loadPIIConfig().maxRequestBodyBytes)
}

export function writeUpstreamResponseHeaders(upstream: IncomingMessage, res: ServerResponse): void {
  const statusCode = upstream.statusCode ?? 502
  const headers = { ...upstream.headers }
  delete headers['content-length']
  res.writeHead(statusCode, headers)
}

export function writeProxyError(res: ServerResponse): void {
  if (!res.headersSent) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Upstream proxy error' }))
    return
  }

  // Once an SSE response has started, appending JSON would corrupt the stream.
  if (!res.writableEnded && !res.destroyed) {
    res.destroy()
  }
}

export function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

export function normalizeUpstreamHeaders(
  headers: IncomingMessage['headers'],
  host: string,
  bodyLength?: number,
): Record<string, string> {
  const out: Record<string, string> = {}

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      out[key] = value.join(', ')
    } else {
      out[key] = value
    }
  }

  out['host'] = host
  delete out['accept-encoding']
  // The incoming body has been decoded and buffered. Let the new request use
  // its own framing instead of combining the client's chunking with our length.
  delete out['transfer-encoding']
  if (bodyLength !== undefined) {
    out['content-length'] = String(bodyLength)
  } else {
    delete out['content-length']
  }

  return out
}
