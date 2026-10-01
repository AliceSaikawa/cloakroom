import { StringDecoder } from 'node:string_decoder'
import type { MappingTable } from '../../core/mappingTable.js'
import { TextDeltaRestorer } from '../../core/textDeltaRestorer.js'

function findEventBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')

  if (lf === -1) return crlf
  if (crlf === -1) return lf
  return Math.min(lf, crlf)
}

export class StreamRestorer {
  private readonly utf8Decoder = new StringDecoder('utf8')
  private readonly textRestorer: TextDeltaRestorer
  private sseBuffer = ''
  private lastContentIndex = 0
  private readonly scanFn: (text: string) => string

  constructor(mappingTable: MappingTable, scanFn?: (text: string) => string) {
    this.textRestorer = new TextDeltaRestorer(mappingTable)
    this.scanFn = scanFn ?? ((t) => t)
  }

  processChunk(chunk: Buffer | string): string {
    this.sseBuffer += typeof chunk === 'string'
      ? this.utf8Decoder.end() + chunk
      : this.utf8Decoder.write(chunk)
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
    this.sseBuffer += this.utf8Decoder.end()
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
            const restored = this.scanFn(this.textRestorer.process((delta as Record<string, string>)['text']))
            ;(delta as Record<string, unknown>)['text'] = restored
          }
        }

        if (type === 'message_stop' || eventName === 'message_stop') {
          const tail = this.scanFn(this.textRestorer.flush())
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
