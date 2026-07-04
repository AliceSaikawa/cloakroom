import type { MappingTable } from './mappingTable.js'

const PLACEHOLDER_PATTERN = /^\[[A-Z_]+_\d+\]$/
const MIN_PENDING_BUFFER = 32

export class TextDeltaRestorer {
  private pending = ''

  constructor(private readonly mappingTable: MappingTable) {}

  private getMaxPendingLength(): number {
    // Keep enough buffered text to avoid splitting long custom placeholders.
    return Math.max(MIN_PENDING_BUFFER, this.mappingTable.getLongestPlaceholderLength())
  }

  process(text: string): string {
    this.pending += text
    let output = ''

    while (this.pending.length > 0) {
      const openIdx = this.pending.indexOf('[')
      if (openIdx === -1) {
        output += this.pending
        this.pending = ''
        break
      }

      output += this.pending.slice(0, openIdx)
      this.pending = this.pending.slice(openIdx)

      const closeIdx = this.pending.indexOf(']')
      if (closeIdx === -1) {
        if (this.pending.length > this.getMaxPendingLength()) {
          output += this.pending[0]
          this.pending = this.pending.slice(1)
          continue
        }
        break
      }

      const candidate = this.pending.slice(0, closeIdx + 1)
      if (PLACEHOLDER_PATTERN.test(candidate)) {
        output += this.mappingTable.resolve(candidate) ?? candidate
      } else {
        output += candidate
      }
      this.pending = this.pending.slice(closeIdx + 1)
    }

    return output
  }

  flush(): string {
    const tail = this.pending
    this.pending = ''
    return tail
  }
}
