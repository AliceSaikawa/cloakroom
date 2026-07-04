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
      out += `data: ${JSON.stringify(this.createTailChunk(tail))}\n\n`
    }

    return out
  }

  private processEvent(rawEvent: string): string {
    const lines = rawEvent.split(/\r?\n/)
    const output: string[] = []

    for (const line of lines) {
      if (!line.startsWith('data:')) {
        output.push(line)
        continue
      }

      const payload = line.slice(5).trimStart()
      if (!payload) {
        output.push(line)
        continue
      }

      if (payload === '[DONE]') {
        // Flush any placeholder fragment before the terminal OpenAI marker so
        // the client receives the fully restored text in order.
        const tail = this.textRestorer.flush()
        if (tail) {
          output.push(`data: ${JSON.stringify(this.createTailChunk(tail))}`)
        }
        output.push('data: [DONE]')
        continue
      }

      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>
        const choices = parsed['choices']

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
              deltaRecord['content'] = this.textRestorer.process(deltaRecord['content'])
            }
          }
        }

        output.push(`data: ${JSON.stringify(parsed)}`)
      } catch {
        output.push(line)
      }
    }

    return output.join('\n')
  }

  private createTailChunk(text: string): Record<string, unknown> {
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
