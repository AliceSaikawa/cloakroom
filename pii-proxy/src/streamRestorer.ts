import type { MappingTable } from './mappingTable.js'

const PLACEHOLDER_PATTERN = /^\[[A-Z_]+_\d+\]$/
const MAX_PENDING = 25

class TextDeltaRestorer {
  private pending = ''

  constructor(private readonly mappingTable: MappingTable) {}

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
        if (this.pending.length > MAX_PENDING) {
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

function findEventBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')

  if (lf === -1) return crlf
  if (crlf === -1) return lf
  return Math.min(lf, crlf)
}

export class StreamRestorer {
  private readonly textRestorer: TextDeltaRestorer
  private sseBuffer = ''
  private lastContentIndex = 0

  constructor(mappingTable: MappingTable) {
    this.textRestorer = new TextDeltaRestorer(mappingTable)
  }

  processChunk(chunk: Buffer | string): string {
    this.sseBuffer += chunk.toString('utf8')
    let output = ''

    while (true) {
      const boundary = findEventBoundary(this.sseBuffer)
      if (boundary === -1) break

      const delimiter = this.sseBuffer.startsWith('\r\n\r\n', boundary) ? '\r\n\r\n' : '\n\n'
      const rawEvent = this.sseBuffer.slice(0, boundary)
      this.sseBuffer = this.sseBuffer.slice(boundary + delimiter.length)

      output += this.processEvent(rawEvent)
      output += delimiter
    }

    return output
  }

  flush(): string {
    let out = ''

    if (this.sseBuffer.length > 0) {
      out += this.processEvent(this.sseBuffer)
      this.sseBuffer = ''
    }

    const tail = this.textRestorer.flush()
    if (tail) {
      out += `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: this.lastContentIndex,
        delta: { type: 'text_delta', text: tail },
      })}\n\n`
    }

    return out
  }

  private processEvent(rawEvent: string): string {
    const lines = rawEvent.split(/\r?\n/)
    const output: string[] = []

    let eventName: string | null = null
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
      }
    }

    for (const line of lines) {
      if (!line.startsWith('data:')) {
        output.push(line)
        continue
      }

      const payload = line.slice(5).trimStart()
      if (!payload || payload === '[DONE]') {
        output.push(line)
        continue
      }

      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>
        const type = parsed['type']

        if (type === 'content_block_delta' || eventName === 'content_block_delta') {
          if (typeof parsed['index'] === 'number') {
            this.lastContentIndex = parsed['index'] as number
          }

          const delta = parsed['delta']
          if (
            delta &&
            typeof delta === 'object' &&
            (delta as Record<string, unknown>)['type'] === 'text_delta' &&
            typeof (delta as Record<string, unknown>)['text'] === 'string'
          ) {
            const restored = this.textRestorer.process((delta as Record<string, string>)['text'])
            ;(delta as Record<string, unknown>)['text'] = restored
          }
        }

        if (type === 'message_stop' || eventName === 'message_stop') {
          const tail = this.textRestorer.flush()
          if (tail) {
            output.push(
              `event: content_block_delta`,
              `data: ${JSON.stringify({
                type: 'content_block_delta',
                index: this.lastContentIndex,
                delta: { type: 'text_delta', text: tail },
              })}`,
              '',
            )
          }
        }

        output.push(`data: ${JSON.stringify(parsed)}`)
      } catch {
        output.push(line)
      }
    }

    return output.join('\n')
  }
}
