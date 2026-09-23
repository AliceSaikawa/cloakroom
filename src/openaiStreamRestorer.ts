import type { MappingTable } from './mappingTable.js'
import { TextDeltaRestorer } from './textDeltaRestorer.js'

function findEventBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')

  if (lf === -1) return crlf
  if (crlf === -1) return lf
  return Math.min(lf, crlf)
}

export class OpenAIStreamRestorer {
  private readonly textRestorer: TextDeltaRestorer
  private sseBuffer = ''
  private lastChoiceIndex = 0
  private lastResponsesDeltaType: string | null = null
  private lastResponseItemId: string | undefined
  private lastResponseOutputIndex: number | undefined
  private readonly scanFn: (text: string) => string

  constructor(mappingTable: MappingTable, scanFn?: (text: string) => string) {
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

    const tail = this.scanFn(this.textRestorer.flush())
    if (tail) {
      out += `data: ${JSON.stringify(this.createTailChunk(tail))}\n\n`
    }

    return out
  }

  private processEvent(rawEvent: string): string {
    const lines = rawEvent.split(/\r?\n/)
    const output: string[] = []
    const eventHeader = lines.find((line) => line.startsWith('event:'))
    const eventName = eventHeader?.slice(6).trim()
    let eventHeaderWritten = false

    const writeEventHeader = (): void => {
      if (eventHeader && !eventHeaderWritten) {
        output.push(eventHeader)
        eventHeaderWritten = true
      }
    }

    for (const line of lines) {
      if (!line.startsWith('data:')) {
        if (!line.startsWith('event:')) output.push(line)
        continue
      }

      const payload = line.slice(5).trimStart()
      if (!payload) {
        writeEventHeader()
        output.push(line)
        continue
      }

      if (payload === '[DONE]') {
        // Flush any placeholder fragment before the terminal OpenAI marker so
        // the client receives the fully restored text in order.
        const tail = this.scanFn(this.textRestorer.flush())
        if (tail) {
          this.writeSyntheticEvent(output, tail)
        }
        writeEventHeader()
        output.push('data: [DONE]')
        continue
      }

      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>
        const eventType = typeof parsed['type'] === 'string' ? parsed['type'] : eventName
        const choices = parsed['choices']

        if (
          (eventType === 'response.output_text.delta' || eventType === 'response.function_call_arguments.delta') &&
          typeof parsed['delta'] === 'string'
        ) {
          this.lastResponsesDeltaType = eventType
          this.lastResponseItemId = typeof parsed['item_id'] === 'string' ? parsed['item_id'] : undefined
          this.lastResponseOutputIndex =
            typeof parsed['output_index'] === 'number' ? parsed['output_index'] : undefined
          parsed['delta'] = this.scanFn(this.textRestorer.process(parsed['delta']))
        }

        if (eventType === 'response.completed' || eventType === 'response.failed') {
          const tail = this.scanFn(this.textRestorer.flush())
          if (tail) this.writeSyntheticEvent(output, tail)
        }

        if (Array.isArray(choices)) {
          for (const choice of choices) {
            if (!choice || typeof choice !== 'object') continue
            const choiceRecord = choice as Record<string, unknown>
            if (typeof choiceRecord['index'] === 'number') {
              this.lastChoiceIndex = choiceRecord['index'] as number
            }

            const delta = choiceRecord['delta']
            if (!delta || typeof delta !== 'object') continue

            const deltaRecord = delta as Record<string, unknown>
            if (typeof deltaRecord['content'] === 'string') {
              deltaRecord['content'] = this.scanFn(this.textRestorer.process(deltaRecord['content']))
            }
          }
        }

        writeEventHeader()
        output.push(`data: ${JSON.stringify(parsed)}`)
      } catch {
        writeEventHeader()
        output.push(line)
      }
    }

    if (eventHeader && !eventHeaderWritten) output.push(eventHeader)

    return output.join('\n')
  }

  private writeSyntheticEvent(output: string[], text: string): void {
    if (this.lastResponsesDeltaType) output.push(`event: ${this.lastResponsesDeltaType}`)
    output.push(`data: ${JSON.stringify(this.createTailChunk(text))}`, '')
  }

  private createTailChunk(text: string): Record<string, unknown> {
    if (this.lastResponsesDeltaType) {
      return {
        type: this.lastResponsesDeltaType,
        delta: text,
        ...(this.lastResponseItemId ? { item_id: this.lastResponseItemId } : {}),
        ...(this.lastResponseOutputIndex === undefined ? {} : { output_index: this.lastResponseOutputIndex }),
      }
    }

    return {
      choices: [
        {
          index: this.lastChoiceIndex,
          delta: { content: text },
        },
      ],
    }
  }
}
