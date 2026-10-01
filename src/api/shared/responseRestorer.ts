import type { PIIFilter } from '../../core/piiFilter.js'

function isJsonContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase()
  return normalized.includes('application/json') || normalized.includes('+json')
}

function isTextContentType(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('text/')
}

export function restoreNonStreamingResponse(
  responseBody: Buffer,
  contentType: string,
  filter: PIIFilter,
): string | Buffer {
  if (!isJsonContentType(contentType) && !isTextContentType(contentType)) {
    return responseBody
  }

  const raw = responseBody.toString('utf8')
  if (!isJsonContentType(contentType)) {
    const restored = filter.restoreText(raw)
    return restored === raw ? responseBody : restored
  }

  try {
    const parsed = JSON.parse(raw)
    const original = JSON.stringify(parsed)
    const restored = JSON.stringify(filter.restoreResponseBody(parsed))
    return restored === original ? responseBody : restored
  } catch {
    // Some upstream error responses use a JSON content type but return text.
    const restored = filter.restoreText(raw)
    return restored === raw ? responseBody : restored
  }
}
