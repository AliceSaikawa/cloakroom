import type { IncomingMessage } from 'node:http'

export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds the ${maxBytes}-byte limit`)
    this.name = 'RequestBodyTooLargeError'
  }
}

function getContentLength(req: IncomingMessage): number | undefined {
  const header = req.headers['content-length']
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return undefined

  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

export function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const contentLength = getContentLength(req)
  if (contentLength !== undefined && contentLength > maxBytes) {
    // Drain the request so the connection can be reused after the 413 response.
    req.resume()
    return Promise.reject(new RequestBodyTooLargeError(maxBytes))
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let receivedBytes = 0
    let finished = false

    req.on('data', (chunk: Buffer | string) => {
      if (finished) return

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      receivedBytes += buffer.length
      if (receivedBytes > maxBytes) {
        finished = true
        // Do not retain the rest of an oversized streaming body in memory.
        req.resume()
        reject(new RequestBodyTooLargeError(maxBytes))
        return
      }

      chunks.push(buffer)
    })
    req.on('end', () => {
      if (!finished) resolve(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      if (!finished) reject(error)
    })
  })
}
