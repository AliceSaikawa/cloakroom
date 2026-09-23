import type { MappingTable } from './mappingTable.js'
import { restoreJsonArguments } from './jsonArgumentRestorer.js'
import { TextDeltaRestorer } from './textDeltaRestorer.js'

type BufferedResponseEvent = {
  readonly rawEvent: string
  readonly eventName: string | null
  readonly parsed?: Record<string, unknown>
  readonly argumentKey?: string
  readonly argumentKind?: 'delta' | 'done'
}

function findEventBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')

  if (lf === -1) return crlf
  if (crlf === -1) return lf
  return Math.min(lf, crlf)
}

function getArgumentKey(event: Record<string, unknown>): string {
  if (typeof event['item_id'] === 'string') return event['item_id']
  if (typeof event['output_index'] === 'number') return String(event['output_index'])
  return 'default'
}

export class OpenAIStreamRestorer {
  private readonly textRestorer: TextDeltaRestorer
  private sseBuffer = ''
  private lastChoiceIndex = 0
  private readonly scanFn: (text: string) => string
  private readonly pendingToolArguments = new Map<string, string>()
  private readonly responseArguments = new Map<string, string>()
  private readonly activeResponseArguments = new Set<string>()
  private responseEvents: BufferedResponseEvent[] = []

  constructor(
    private readonly mappingTable: MappingTable,
    scanFn?: (text: string) => string,
  ) {
    this.textRestorer = new TextDeltaRestorer(mappingTable)
    this.scanFn = scanFn ?? ((text) => text)
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

    if (this.responseEvents.length > 0) {
      const processed = this.flushResponseEvents()
      if (processed) output.push(processed)
    }

    for (const choiceIndex of this.getPendingChoiceIndices()) {
      output.push(...this.createToolArgumentEvents(choiceIndex))
    }

    const tail = this.scanFn(this.textRestorer.flush())
    if (tail) output.push(`data: ${JSON.stringify(this.createTailChunk(tail))}`)
    return output.filter(Boolean).join('\n\n') + (output.length > 0 ? '\n\n' : '')
  }

  private processEvent(rawEvent: string): string {
    const record = this.parseEvent(rawEvent)
    const type = record.parsed?.['type'] ?? record.eventName

    if (type === 'response.function_call_arguments.delta' && record.parsed) {
      const key = getArgumentKey(record.parsed)
      const delta = record.parsed['delta']
      if (typeof delta === 'string') {
        this.responseArguments.set(key, (this.responseArguments.get(key) ?? '') + delta)
        this.activeResponseArguments.add(key)
        this.responseEvents.push({ ...record, argumentKey: key, argumentKind: 'delta' })
        return ''
      }
    }

    if (this.responseEvents.length > 0) {
      let buffered = record
      if (type === 'response.function_call_arguments.done' && record.parsed) {
        const key = getArgumentKey(record.parsed)
        const finalArguments = record.parsed['arguments']
        if (typeof finalArguments === 'string') this.responseArguments.set(key, finalArguments)
        if (this.activeResponseArguments.has(key)) {
          this.activeResponseArguments.delete(key)
          buffered = { ...record, argumentKey: key, argumentKind: 'done' }
        }
      }

      this.responseEvents.push(buffered)
      if (this.activeResponseArguments.size === 0) return this.flushResponseEvents()
      return ''
    }

    return this.processNormalEvent(rawEvent, record.parsed, record.eventName)
  }

  private parseEvent(rawEvent: string): BufferedResponseEvent {
    const lines = rawEvent.split(/\r?\n/u)
    const eventName = lines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim() ?? null
    const dataLine = lines.find((line) => line.startsWith('data:'))
    const payload = dataLine?.slice(5).trimStart()
    if (!payload || payload === '[DONE]') return { rawEvent, eventName }

    try {
      return { rawEvent, eventName, parsed: JSON.parse(payload) as Record<string, unknown> }
    } catch {
      return { rawEvent, eventName }
    }
  }

  private flushResponseEvents(): string {
    const restoredArguments = new Map<string, string>()
    for (const [key, raw] of this.responseArguments) {
      restoredArguments.set(key, restoreJsonArguments(raw, this.mappingTable, this.scanFn))
    }

    const seenDelta = new Set<string>()
    const output: string[] = []
    for (const event of this.responseEvents) {
      let rawEvent = event.rawEvent
      let parsedOverride = event.parsed
      if (event.parsed && event.argumentKey) {
        const restored = restoredArguments.get(event.argumentKey) ?? ''
        const parsed = { ...event.parsed }
        if (event.argumentKind === 'delta') {
          if (seenDelta.has(event.argumentKey)) parsed['delta'] = ''
          else {
            parsed['delta'] = restored
            seenDelta.add(event.argumentKey)
          }
        } else if (event.argumentKind === 'done') {
          parsed['arguments'] = restored
        }
        rawEvent = this.replaceData(rawEvent, parsed)
        parsedOverride = parsed
      }

      const processed = this.processNormalEvent(rawEvent, parsedOverride, event.eventName)
      if (processed) output.push(processed)
    }

    this.responseEvents = []
    this.responseArguments.clear()
    this.activeResponseArguments.clear()
    return output.join('\n\n')
  }

  private processNormalEvent(
    rawEvent: string,
    parsedOverride?: Record<string, unknown>,
    eventName?: string | null,
  ): string {
    const lines = rawEvent.split(/\r?\n/u)
    const output: string[] = []
    let overrideUsed = false

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
        const tail = this.scanFn(this.textRestorer.flush())
        if (tail) output.push(`data: ${JSON.stringify(this.createTailChunk(tail))}`)
        output.push(...this.createToolArgumentEventsForAll())
        output.push('data: [DONE]')
        continue
      }

      try {
        const parsed = !overrideUsed && parsedOverride
          ? { ...parsedOverride }
          : JSON.parse(payload) as Record<string, unknown>
        overrideUsed = true
        const type = parsed['type'] ?? eventName

        if (type === 'response.output_text.delta' && typeof parsed['delta'] === 'string') {
          parsed['delta'] = this.scanFn(this.textRestorer.process(parsed['delta']))
        }

        const choices = parsed['choices']
        const toolEvents: string[] = []
        if (Array.isArray(choices)) {
          for (const choice of choices) {
            if (!choice || typeof choice !== 'object') continue
            const choiceRecord = choice as Record<string, unknown>
            const choiceIndex = typeof choiceRecord['index'] === 'number' ? choiceRecord['index'] : 0
            this.lastChoiceIndex = choiceIndex
            const delta = choiceRecord['delta']
            if (delta && typeof delta === 'object') {
              const deltaRecord = delta as Record<string, unknown>
              if (typeof deltaRecord['content'] === 'string') {
                deltaRecord['content'] = this.scanFn(this.textRestorer.process(deltaRecord['content']))
              }
              const toolCalls = deltaRecord['tool_calls']
              if (Array.isArray(toolCalls)) {
                for (const toolCall of toolCalls) {
                  if (!toolCall || typeof toolCall !== 'object') continue
                  const call = toolCall as Record<string, unknown>
                  const toolIndex = typeof call['index'] === 'number' ? call['index'] : 0
                  const fn = call['function']
                  if (!fn || typeof fn !== 'object') continue
                  const functionRecord = fn as Record<string, unknown>
                  if (typeof functionRecord['arguments'] !== 'string') continue

                  const key = `${choiceIndex}:${toolIndex}`
                  this.pendingToolArguments.set(
                    key,
                    (this.pendingToolArguments.get(key) ?? '') + functionRecord['arguments'],
                  )
                  functionRecord['arguments'] = ''
                }
              }
            }

            if (choiceRecord['finish_reason'] !== null && choiceRecord['finish_reason'] !== undefined) {
              toolEvents.push(...this.createToolArgumentEvents(choiceIndex, parsed))
            }
          }
        }

        output.push(...toolEvents)
        output.push(`data: ${JSON.stringify(parsed)}`)
      } catch {
        output.push(line)
      }
    }

    return output.join('\n')
  }

  private createToolArgumentEvents(choiceIndex: number, metadata?: Record<string, unknown>): string[] {
    const prefix = `${choiceIndex}:`
    const toolCalls: Record<string, unknown>[] = []
    for (const [key, raw] of this.pendingToolArguments) {
      if (!key.startsWith(prefix)) continue
      const toolIndex = Number(key.slice(prefix.length))
      toolCalls.push({
        index: toolIndex,
        function: { arguments: restoreJsonArguments(raw, this.mappingTable, this.scanFn) },
      })
      this.pendingToolArguments.delete(key)
    }
    if (toolCalls.length === 0) return []

    const base = metadata ? { ...metadata } : {}
    delete base['choices']
    return [`data: ${JSON.stringify({
      ...base,
      choices: [{ index: choiceIndex, delta: { tool_calls: toolCalls }, finish_reason: null }],
    })}`]
  }

  private createToolArgumentEventsForAll(): string[] {
    return this.getPendingChoiceIndices().flatMap((index) => this.createToolArgumentEvents(index))
  }

  private getPendingChoiceIndices(): number[] {
    return [...new Set([...this.pendingToolArguments.keys()].map((key) => Number(key.split(':', 1)[0])))]
  }

  private replaceData(rawEvent: string, parsed: Record<string, unknown>): string {
    const lines = rawEvent.split(/\r?\n/u)
    const index = lines.findIndex((line) => line.startsWith('data:'))
    if (index >= 0) lines[index] = `data: ${JSON.stringify(parsed)}`
    return lines.join('\n')
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
