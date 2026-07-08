import { loadPIIConfig } from './config.js'
import { getActiveCategories, isPassthroughEnabled } from './controlState.js'
import { MappingTable } from './mappingTable.js'
import { OpenAIStreamRestorer } from './openaiStreamRestorer.js'
import { applyReplacements, detectDictionaryPII, detectRegexPII } from './regexFilter.js'
import { StreamRestorer } from './streamRestorer.js'
import type { PIICategory, PIIFilterConfig } from './types.js'

export class PIIFilter {
  private readonly mappingTable = new MappingTable()
  private readonly config: PIIFilterConfig
  private readonly allowlist: ReadonlySet<string>

  constructor(config = loadPIIConfig()) {
    this.config = config
    this.allowlist = new Set(config.allowlist)
  }

  isEnabled(): boolean {
    return this.config.enabled && !isPassthroughEnabled()
  }

  createStreamRestorer(): StreamRestorer {
    return new StreamRestorer(this.mappingTable)
  }

  createOpenAIStreamRestorer(): OpenAIStreamRestorer {
    return new OpenAIStreamRestorer(this.mappingTable)
  }

  async filterRequestBody(requestBody: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.isEnabled()) return requestBody

    const cloned = structuredClone(requestBody)

    if ('system' in cloned) {
      cloned['system'] = await this.filterSystemField(cloned['system'])
    }

    if (Array.isArray(cloned['messages'])) {
      cloned['messages'] = await this.filterMessages(cloned['messages'] as readonly unknown[])
    }

    return cloned
  }

  restoreText(text: string): string {
    return this.mappingTable.replaceAllPlaceholders(text)
  }

  restoreResponseBody<T>(payload: T): T {
    if (!this.isEnabled()) return payload
    return this.restoreRecursive(payload) as T
  }

  reset(): void {
    this.mappingTable.clear()
  }

  private registerMaskedValue(original: string, category: PIICategory): string {
    if (this.allowlist.has(original)) return original
    return this.mappingTable.register(original, category)
  }

  private async filterMessages(messages: readonly unknown[]): Promise<unknown[]> {
    const filtered: unknown[] = []

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') {
        filtered.push(msg)
        continue
      }

      const message = { ...(msg as Record<string, unknown>) }
      if ('content' in message) {
        message['content'] = await this.filterContent(message['content'])
      }
      filtered.push(message)
    }

    return filtered
  }

  private async filterSystemField(system: unknown): Promise<unknown> {
    if (typeof system === 'string') {
      return this.filterText(system)
    }

    if (Array.isArray(system)) {
      const filteredBlocks: unknown[] = []
      for (const block of system) {
        if (!block || typeof block !== 'object') {
          filteredBlocks.push(block)
          continue
        }

        const out = { ...(block as Record<string, unknown>) }
        if (out['type'] === 'text' && typeof out['text'] === 'string') {
          out['text'] = await this.filterText(out['text'])
        }
        filteredBlocks.push(out)
      }
      return filteredBlocks
    }

    return system
  }

  private async filterContent(content: unknown): Promise<unknown> {
    if (typeof content === 'string') return this.filterText(content)

    if (!Array.isArray(content)) return content

    const filteredBlocks: unknown[] = []
    for (const block of content) {
      if (!block || typeof block !== 'object') {
        filteredBlocks.push(block)
        continue
      }

      const out = { ...(block as Record<string, unknown>) }

      if (out['type'] === 'text' && typeof out['text'] === 'string') {
        out['text'] = await this.filterText(out['text'])
      } else if (out['type'] === 'tool_result') {
        if (typeof out['content'] === 'string') {
          out['content'] = await this.filterText(out['content'])
        } else if (Array.isArray(out['content'])) {
          out['content'] = await this.filterContent(out['content'])
        }
      }

      filteredBlocks.push(out)
    }

    return filteredBlocks
  }

  private async filterText(text: string): Promise<string> {
    if (!text.trim()) return text

    let filtered = text
    const categories = getActiveCategories(this.config.categories)
    if (categories.length === 0) return filtered

    const dictionaryMatches = detectDictionaryPII(
      filtered,
      categories,
      this.config.dictionary,
    )
    filtered = applyReplacements(filtered, dictionaryMatches, this.registerMaskedValue.bind(this))

    const regexMatches = detectRegexPII(filtered, categories, this.config.customPatterns)
    filtered = applyReplacements(filtered, regexMatches, this.registerMaskedValue.bind(this))

    return filtered
  }

  private restoreRecursive(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.restoreText(value)
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.restoreRecursive(item))
    }

    if (value && typeof value === 'object') {
      const output: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        output[key] = this.restoreRecursive(item)
      }
      return output
    }

    return value
  }
}
