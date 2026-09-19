import type { PIIFilter } from '../core/piiFilter.js'

export type StreamRestorer = {
  processChunk(chunk: Buffer | string): string
  flush(): string
}

export type ApiAdapter = {
  readonly paths: readonly string[]
  filterRequest(body: Record<string, unknown>, filter: PIIFilter): Promise<Record<string, unknown>>
  createStreamRestorer(filter: PIIFilter): StreamRestorer
}
