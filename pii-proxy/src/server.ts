import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { PIIFilter } from './piiFilter.js'

const DEFAULT_PORT = 8787
const ANTHROPIC_ORIGIN = 'https://api.anthropic.com'

function getPort(): number {
  const raw = process.env['PII_PROXY_PORT']
  if (!raw) return DEFAULT_PORT
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : DEFAULT_PORT
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function writeUpstreamResponseHeaders(upstream: IncomingMessage, res: ServerResponse): void {
  const statusCode = upstream.statusCode ?? 502
  const headers = { ...upstream.headers }
  delete headers['content-length']
  res.writeHead(statusCode, headers)
}

function shouldFilterMessagesPath(req: IncomingMessage): boolean {
  if (req.method !== 'POST') return false
  if (!req.url) return false
  const path = req.url.split('?')[0]
  return path === '/v1/messages'
}

function normalizeUpstreamHeaders(headers: IncomingMessage['headers'], bodyLength?: number): Record<string, string> {
  const out: Record<string, string> = {}

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      out[key] = value.join(', ')
    } else {
      out[key] = value
    }
  }

  out['host'] = 'api.anthropic.com'
  delete out['accept-encoding']
  if (bodyLength !== undefined) {
    out['content-length'] = String(bodyLength)
  } else {
    delete out['content-length']
  }

  return out
}

async function proxyPassThrough(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req)
  const headers = normalizeUpstreamHeaders(req.headers, body.length)

  await new Promise<void>((resolve, reject) => {
    const upstream = httpsRequest(
      `${ANTHROPIC_ORIGIN}${req.url ?? '/'}`,
      {
        method: req.method,
        headers,
      },
      (upstreamRes) => {
        writeUpstreamResponseHeaders(upstreamRes, res)
        upstreamRes.pipe(res)
        upstreamRes.on('end', resolve)
        upstreamRes.on('error', reject)
      },
    )

    upstream.on('error', reject)
    upstream.write(body)
    upstream.end()
  })
}

async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const filter = new PIIFilter()

  try {
    const rawBody = await readBody(req)

    let parsedBody: Record<string, unknown>
    try {
      parsedBody = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON body' }))
      return
    }

    const filteredBody = await filter.filterRequestBody(parsedBody)
    const outgoingBody = Buffer.from(JSON.stringify(filteredBody), 'utf8')
    const headers = normalizeUpstreamHeaders(req.headers, outgoingBody.length)



    await new Promise<void>((resolve, reject) => {
      const upstream = httpsRequest(
        `${ANTHROPIC_ORIGIN}${req.url ?? '/v1/messages'}`,
        {
          method: 'POST',
          headers,
        },
        (upstreamRes) => {
          const isSSE = (upstreamRes.headers['content-type'] ?? '').includes('text/event-stream')
          writeUpstreamResponseHeaders(upstreamRes, res)

          if (parsedBody['stream'] === true && isSSE) {
            const streamRestorer = filter.createStreamRestorer()

            upstreamRes.on('data', (chunk: Buffer) => {
              const restored = streamRestorer.processChunk(chunk)
              if (restored) res.write(restored)
            })

            upstreamRes.on('end', () => {
              const tail = streamRestorer.flush()
              if (tail) res.write(tail)
              res.end()
              resolve()
            })

            upstreamRes.on('error', reject)
            return
          }

          const responseChunks: Buffer[] = []
          upstreamRes.on('data', (chunk) => {
            responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          })

          upstreamRes.on('end', () => {
            try {
              const raw = Buffer.concat(responseChunks).toString('utf8')
              const contentType = String(upstreamRes.headers['content-type'] ?? '')
              if (!contentType.includes('application/json')) {
                res.end(raw)
                resolve()
                return
              }

              const parsed = JSON.parse(raw)
              const restored = filter.restoreResponseBody(parsed)
              res.end(JSON.stringify(restored))
              resolve()
            } catch {
              res.end(Buffer.concat(responseChunks))
              resolve()
            }
          })

          upstreamRes.on('error', reject)
        },
      )

      upstream.on('error', reject)
      upstream.write(outgoingBody)
      upstream.end()
    })
  } finally {
    filter.reset()
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    if (shouldFilterMessagesPath(req)) {
      await handleMessages(req, res)
      return
    }

    await proxyPassThrough(req, res)
  } catch {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' })
    }
    res.end(JSON.stringify({ error: 'Upstream proxy error' }))
  }
})

server.listen(getPort(), '127.0.0.1')

server.on('listening', () => {
  const address = server.address()
  if (address && typeof address === 'object') {
    process.stdout.write(`PII proxy listening on http://127.0.0.1:${address.port}\n`)
  }
})

process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})

process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})
