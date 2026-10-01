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

// Read only after the body's end event. Keep repeated fields separate.
export function getMessageTrailers(req: IncomingMessage): [string, string][] {
  const trailers: [string, string][] = []
  const raw = req.rawTrailers ?? []
  for (let i = 0; i < raw.length; i += 2) {
    trailers.push([raw[i], raw[i + 1]])
  }
  return trailers
}

// These attestations can describe the original representation or sign its digest.
// Resource preconditions (If-Match) and digest preferences (Want-*) are unrelated.
const bodyValidationFields = new Set([
  'content-digest', 'repr-digest', 'digest', 'content-md5', 'etag', 'signature', 'signature-input',
])

export function hasBodyValidationMetadata(headers: IncomingMessage['headers'], trailers: readonly [string, string][]): boolean {
  return Object.keys(headers).some((name) => bodyValidationFields.has(name.toLowerCase()))
    || trailers.some(([name]) => bodyValidationFields.has(name.toLowerCase()))
}

export function responseTrailers(upstream: IncomingMessage, bodyChanged: boolean): [string, string][] {
  return getMessageTrailers(upstream).filter(([name]) => !bodyChanged || !bodyValidationFields.has(name.toLowerCase()))
}

export function writeUpstreamResponseHeaders(
  upstream: IncomingMessage,
  res: ServerResponse,
  bodyChanged = false,
  streaming = false,
): void {
  const statusCode = upstream.statusCode ?? 502
  const headers = { ...upstream.headers }
  if (bodyChanged) {
    delete headers['content-length']
    for (const name of bodyValidationFields) delete headers[name]
    // Streaming declarations must also allow unchanged validators at EOF.
    if (!streaming && typeof headers.trailer === 'string') {
      const names = headers.trailer.split(',').map((name) => name.trim())
        .filter((name) => name && !bodyValidationFields.has(name.toLowerCase()))
      if (names.length) headers.trailer = names.join(', ')
      else delete headers.trailer
    }
  }
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
