import type { MappingTable } from './mappingTable.js'
import { restoreJsonArguments } from './jsonArgumentRestorer.js'
import { TextDeltaRestorer } from './textDeltaRestorer.js'

function findEventBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')

  if (lf === -1) return crlf
  if (crlf === -1) return lf
  return Math.min(lf, crlf)
}

export class StreamRestorer {
  private readonly mappingTable: MappingTable
  private readonly textRestorer: TextDeltaRestorer
  private sseBuffer = ''
  private lastContentIndex = 0
  private readonly scanFn: (text: string) => string
  private readonly pendingInputJson = new Map<number, string>()

  constructor(mappingTable: MappingTable, scanFn?: (text: string) => string) {
    this.mappingTable = mappingTable
    this.textRestorer = new TextDeltaRestorer(mappingTable)
    this.scanFn = scanFn ?? ((t) => t)
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

      const processed = this.processEvent(rawEvent)
      if (processed) output += processed + delimiter
    }

    return output
  }

  flush(): string {
    const output: string[] = []

    if (this.sseBuffer.length > 0) {
      const processed = this.processEvent(this.sseBuffer)
      if (processed) output.push(processed)
      this.sseBuffer = ''
    }

    const pendingEvents = [...this.pendingInputJson.keys()]
      .map((index) => this.createInputJsonEvent(index))
      .filter(Boolean)
    if (pendingEvents.length > 0) output.push(pendingEvents.join('\n\n'))
    this.pendingInputJson.clear()

    const tail = this.textRestorer.flush()
    if (tail) {
      output.push(`event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: this.lastContentIndex,
        delta: { type: 'text_delta', text: tail },
      })}`)
    }

    return output.join('\n\n') + (output.length > 0 ? '\n\n' : '')
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

    const dataLine = lines.find((line) => line.startsWith('data:'))
    const dataPayload = dataLine?.slice(5).trimStart()
    let parsedEvent: Record<string, unknown> | undefined
    if (dataPayload && dataPayload !== '[DONE]') {
      try {
        parsedEvent = JSON.parse(dataPayload) as Record<string, unknown>
      } catch {
        parsedEvent = undefined
      }
    }

    const type = parsedEvent?.['type'] ?? eventName
    if (type === 'content_block_delta') {
      const index = parsedEvent?.['index']
      const delta = parsedEvent?.['delta']
      if (
        typeof index === 'number' &&
        delta &&
        typeof delta === 'object' &&
        (delta as Record<string, unknown>)['type'] === 'input_json_delta' &&
        typeof (delta as Record<string, unknown>)['partial_json'] === 'string'
      ) {
        const partial = (delta as Record<string, string>)['partial_json']
        this.pendingInputJson.set(index, (this.pendingInputJson.get(index) ?? '') + partial)
        return ''
      }
    }

    const queuedEvents: string[] = []
    if (type === 'content_block_stop' && typeof parsedEvent?.['index'] === 'number') {
      const restored = this.createInputJsonEvent(parsedEvent['index'])
      if (restored) queuedEvents.push(restored)
    }
    if (type === 'message_stop') {
      for (const [index] of this.pendingInputJson) {
        const restored = this.createInputJsonEvent(index)
        if (restored) queuedEvents.push(restored)
      }
      this.pendingInputJson.clear()
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

    const currentEvent = output.join('\n')
    return queuedEvents.length > 0
      ? `${queuedEvents.join('\n\n')}\n\n${currentEvent}`
      : currentEvent
  }

  private createInputJsonEvent(index: number): string {
    const pending = this.pendingInputJson.get(index)
    if (pending === undefined) return ''
    this.pendingInputJson.delete(index)

    const partialJson = restoreJsonArguments(pending, this.mappingTable, this.scanFn)
    return `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: partialJson },
    })}`
  }
}
