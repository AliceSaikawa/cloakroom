import type { MappingTable } from './mappingTable.js'

type TextTransform = (text: string) => string

function transformStrings(value: unknown, transform: TextTransform): unknown {
  if (typeof value === 'string') return transform(value)
  if (Array.isArray(value)) return value.map((item) => transformStrings(item, transform))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        transformStrings(item, transform),
      ]),
    )
  }
  return value
}

function decodeEscapedUnicode(text: string): string {
  // JSON may encode Japanese placeholder labels as \uXXXX. Decoding non-ASCII
  // characters leaves JSON punctuation and control escapes untouched.
  return text.replace(/(?<!\\)\\u([0-9a-fA-F]{4})/gu, (escape, hex: string) => {
    const codePoint = Number.parseInt(hex, 16)
    return codePoint > 0x7f ? String.fromCharCode(codePoint) : escape
  })
}

export function restoreJsonArguments(
  raw: string,
  mappingTable: MappingTable,
  transform: TextTransform = (text) => text,
): string {
  const restoreText = (text: string): string => transform(mappingTable.replaceAllPlaceholders(text))

  try {
    const parsed: unknown = JSON.parse(raw)
    return JSON.stringify(transformStrings(parsed, restoreText))
  } catch {
    return restoreText(decodeEscapedUnicode(raw))
  }
}
