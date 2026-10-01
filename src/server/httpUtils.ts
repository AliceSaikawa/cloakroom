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

// Read only after the request body's end event. Keep repeated fields separate.
export function getRequestTrailers(req: IncomingMessage): [string, string][] {
  const trailers: [string, string][] = []
  for (let i = 0; i < req.rawTrailers.length; i += 2) {
    trailers.push([req.rawTrailers[i], req.rawTrailers[i + 1]])
  }
  return trailers
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
  trailers: readonly [string, string][] = [],
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
  const trailerNames = new Set(
    (out['trailer'] ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean),
  )
  for (const [name] of trailers) trailerNames.add(name.toLowerCase())

  if (trailerNames.size > 0) {
    // HTTP/1.1 trailers need chunked framing, including empty and GET bodies.
    out['trailer'] = [...trailerNames].join(', ')
    out['transfer-encoding'] = 'chunked'
    delete out['content-length']
  } else {
    // An empty declaration promises no fields; it must not conflict with length framing.
    delete out['trailer']
    if (bodyLength !== undefined) out['content-length'] = String(bodyLength)
    else delete out['content-length']
  }

  return out
}
