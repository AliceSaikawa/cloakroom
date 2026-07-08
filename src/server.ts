import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import {
  disableCategory,
  enableCategory,
  getActiveCategories,
  getControlStatus,
  isKnownPIICategory,
  resetControlState,
  setPassthroughEnabled,
  togglePassthrough,
} from './controlState.js'
import { loadPIIConfig, reloadPIIConfig } from './config.js'
import { PIIFilter } from './piiFilter.js'
import { resolveProvider, shouldFilterMessagesPath } from './provider.js'
import { SessionFilterStore } from './sessionFilterStore.js'
import type { PIICategory, PIIFilterConfig } from './types.js'

const DEFAULT_PORT = 8787
const sessionFilters = new SessionFilterStore()

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

function writeProxyError(res: ServerResponse): void {
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

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function getConfiguredCategories(config: PIIFilterConfig): readonly PIICategory[] {
  const customCategories = config.customCategories
    .filter((category) => category.enabled !== false)
    .map((category) => category.name)
  const customPatternCategories = config.customPatterns.map((pattern) => pattern.category ?? pattern.name)
  return [...new Set([...config.categories, ...customCategories, ...customPatternCategories])]
}

function isConfiguredCategory(category: string, config: PIIFilterConfig): category is PIICategory {
  return (
    isKnownPIICategory(category) ||
    config.customCategories.some((item) => item.name === category) ||
    config.customPatterns.some((item) => (item.category ?? item.name) === category)
  )
}

function reloadRuntimeConfig(): void {
  reloadPIIConfig()
  // Existing session filters keep their own config snapshots, so reload starts
  // fresh sessions for requests after the config change.
  sessionFilters.clear()
}

function writeControlStatus(res: ServerResponse): void {
  const status = getControlStatus()
  const config = loadPIIConfig()
  writeJson(res, 200, {
    ...status,
    filterEnabled: config.enabled && !status.passthroughEnabled,
    activeCategories: getActiveCategories(getConfiguredCategories(config)),
  })
}

function getControlCategory(req: IncomingMessage, prefix: string): string | undefined {
  const path = req.url?.split('?')[0] ?? '/'
  if (!path.startsWith(prefix)) return undefined
  const rawCategory = path.slice(prefix.length)
  if (!rawCategory) return undefined
  return decodeURIComponent(rawCategory).trim().toUpperCase()
}

function handleControlRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const path = req.url?.split('?')[0] ?? '/'

  if (req.method === 'GET' && path === '/control/status') {
    writeControlStatus(res)
    return true
  }

  if (req.method === 'POST' && path === '/control/passthrough') {
    setPassthroughEnabled(true)
    writeControlStatus(res)
    return true
  }

  if (req.method === 'POST' && path === '/control/filter') {
    // フィルタ再開 = passthrough解除 + 個別disable も全リセット
    resetControlState()
    writeControlStatus(res)
    return true
  }

  if (req.method === 'POST' && path === '/control/reload') {
    reloadRuntimeConfig()
    writeControlStatus(res)
    return true
  }

  if (req.method === 'POST') {
    const disabledCategory = getControlCategory(req, '/control/disable/')
    if (disabledCategory) {
      if (!isConfiguredCategory(disabledCategory, loadPIIConfig())) {
        writeJson(res, 400, { error: `Unknown PII category: ${disabledCategory}` })
        return true
      }

      disableCategory(disabledCategory)
      writeControlStatus(res)
      return true
    }

    const enabledCategory = getControlCategory(req, '/control/enable/')
    if (enabledCategory) {
      if (!isConfiguredCategory(enabledCategory, loadPIIConfig())) {
        writeJson(res, 400, { error: `Unknown PII category: ${enabledCategory}` })
        return true
      }

      enableCategory(enabledCategory)
      writeControlStatus(res)
      return true
    }
  }

  return false
}

async function handleAnalyze(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawBody = await readBody(req)

  let parsedBody: Record<string, unknown>
  try {
    parsedBody = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>
  } catch {
    writeJson(res, 400, { error: 'Invalid JSON body' })
    return
  }

  if (typeof parsedBody['text'] !== 'string') {
    writeJson(res, 400, { error: 'Expected JSON body with a string "text" field' })
    return
  }

  const filter = new PIIFilter()
  const detections = await filter.analyzeText(parsedBody['text'], {
    useOllama: parsedBody['useOllama'] === true,
  })

  writeJson(res, 200, { detections })
}

type StreamRestorerLike = {
  processChunk(chunk: Buffer | string): string
  flush(): string
}

function normalizeUpstreamHeaders(
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
  if (bodyLength !== undefined) {
    out['content-length'] = String(bodyLength)
  } else {
    delete out['content-length']
  }

  return out
}

async function proxyPassThrough(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req)
  const provider = resolveProvider(req)
  const headers = normalizeUpstreamHeaders(req.headers, provider.host, body.length)

  await new Promise<void>((resolve, reject) => {
    const upstream = httpsRequest(
      `${provider.origin}${req.url ?? '/'}`,
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
  const rawBody = await readBody(req)

  let parsedBody: Record<string, unknown>
  try {
    parsedBody = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    return
  }

  const provider = resolveProvider(req)

  // Reuse the same filter within one logical session so placeholders can be restored
  // across multiple turns. If the caller does not provide a session ID, we fall back
  // to the active keep-alive socket.
  const filter = sessionFilters.acquire(req)
  const filteredBody = await filter.filterRequestBody(parsedBody)
  const outgoingBody = Buffer.from(JSON.stringify(filteredBody), 'utf8')
  const headers = normalizeUpstreamHeaders(req.headers, provider.host, outgoingBody.length)

  await new Promise<void>((resolve, reject) => {
    const upstream = httpsRequest(
      `${provider.origin}${req.url ?? '/v1/messages'}`,
      {
        method: 'POST',
        headers,
      },
      (upstreamRes) => {
        const isSSE = (upstreamRes.headers['content-type'] ?? '').includes('text/event-stream')
        writeUpstreamResponseHeaders(upstreamRes, res)

        if (parsedBody['stream'] === true && isSSE) {
          const streamRestorer: StreamRestorerLike =
            provider.kind === 'openai'
              ? filter.createOpenAIStreamRestorer()
              : filter.createStreamRestorer()

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
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    if (handleControlRequest(req, res)) {
      return
    }

    if (req.method === 'POST' && req.url?.split('?')[0] === '/analyze') {
      await handleAnalyze(req, res)
      return
    }

    if (shouldFilterMessagesPath(req)) {
      await handleMessages(req, res)
      return
    }

    await proxyPassThrough(req, res)
  } catch {
    writeProxyError(res)
  }
})

server.listen(getPort(), '127.0.0.1')

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
  reloadRuntimeConfig()
  process.stdout.write('PII proxy config reloaded\n')
})

process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})

process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})
