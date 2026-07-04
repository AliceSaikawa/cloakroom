import type { PIICategory } from './types.js'

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class MappingTable {
  private readonly originalToPlaceholder = new Map<string, string>()
  private readonly placeholderToOriginal = new Map<string, string>()
  private readonly counters = new Map<PIICategory, number>()

  register(original: string, category: PIICategory): string {
    const existing = this.originalToPlaceholder.get(original)
    if (existing) return existing

    const count = (this.counters.get(category) ?? 0) + 1
    this.counters.set(category, count)

    const placeholder = `[${category}_${count}]`
    this.originalToPlaceholder.set(original, placeholder)
    this.placeholderToOriginal.set(placeholder, original)

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
