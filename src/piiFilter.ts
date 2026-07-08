import { loadPIIConfig } from './config.js'
import { getActiveCategories, isPassthroughEnabled } from './controlState.js'
import { writeAuditLog } from './auditLog.js'
import { MappingTable } from './mappingTable.js'
import { detectOllamaPII } from './ollamaFilter.js'
import { OpenAIStreamRestorer } from './openaiStreamRestorer.js'
import {
  applyReplacements,
  detectDictionaryPII,
  detectRegexPII,
  selectNonOverlappingMatches,
} from './regexFilter.js'
import { StreamRestorer } from './streamRestorer.js'
import type { CustomPatternEntry, DictionaryEntry, PIICategory, PIIFilterConfig, PIIMatch } from './types.js'

function getCustomCategoryNames(config: PIIFilterConfig): readonly PIICategory[] {
  return config.customCategories
    .filter((category) => category.enabled !== false)
    .map((category) => category.name)
}

function getConfiguredCategories(config: PIIFilterConfig): readonly PIICategory[] {
  const customPatternCategories = config.customPatterns.map((pattern) => pattern.category ?? pattern.name)
  return [...new Set([...config.categories, ...getCustomCategoryNames(config), ...customPatternCategories])]
}

function getCustomDictionary(config: PIIFilterConfig): readonly DictionaryEntry[] {
  return config.customCategories.flatMap((category) => {
    if (category.enabled === false) return []
    return (category.dictionary ?? []).map((text) => ({ text, category: category.name }))
  })
}

function getCustomPatterns(config: PIIFilterConfig): readonly CustomPatternEntry[] {
  return [
    ...config.customPatterns,
    ...config.customCategories.flatMap((category) => {
      if (category.enabled === false) return []
      return (category.patterns ?? []).map((pattern, index) => ({
        name: `${category.name}_${index + 1}`,
        category: category.name,
        pattern,
      }))
    }),
  ]
}

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
    if (this.config.mode === 'anonymize') return text
    return this.mappingTable.replaceAllPlaceholders(text)
  }

  restoreResponseBody<T>(payload: T): T {
    if (!this.isEnabled()) return payload
    if (this.config.mode === 'anonymize') return payload
    return this.restoreRecursive(payload) as T
  }

  async analyzeText(text: string, options: { readonly useOllama?: boolean } = {}): Promise<readonly PIIMatch[]> {
    if (!text.trim()) return []

    const categories = getActiveCategories(getConfiguredCategories(this.config))
    if (categories.length === 0) return []

    const matches: PIIMatch[] = [
      ...detectDictionaryPII(text, categories, [...this.config.dictionary, ...getCustomDictionary(this.config)]),
      ...detectRegexPII(text, categories, getCustomPatterns(this.config)),
    ]

    if (options.useOllama && this.config.ollamaEnabled) {
      matches.push(
        ...(await detectOllamaPII(
          [{ index: 0, text }],
          this.config.ollamaEndpoint,
          this.config.ollamaModel,
          categories,
        )),
      )
    }

    return selectNonOverlappingMatches(matches)
      .filter((match) => !this.allowlist.has(match.text))
      .sort((left, right) => left.start - right.start)
  }

  reset(): void {
    this.mappingTable.clear()
  }

  private registerMaskedMatch(match: PIIMatch): string {
    if (this.allowlist.has(match.text)) return match.text

    const isReversible = this.config.mode !== 'anonymize'
    const customCategory = this.config.customCategories.find((item) => item.name === match.category)
    const placeholder = this.mappingTable.register(
      match.text,
      match.category,
      customCategory?.placeholder ?? customCategory?.label ?? String(match.category),
      isReversible,
    )

    writeAuditLog(this.config.auditLog, {
      timestamp: new Date().toISOString(),
      category: match.category,
      placeholder,
      confidence: match.confidence,
      position: {
        start: match.start,
        end: match.end,
      },
      mode: this.config.mode,
      reviewRequired: match.confidence < this.config.auditLog.reviewThreshold,
    })

    return placeholder
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
        message['content'] = await this.filterContent(message['content'], true)
      }
      filtered.push(message)
    }

    return filtered
  }

  private async filterSystemField(system: unknown): Promise<unknown> {
    if (typeof system === 'string') {
      return this.filterText(system, false)
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
          out['text'] = await this.filterText(out['text'], false)
        }
        filteredBlocks.push(out)
      }
      return filteredBlocks
    }

    return system
  }

  private async filterContent(content: unknown, useOllama: boolean): Promise<unknown> {
    if (typeof content === 'string') return this.filterText(content, useOllama)

    if (!Array.isArray(content)) return content

    const filteredBlocks: unknown[] = []
    for (const block of content) {
      if (!block || typeof block !== 'object') {
        filteredBlocks.push(block)
        continue
      }

      const out = { ...(block as Record<string, unknown>) }

      if (out['type'] === 'text' && typeof out['text'] === 'string') {
        out['text'] = await this.filterText(out['text'], useOllama)
      } else if (out['type'] === 'tool_result') {
        if (typeof out['content'] === 'string') {
          out['content'] = await this.filterText(out['content'], useOllama)
        } else if (Array.isArray(out['content'])) {
          out['content'] = await this.filterContent(out['content'], useOllama)
        }
      } else if (out['type'] === 'tool_use' && 'input' in out) {
        out['input'] = await this.filterInputValue(out['input'], useOllama)
      }

      filteredBlocks.push(out)
    }

    return filteredBlocks
  }

  private async filterInputValue(value: unknown, useOllama: boolean): Promise<unknown> {
    if (typeof value === 'string') return this.filterText(value, useOllama)

    if (Array.isArray(value)) {
      const output: unknown[] = []
      for (const item of value) {
        output.push(await this.filterInputValue(item, useOllama))
      }
      return output
    }

    if (value && typeof value === 'object') {
      const output: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        output[key] = await this.filterInputValue(item, useOllama)
      }
      return output
    }

    return value
  }

  private async filterText(text: string, useOllama: boolean): Promise<string> {
    if (!text.trim()) return text

    let filtered = text
    const categories = getActiveCategories(getConfiguredCategories(this.config))
    if (categories.length === 0) return filtered

    const dictionaryMatches = detectDictionaryPII(
      filtered,
      categories,
      [...this.config.dictionary, ...getCustomDictionary(this.config)],
    )
    filtered = applyReplacements(filtered, dictionaryMatches, this.registerMaskedMatch.bind(this))

    const regexMatches = detectRegexPII(filtered, categories, getCustomPatterns(this.config))
    filtered = applyReplacements(filtered, regexMatches, this.registerMaskedMatch.bind(this))

    if (this.config.ollamaEnabled && useOllama) {
      const ollamaMatches = await detectOllamaPII(
        [{ index: 0, text: filtered }],
        this.config.ollamaEndpoint,
        this.config.ollamaModel,
        categories,
      )

      if (ollamaMatches.length > 0) {
        filtered = applyReplacements(filtered, ollamaMatches, this.registerMaskedMatch.bind(this))
      }
    }

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
