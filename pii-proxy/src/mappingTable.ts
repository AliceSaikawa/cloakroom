import type { PIICategory } from './types.js'

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
    let output = input
    for (const [placeholder, original] of this.placeholderToOriginal.entries()) {
      while (output.includes(placeholder)) {
        output = output.replace(placeholder, original)
      }
    }
    return output
  }

  clear(): void {
    this.originalToPlaceholder.clear()
    this.placeholderToOriginal.clear()
    this.counters.clear()
  }

}
