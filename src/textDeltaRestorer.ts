import type { MappingTable } from './mappingTable.js'

const MIN_PENDING_BUFFER = 32
// Additional buffer headroom for FPE-encoded tokens (max CREDIT_CARD token = 18 chars, with margin)
const FPE_MAX_ENCODED_LENGTH = 30

export class TextDeltaRestorer {
  private pending = ''

  constructor(private readonly mappingTable: MappingTable) {}

  private getMaxPendingLength(): number {
    // Keep enough buffered text to avoid splitting long placeholders or FPE tokens.
    return Math.max(MIN_PENDING_BUFFER, this.mappingTable.getLongestPlaceholderLength() + FPE_MAX_ENCODED_LENGTH)
  }

  process(text: string): string {
    this.pending += text
    let output = ''

    while (this.pending.length > 0) {
      const opening = this.pending.match(/[\[［「]/u)
      const openIdx = opening?.index ?? -1
      if (openIdx === -1) {
        output += this.pending
        this.pending = ''
        break
      }

      output += this.pending.slice(0, openIdx)
      this.pending = this.pending.slice(openIdx)

      const openChar = this.pending[0] ?? ''
      const closeChar = openChar === '[' ? ']' : openChar === '［' ? '］' : '」'
      const closeIdx = this.pending.indexOf(closeChar)
      if (closeIdx === -1) {
        if (this.pending.length > this.getMaxPendingLength()) {
          output += this.pending[0]
          this.pending = this.pending.slice(1)
          continue
        }
        break
      }

      const candidate = this.pending.slice(0, closeIdx + 1)
      output += this.mappingTable.resolve(candidate) ?? candidate
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
