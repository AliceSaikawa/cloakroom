import type { PIIFilter } from './piiFilter.js'

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
    return filter.restoreText(raw)
  }

  try {
    return JSON.stringify(filter.restoreResponseBody(JSON.parse(raw)))
  } catch {
    // Some upstream error responses use a JSON content type but return text.
    return filter.restoreText(raw)
  }
}
