import type { IncomingMessage, ServerResponse } from 'node:http'
import type { request as httpsRequest } from 'node:https'
import type { ApiAdapter } from '../api/types.js'
import { restoreNonStreamingResponse } from '../api/shared/responseRestorer.js'
import { BlockedByPolicyError } from '../core/piiFilter.js'
import { incMaskedRequests, incPassthroughRequests } from '../core/stats.js'
import { normalizeUpstreamHeaders, readBody, writeJson, writeUpstreamResponseHeaders } from './httpUtils.js'
import { resolveProvider } from './provider.js'
import type { SessionFilterStore } from './sessionFilterStore.js'
import { withUpstreamLifecycle } from './upstreamLifecycle.js'

export async function proxyPassThrough(
  req: IncomingMessage,
  res: ServerResponse,
  requestUpstream: typeof httpsRequest,
): Promise<void> {
  const body = await readBody(req)
  const provider = resolveProvider(req)
  incPassthroughRequests(req.url?.split('?')[0] ?? '/')
  const headers = normalizeUpstreamHeaders(req.headers, provider.host, body.length)

  await withUpstreamLifecycle(res, (lifecycle) => {
    const { resolve } = lifecycle
    const upstream = requestUpstream(
      `${provider.origin}${req.url ?? '/'}`,
      {
        method: req.method,
        headers,
      },
      (upstreamRes) => {
        if (!lifecycle.trackResponse(upstreamRes)) return
        writeUpstreamResponseHeaders(upstreamRes, res)
        upstreamRes.pipe(res)
        upstreamRes.on('end', resolve)
      },
    )

    if (!lifecycle.trackRequest(upstream)) return
    upstream.write(body)
    upstream.end()
  })
}

export async function proxyFilteredRequest(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: ApiAdapter,
  sessionFilters: SessionFilterStore,
  requestUpstream: typeof httpsRequest,
): Promise<void> {
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

  let filteredBody: Record<string, unknown>
  try {
    filteredBody = await adapter.filterRequest(parsedBody, filter)
  } catch (err) {
    if (err instanceof BlockedByPolicyError) {
      writeJson(res, 446, {
        error: {
          type: 'request_blocked',
          message: 'Request contains sensitive data',
          categories: [...err.categories],
        },
      })
      return
    }
    throw err
  }

  if (filter.isEnabled()) incMaskedRequests()
  const outgoingBody = Buffer.from(JSON.stringify(filteredBody), 'utf8')
  const headers = normalizeUpstreamHeaders(req.headers, provider.host, outgoingBody.length)

  await withUpstreamLifecycle(res, (lifecycle) => {
    const { resolve } = lifecycle
    const upstream = requestUpstream(
      `${provider.origin}${req.url ?? '/v1/messages'}`,
      {
        method: 'POST',
        headers,
      },
      (upstreamRes) => {
        if (!lifecycle.trackResponse(upstreamRes)) return
        const isSSE = (upstreamRes.headers['content-type'] ?? '').includes('text/event-stream')
        writeUpstreamResponseHeaders(upstreamRes, res)

        if (parsedBody['stream'] === true && isSSE) {
          const streamRestorer = adapter.createStreamRestorer(filter)

          upstreamRes.on('data', (chunk: Buffer) => {
            if (!lifecycle.active) return
            const restored = streamRestorer.processChunk(chunk)
            if (restored) res.write(restored)
          })

          upstreamRes.on('end', () => {
            if (!lifecycle.active) return
            const tail = streamRestorer.flush()
            if (tail) res.write(tail)
            res.end()
            resolve()
          })

          return
        }

        const responseChunks: Buffer[] = []
        upstreamRes.on('data', (chunk) => {
          if (!lifecycle.active) return
          responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })

        upstreamRes.on('end', () => {
          if (!lifecycle.active) return
          const contentType = String(upstreamRes.headers['content-type'] ?? '')
          const restored = restoreNonStreamingResponse(
            Buffer.concat(responseChunks),
            contentType,
            filter,
          )
          // Response-side PII detection (warn only, non-blocking)
          if (filter.isEnabled()) {
            const responseText = typeof restored === 'string' ? restored : restored.toString('utf8')
            void filter.filterResponseBody(responseText).catch(() => {})
          }
          res.end(restored)
          resolve()
        })

      },
    )

    if (!lifecycle.trackRequest(upstream)) return
    upstream.write(outgoingBody)
    upstream.end()
  })
}
