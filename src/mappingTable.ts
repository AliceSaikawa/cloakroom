import type { PIICategory } from './types.js'

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toAlphabeticSequence(count: number): string {
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
  ): string {
    const existing = this.originalToPlaceholder.get(original)
    if (existing) return existing

    // Key the counter by the visible prefix, not the category: two categories
    // sharing a prefix (e.g. a custom label colliding with a built-in Japanese
    // label) must still produce distinct placeholders, or restoration would
    // silently return the wrong original value.
    const count = (this.counters.get(placeholderPrefix) ?? 0) + 1
    this.counters.set(placeholderPrefix, count)

    const placeholder = `[${placeholderPrefix}${toAlphabeticSequence(count)}]`
    this.originalToPlaceholder.set(original, placeholder)
    if (reversible) {
      this.placeholderToOriginal.set(placeholder, original)
    }

    return placeholder
  }

  resolve(placeholder: string): string | undefined {
    return this.placeholderToOriginal.get(placeholder)
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

    return input.replace(pattern, (match) => this.placeholderToOriginal.get(match) ?? match)
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
}
