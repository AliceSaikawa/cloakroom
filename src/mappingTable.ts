import type { PIICategory, PlaceholderFormat, VaultData } from './types.js'

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toCategorySlug(category: PIICategory): string {
  const slug = String(category)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
  return slug || 'custom'
}

function escapeXmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

function createXmlPlaceholder(category: PIICategory, count: number, context?: string): string {
  const contextAttribute = context === undefined ? '' : ` context="${escapeXmlAttribute(context)}"`
  return `<pii:${toCategorySlug(category)} id="${count}"${contextAttribute}/>`
}

export function toAlphabeticSequence(count: number): string {
  let value = count
  let result = ''

  // Spreadsheet-style numbering: 1 = A, 26 = Z, 27 = AA.
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }

  return result
}

export class MappingTable {
  private readonly originalToPlaceholder = new Map<string, string>()
  private readonly placeholderToOriginal = new Map<string, string>()
  private readonly counters = new Map<string, number>()

  register(
    original: string,
    category: PIICategory,
    placeholderPrefix: string = String(category),
    reversible = true,
    createReplacement?: (count: number) => string,
    format: PlaceholderFormat = 'xml',
    context?: string,
  ): string {
    const existing = this.originalToPlaceholder.get(original)
    if (existing) return existing

    // Legacy labels use their visible text; XML tokens use the sanitized category
    // so categories that collapse to the same slug still get unique IDs.
    const counterKey = format === 'legacy' ? placeholderPrefix : toCategorySlug(category)
    const count = (this.counters.get(counterKey) ?? 0) + 1
    this.counters.set(counterKey, count)

    const replacement = createReplacement
      ? createReplacement(count)
      : format === 'legacy'
        ? `[${placeholderPrefix}${toAlphabeticSequence(count)}]`
        : createXmlPlaceholder(category, count, context)
    this.originalToPlaceholder.set(original, replacement)
    if (reversible) {
      this.placeholderToOriginal.set(replacement, original)
    }

    return replacement
  }

  resolve(placeholder: string): string | undefined {
    return this.placeholderToOriginal.get(placeholder) ?? this.resolveNormalized(placeholder)
  }

  hasMappings(): boolean {
    return this.originalToPlaceholder.size > 0
  }

  hasReplacement(value: string): boolean {
    return this.placeholderToOriginal.has(value)
  }

  replaceAllPlaceholders(input: string): string {
    if (this.placeholderToOriginal.size === 0) return input

    // Replace every known placeholder in a single pass to avoid quadratic scans.
    const pattern = new RegExp(
      [...this.placeholderToOriginal.keys()]
        .sort((left, right) => right.length - left.length)
        .map(escapeRegExp)
        .join('|'),
      'g',
    )

    const exactReplaced = input.replace(pattern, (match) => this.placeholderToOriginal.get(match) ?? match)

    // A model may turn brackets full-width, add spaces, or use Japanese quotes.
    // Only replace candidates that normalize to a placeholder we actually issued.
    return exactReplaced.replace(
      /(?:\[[^\]\r\n]{1,256}\]|［[^］\r\n]{1,256}］|「[^」\r\n]{1,256}」|<pii:[^>\r\n]{1,256}\/?>)/giu,
      (match) => this.resolveNormalized(match) ?? match,
    )
  }

  getLongestPlaceholderLength(): number {
    let longest = 0
    for (const placeholder of this.placeholderToOriginal.keys()) {
      longest = Math.max(longest, placeholder.length)
    }
    return longest
  }

  clear(): void {
    this.originalToPlaceholder.clear()
    this.placeholderToOriginal.clear()
    this.counters.clear()
  }

  toJSON(): VaultData {
    return {
      originalToPlaceholder: Object.fromEntries(this.originalToPlaceholder),
      placeholderToOriginal: Object.fromEntries(this.placeholderToOriginal),
      counters: Object.fromEntries(this.counters),
    }
  }

  static fromJSON(data: VaultData): MappingTable {
    const table = new MappingTable()
    for (const [original, placeholder] of Object.entries(data.originalToPlaceholder)) {
      table.originalToPlaceholder.set(original, placeholder)
    }
    for (const [placeholder, original] of Object.entries(data.placeholderToOriginal)) {
      table.placeholderToOriginal.set(placeholder, original)
    }
    for (const [prefix, count] of Object.entries(data.counters)) {
      table.counters.set(prefix, Number(count))
    }
    return table
  }

  private resolveNormalized(value: string): string | undefined {
    const normalized = normalizePlaceholder(value)
    if (normalized === value) return undefined

    for (const [placeholder, original] of this.placeholderToOriginal) {
      if (normalizePlaceholder(placeholder) === normalized) return original
    }
    return undefined
  }
}

function normalizePlaceholder(value: string): string {
  if (value.toLowerCase().startsWith('<pii:')) {
    const normalized = value.toLowerCase().replace(/\s+/gu, ' ').trim()
    const match = normalized.match(
      /^<pii:([a-z0-9_-]+)\s+id\s*=\s*["'](\d+)["'](?:\s+context\s*=\s*["']([^"']*)["'])?\s*\/>$/u,
    )
    if (!match) return value
    const contextAttribute = match[3] === undefined ? '' : ` context="${match[3]}"`
    return `<pii:${match[1]} id="${match[2]}"${contextAttribute}/>`
  }

  let normalized = value
  if (normalized.startsWith('「') && normalized.endsWith('」')) {
    normalized = `[${normalized.slice(1, -1)}]`
  }
  normalized = normalized.replaceAll('［', '[').replaceAll('］', ']')
  if (!normalized.startsWith('[') || !normalized.endsWith(']')) return value

  return `[${normalized.slice(1, -1).replace(/\s+/gu, '')}]`
}
