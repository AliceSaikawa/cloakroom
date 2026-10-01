import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import type { request as httpsRequest } from 'node:https'
import type { ApiAdapter } from '../api/types.js'
import { restoreNonStreamingResponse } from '../api/shared/responseRestorer.js'
import { BlockedByPolicyError } from '../core/piiFilter.js'
import { incMaskedRequests, incPassthroughRequests } from '../core/stats.js'
import { getMessageTrailers, hasBodyValidationMetadata, responseTrailers, normalizeUpstreamHeaders, readBody, writeJson, writeUpstreamResponseHeaders } from './httpUtils.js'
import { resolveProvider } from './provider.js'
import type { SessionFilterStore } from './sessionFilterStore.js'

export async function proxyPassThrough(
  req: IncomingMessage,
  res: ServerResponse,
  requestUpstream: typeof httpsRequest,
): Promise<void> {
  const body = await readBody(req)
  const trailers = getMessageTrailers(req)
  const provider = resolveProvider(req)
  incPassthroughRequests(req.url?.split('?')[0] ?? '/')
  const headers = normalizeUpstreamHeaders(req.headers, provider.host, body.length, trailers)

  await new Promise<void>((resolve, reject) => {
    const upstream = requestUpstream(
      `${provider.origin}${req.url ?? '/'}`,
      {
        method: req.method,
        headers,
      },
      (upstreamRes) => {
        writeUpstreamResponseHeaders(upstreamRes, res)
        upstreamRes.pipe(res, { end: false })
        upstreamRes.on('end', () => {
          const trailers = responseTrailers(upstreamRes, false)
          if (trailers.length) res.addTrailers(trailers)
          res.end()
          resolve()
        })
        upstreamRes.on('error', reject)
      },
    )

    upstream.on('error', reject)
    upstream.write(body)
    if (trailers.length > 0) upstream.addTrailers(trailers)
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
  const trailers = getMessageTrailers(req)

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

  const originalJson = JSON.stringify(parsedBody)
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

  const filteredJson = JSON.stringify(filteredBody)
  const outgoingBody = filteredJson === originalJson ? rawBody : Buffer.from(filteredJson, 'utf8')
  if (!outgoingBody.equals(rawBody) && hasBodyValidationMetadata(req.headers, trailers)) {
    writeJson(res, 400, { error: 'Request body validation metadata cannot be forwarded after transforming the body' })
    return
  }
  if (filter.isEnabled()) incMaskedRequests()
  const headers = normalizeUpstreamHeaders(req.headers, provider.host, outgoingBody.length, trailers)

  await new Promise<void>((resolve, reject) => {
    const upstream = requestUpstream(
      `${provider.origin}${req.url ?? '/v1/messages'}`,
      {
        method: 'POST',
        headers,
      },
      (upstreamRes) => {
        const isSSE = (upstreamRes.headers['content-type'] ?? '').includes('text/event-stream')
        if (parsedBody['stream'] === true && isSSE) {
          const context = filter.getStreamRestorationContext()
          const hasBody = upstreamRes.statusCode !== 204 && upstreamRes.statusCode !== 304
          const canRestore = hasBody && (context.mappingTable.getLongestPlaceholderLength() > 0 || !!context.restoreEncodedText)
          writeUpstreamResponseHeaders(upstreamRes, res, canRestore, true)
          if (!canRestore) {
            upstreamRes.pipe(res, { end: false })
            upstreamRes.on('end', () => {
              const trailers = responseTrailers(upstreamRes, false)
              if (trailers.length) res.addTrailers(trailers)
              res.end()
              resolve()
            })
            upstreamRes.on('error', reject)
            return
          }
          const streamRestorer = adapter.createStreamRestorer(filter)
          const originalHash = createHash('sha256')
          const restoredHash = createHash('sha256')
          const writeRestored = (text: string) => {
            if (text) {
              restoredHash.update(text, 'utf8')
              res.write(text)
            }
          }

          upstreamRes.on('data', (chunk: Buffer) => {
            originalHash.update(chunk)
            writeRestored(streamRestorer.processChunk(chunk))
          })

          upstreamRes.on('end', () => {
            writeRestored(streamRestorer.flush())
            const changed = !originalHash.digest().equals(restoredHash.digest())
            const trailers = responseTrailers(upstreamRes, changed)
            if (trailers.length) res.addTrailers(trailers)
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
          const contentType = String(upstreamRes.headers['content-type'] ?? '')
          const original = Buffer.concat(responseChunks)
          const restored = restoreNonStreamingResponse(
            original,
            contentType,
            filter,
          )
          const changed = !Buffer.from(restored).equals(original)
          writeUpstreamResponseHeaders(upstreamRes, res, changed)
          const trailers = responseTrailers(upstreamRes, changed)
          if (trailers.length) res.addTrailers(trailers)
          // Response-side PII detection (warn only, non-blocking)
          if (filter.isEnabled()) {
            const responseText = typeof restored === 'string' ? restored : restored.toString('utf8')
            void filter.filterResponseBody(responseText).catch(() => {})
          }
          res.end(restored)
          resolve()
        })

        upstreamRes.on('error', reject)
      },
    )

    upstream.on('error', reject)
    upstream.write(outgoingBody)
    if (trailers.length > 0) upstream.addTrailers(trailers)
    upstream.end()
  })
}
