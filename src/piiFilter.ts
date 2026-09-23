import { loadPIIConfig } from './config.js'
import { getActiveCategories, isPassthroughEnabled } from './controlState.js'
import { writeAuditLog } from './auditLog.js'
import { encodeWithFpe, scanAndRestoreFpe } from './fpeCodec.js'
import { incDetectionsByCategory, incRestoredPlaceholders } from './stats.js'
import { createFakeValue } from './fakeData.js'
import { detectHeuristicPII } from './heuristicNer.js'
import { deriveKey, loadOrCreateKey } from './keys.js'
import { MappingTable, toAlphabeticSequence } from './mappingTable.js'
import { detectOllamaPII } from './ollamaFilter.js'
import { OpenAIStreamRestorer } from './openaiStreamRestorer.js'
import { detectPluginPII, loadFilterPlugins } from './pluginLoader.js'
import {
  applyReplacements,
  detectDictionaryPII,
  detectRegexPII,
  selectNonOverlappingMatches,
} from './regexFilter.js'
import { StreamRestorer } from './streamRestorer.js'
import {
  CATEGORY_LABELS,
  type CategoryOption,
  type CustomPatternEntry,
  type DictionaryEntry,
  type EmailPreserveLevel,
  type PIICategory,
  type PIIFilterConfig,
  type PIIMatch,
} from './types.js'

function extractContext(text: string, category: PIICategory, option: CategoryOption): string | undefined {
  if (category === 'EMAIL') {
    const emailOption = option as { preserve: EmailPreserveLevel }
    const atIndex = text.indexOf('@')
    if (atIndex === -1) return undefined
    const domain = text.slice(atIndex + 1)
    if (emailOption.preserve === 'domain') return `@${domain}`
    if (emailOption.preserve === 'tld') {
      const parts = domain.split('.')
      if (parts.length >= 3) {
        const secondToLast = parts[parts.length - 2]
        if (secondToLast && secondToLast.length <= 3) {
          return `@.${parts.slice(-2).join('.')}`
        }
      }
      return `@.${parts[parts.length - 1]}`
    }
  }
  if (category === 'ADDRESS') {
    const addrOption = option as { preserve: 'prefecture' | 'none' }
    if (addrOption.preserve === 'prefecture') {
      const m = text.match(/^(北海道|東京都|大阪府|京都府|.{2,3}[都道府県])/)
      if (m) return `(${m[1]})`
    }
  }
  if (category === 'DATE_TIME') {
    const dateOption = option as { preserve: 'decade' | 'year' | 'none' }
    const yearMatch = text.match(/(\d{4})/)
    if (yearMatch) {
      const year = Number.parseInt(yearMatch[1], 10)
      if (dateOption.preserve === 'decade') return `(${Math.floor(year / 10) * 10}年代)`
      if (dateOption.preserve === 'year') return `(${year}年)`
    }
  }
  return undefined
}

export class BlockedByPolicyError extends Error {
  constructor(readonly categories: readonly PIICategory[]) {
    super(`Request blocked: ${categories.join(', ')}`)
    this.name = 'BlockedByPolicyError'
  }
}

export class UnsupportedContentError extends Error {
  constructor() {
    super('This request contains non-text content and is blocked by policy')
    this.name = 'UnsupportedContentError'
  }
}

const NON_TEXT_BLOCK_TYPES = new Set([
  'image',
  'image_url',
  'document',
  'input_image',
  'input_audio',
  'input_file',
  'input_video',
  'audio',
  'audio_url',
  'video',
  'video_url',
])
const STRUCTURAL_INPUT_KEYS = new Set(['type', 'role', 'id', 'call_id', 'item_id', 'status', 'name'])

const PLACEHOLDER_INSTRUCTION_MARKER = 'Cloakroom placeholder'

function isNonTextBlockType(value: unknown): boolean {
  return typeof value === 'string' && NON_TEXT_BLOCK_TYPES.has(value)
}

function collectRequestText(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value)
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) collectRequestText(item, output)
    return
  }

  if (!value || typeof value !== 'object') return

  const record = value as Record<string, unknown>
  if (isNonTextBlockType(record['type'])) return
  for (const item of Object.values(record)) collectRequestText(item, output)
}

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

const HEURISTIC_NER_CATEGORIES = new Set(['NAME', 'ORG', 'SCHOOL'])

function wantsHeuristicNer(config: PIIFilterConfig, categories: readonly PIICategory[]): boolean {
  return config.heuristicNerEnabled && categories.some((category) => HEURISTIC_NER_CATEGORIES.has(category))
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
  private readonly mappingTable: MappingTable
  private config: PIIFilterConfig
  private allowlist: ReadonlySet<string>
  private readonly blockedCategories: Set<PIICategory> = new Set()
  private readonly fpeKey: Buffer

  constructor(config = loadPIIConfig(), mappingTable?: MappingTable) {
    this.config = config
    this.allowlist = new Set(config.allowlist)
    this.mappingTable = mappingTable ?? new MappingTable()
    this.fpeKey = deriveKey(loadOrCreateKey(), 'cloakroom-fpe-v1')
  }

  getMappingTable(): MappingTable {
    return this.mappingTable
  }

  isEnabled(): boolean {
    return this.config.enabled && !isPassthroughEnabled()
  }

  updateConfig(config: PIIFilterConfig): void {
    // Keep the mapping table so placeholders issued before a reload restore.
    this.config = config
    this.allowlist = new Set(config.allowlist)
  }

  createStreamRestorer(): StreamRestorer {
    const fpeEnabled = this.config.fpe?.enabled
    const fpeKey = this.fpeKey
    return new StreamRestorer(
      this.mappingTable,
      fpeEnabled ? (text) => scanAndRestoreFpe(text, fpeKey) : undefined,
    )
  }

  createOpenAIStreamRestorer(): OpenAIStreamRestorer {
    const fpeEnabled = this.config.fpe?.enabled
    const fpeKey = this.fpeKey
    return new OpenAIStreamRestorer(
      this.mappingTable,
      fpeEnabled ? (text) => scanAndRestoreFpe(text, fpeKey) : undefined,
    )
  }

  async filterRequestBody(requestBody: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.isEnabled()) return requestBody

    this.blockedCategories.clear()

    const cloned = structuredClone(requestBody)
    const collisionTexts: string[] = []
    if (this.config.mode === 'fake') collectRequestText(cloned, collisionTexts)

    if ('system' in cloned) {
      cloned['system'] = await this.filterSystemField(cloned['system'], collisionTexts)
    }

    if (Array.isArray(cloned['messages'])) {
      cloned['messages'] = await this.filterMessages(cloned['messages'] as readonly unknown[], collisionTexts)
    }

    if ('instructions' in cloned) {
      cloned['instructions'] = await this.filterInputValue(cloned['instructions'], false, collisionTexts)
    }

    if ('input' in cloned) {
      cloned['input'] = await this.filterInputValue(cloned['input'], true, collisionTexts)
    }

    if (
      this.config.placeholderInstructionEnabled &&
      this.config.mode !== 'fake' &&
      this.mappingTable.hasMappings()
    ) {
      this.addPlaceholderInstruction(cloned)
    }

    if (this.blockedCategories.size > 0) {
      const categories = [...this.blockedCategories]
      this.blockedCategories.clear()
      throw new BlockedByPolicyError(categories)
    }

    return cloned
  }

  restoreText(text: string): string {
    if (this.config.mode === 'anonymize') return text
    const restored = this.mappingTable.replaceAllPlaceholders(text)
    if (restored !== text) {
      // Count how many placeholders were substituted by checking the difference
      const placeholderPattern = /(?:\[[^\]\r\n]{1,256}\]|<pii:[^>\r\n]{1,256}\/?>)/giu
      const before = (text.match(placeholderPattern) ?? []).length
      const after = (restored.match(placeholderPattern) ?? []).length
      const resolved = before - after
      if (resolved > 0) incRestoredPlaceholders(resolved)
    }
    // FPE restoration pass: scan for encoded digit tokens and decode them
    if (this.config.fpe?.enabled) {
      return scanAndRestoreFpe(restored, this.fpeKey)
    }
    return restored
  }

  restoreResponseBody<T>(payload: T): T {
    if (!this.isEnabled()) return payload
    if (this.config.mode === 'anonymize') return payload
    return this.restoreRecursive(payload) as T
  }

  async analyzeText(text: string, options: { readonly useOllama?: boolean } = {}): Promise<readonly PIIMatch[]> {
    if (!text.trim()) return []

    const categories = getActiveCategories(getConfiguredCategories(this.config))
    const plugins = await loadFilterPlugins(this.config.plugins)
    if (categories.length === 0 && plugins.length === 0) return []

    const matches: PIIMatch[] = []
    if (categories.length > 0) {
      matches.push(
        ...detectDictionaryPII(text, categories, [...this.config.dictionary, ...getCustomDictionary(this.config)]),
        ...detectRegexPII(text, categories, getCustomPatterns(this.config)),
      )

      if (wantsHeuristicNer(this.config, categories)) {
        matches.push(...detectHeuristicPII(text, categories))
      }
    }

    matches.push(...(await detectPluginPII(text, plugins)))

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

  async filterResponseBody(responseText: string): Promise<{ detectedCategories: PIICategory[] }> {
    if (!this.config.responseDetection?.enabled) {
      return { detectedCategories: [] }
    }

    const matches = await this.analyzeText(responseText)
    if (matches.length === 0) {
      return { detectedCategories: [] }
    }

    for (const match of matches) {
      writeAuditLog(this.config.auditLog, {
        timestamp: new Date().toISOString(),
        category: match.category,
        confidence: match.confidence,
        position: { start: match.start, end: match.end },
        mode: this.config.mode,
        reviewRequired: match.confidence < this.config.auditLog.reviewThreshold,
      })
    }

    const detectedCategories = [...new Set(matches.map((m) => m.category))]
    return { detectedCategories }
  }

  reset(): void {
    this.mappingTable.clear()
  }

  private addPlaceholderInstruction(body: Record<string, unknown>): void {
    const legacy = this.config.placeholderFormat === 'legacy'
    const example = legacy ? '[EMAIL_A]' : '<pii:email id="1"/>'
    const instruction = `${PLACEHOLDER_INSTRUCTION_MARKER} ${example} represents a masked value. Keep it unchanged; do not translate, expand, or remove it.`
    const alreadyIncluded = (value: unknown): boolean => {
      if (typeof value === 'string') return value.includes(PLACEHOLDER_INSTRUCTION_MARKER)
      if (Array.isArray(value)) return value.some((item) => alreadyIncluded(item))
      if (value && typeof value === 'object') {
        return Object.values(value as Record<string, unknown>).some((item) => alreadyIncluded(item))
      }
      return false
    }
    const append = (value: unknown): string => {
      const current = typeof value === 'string' ? value : ''
      return current.includes(PLACEHOLDER_INSTRUCTION_MARKER)
        ? current
        : `${current}${current ? '\n' : ''}${instruction}`
    }

    if ('system' in body) {
      if (!alreadyIncluded(body['system'])) {
        if (typeof body['system'] === 'string') {
          body['system'] = append(body['system'])
        } else if (Array.isArray(body['system'])) {
          body['system'] = [...body['system'], { type: 'text', text: instruction }]
        }
      }
      return
    }

    if ('instructions' in body) {
      const instructions = body['instructions']
      if (typeof instructions === 'string') {
        body['instructions'] = append(instructions)
      } else if (instructions == null) {
        body['instructions'] = instruction
      }
      return
    }

    const messages = body['messages']
    if (!Array.isArray(messages) || alreadyIncluded(messages)) return

    const insertionIndex = messages.findIndex((message) => {
      if (!message || typeof message !== 'object') return true
      const role = (message as Record<string, unknown>)['role']
      return role !== 'system' && role !== 'developer'
    })
    const systemMessage = { role: 'system', content: instruction }
    const index = insertionIndex === -1 ? messages.length : insertionIndex
    body['messages'] = [...messages.slice(0, index), systemMessage, ...messages.slice(index)]
  }

  private registerMaskedMatch(match: PIIMatch, collisionTexts: readonly string[]): string {
    if (this.allowlist.has(match.text)) return match.text

    const action = this.config.categoryActions?.[match.category] ?? 'mask'

    if (action === 'warn') {
      writeAuditLog(this.config.auditLog, {
        timestamp: new Date().toISOString(),
        category: match.category,
        confidence: match.confidence,
        position: { start: match.start, end: match.end },
        mode: this.config.mode,
        reviewRequired: match.confidence < this.config.auditLog.reviewThreshold,
      })
      return match.text
    }

    if (action === 'block') {
      this.blockedCategories.add(match.category)
    }

    // Fake values can match the normal regexes on later turns. Preserve a
    // previously issued value instead of assigning it a second replacement.
    if (this.config.mode === 'fake' && this.mappingTable.resolve(match.text)) {
      return match.text
    }

    // FPE path: stateless reversible masking for numeric categories
    const fpeCategories: readonly string[] = this.config.fpe?.categories ?? ['PHONE', 'CREDIT_CARD', 'MY_NUMBER']
    if (this.config.fpe?.enabled && fpeCategories.includes(match.category)) {
      const digits = match.text.replace(/\D/g, '')
      if (digits.length >= 6) {
        const { encoded, mac } = encodeWithFpe(match.category, digits, this.fpeKey)
        const placeholder = encoded + mac
        incDetectionsByCategory(match.category)
        writeAuditLog(this.config.auditLog, {
          timestamp: new Date().toISOString(),
          category: match.category,
          placeholder,
          confidence: match.confidence,
          position: { start: match.start, end: match.end },
          mode: this.config.mode,
          reviewRequired: match.confidence < this.config.auditLog.reviewThreshold,
        })
        return placeholder
      }
    }

    const isReversible = this.config.mode !== 'anonymize'
    const customCategory = this.config.customCategories.find((item) => item.name === match.category)
    const baseLabel =
      customCategory?.placeholder ??
      customCategory?.label ??
      CATEGORY_LABELS[match.category as keyof typeof CATEGORY_LABELS] ??
      String(match.category)

    const categoryOption = this.config.categoryOptions?.[match.category]
    const context = categoryOption ? extractContext(match.text, match.category, categoryOption) : undefined
    const placeholderFormat = this.config.placeholderFormat ?? 'legacy'

    let createReplacement: ((count: number) => string) | undefined
    if (this.config.mode === 'fake') {
      createReplacement = (count) => this.createUniqueFakeValue(match.category, count, collisionTexts)
    } else if (context !== undefined && placeholderFormat === 'legacy') {
      createReplacement = (count) => `[${baseLabel}${toAlphabeticSequence(count)}${context}]`
    }

    const placeholder = this.mappingTable.register(
      match.text,
      match.category,
      baseLabel,
      isReversible,
      createReplacement,
      placeholderFormat,
      placeholderFormat === 'xml' ? context : undefined,
    )

    incDetectionsByCategory(match.category)

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

  private createUniqueFakeValue(category: PIICategory, count: number, collisionTexts: readonly string[]): string {
    let candidateNumber = count
    let value = createFakeValue(category, candidateNumber)

    while (collisionTexts.some((text) => text.includes(value)) || this.mappingTable.hasReplacement(value)) {
      candidateNumber += 1
      value = createFakeValue(category, candidateNumber)
    }

    return value
  }

  private async filterMessages(messages: readonly unknown[], collisionTexts: readonly string[]): Promise<unknown[]> {
    const filtered: unknown[] = []

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') {
        filtered.push(msg)
        continue
      }

      const message = { ...(msg as Record<string, unknown>) }
      if ('content' in message) {
        message['content'] = await this.filterContent(message['content'], true, collisionTexts)
      }
      filtered.push(message)
    }

    return filtered
  }

  private async filterSystemField(system: unknown, collisionTexts: readonly string[]): Promise<unknown> {
    if (typeof system === 'string') {
      return this.filterText(system, false, collisionTexts)
    }

    if (Array.isArray(system)) {
      const filteredBlocks: unknown[] = []
      for (const block of system) {
        if (!block || typeof block !== 'object') {
          filteredBlocks.push(block)
          continue
        }

        const out = { ...(block as Record<string, unknown>) }
        if (isNonTextBlockType(out['type'])) {
          this.rejectNonTextIfConfigured()
          filteredBlocks.push(out)
          continue
        }
        if (out['type'] === 'text' && typeof out['text'] === 'string') {
          out['text'] = await this.filterText(out['text'], false, collisionTexts)
        }
        filteredBlocks.push(out)
      }
      return filteredBlocks
    }

    return system
  }

  private async filterContent(
    content: unknown,
    useOllama: boolean,
    collisionTexts: readonly string[],
  ): Promise<unknown> {
    if (typeof content === 'string') return this.filterText(content, useOllama, collisionTexts)

    if (!Array.isArray(content)) return content

    const filteredBlocks: unknown[] = []
    for (const block of content) {
      if (!block || typeof block !== 'object') {
        filteredBlocks.push(block)
        continue
      }

      const out = { ...(block as Record<string, unknown>) }
      if (isNonTextBlockType(out['type'])) {
        this.rejectNonTextIfConfigured()
        filteredBlocks.push(out)
        continue
      }

      if ((out['type'] === 'text' || out['type'] === 'input_text' || out['type'] === 'output_text') && typeof out['text'] === 'string') {
        out['text'] = await this.filterText(out['text'], useOllama, collisionTexts)
      } else if (out['type'] === 'tool_result') {
        if (typeof out['content'] === 'string') {
          out['content'] = await this.filterText(out['content'], useOllama, collisionTexts)
        } else if (Array.isArray(out['content'])) {
          out['content'] = await this.filterContent(out['content'], useOllama, collisionTexts)
        }
      } else if (out['type'] === 'tool_use' && 'input' in out) {
        out['input'] = await this.filterInputValue(out['input'], useOllama, collisionTexts)
      } else if (out['type'] === 'thinking' || out['type'] === 'redacted_thinking') {
        // These blocks can be signed by the provider. Keep placeholders as-is
        // so a client may safely send the block back without breaking a signature.
      }

      filteredBlocks.push(out)
    }

    return filteredBlocks
  }

  private async filterInputValue(
    value: unknown,
    useOllama: boolean,
    collisionTexts: readonly string[],
  ): Promise<unknown> {
    if (typeof value === 'string') return this.filterText(value, useOllama, collisionTexts)

    if (Array.isArray(value)) {
      const output: unknown[] = []
      for (const item of value) {
        output.push(await this.filterInputValue(item, useOllama, collisionTexts))
      }
      return output
    }

    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (isNonTextBlockType(record['type'])) {
        this.rejectNonTextIfConfigured()
        return value
      }

      const output: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(record)) {
        if (typeof record['type'] === 'string' && STRUCTURAL_INPUT_KEYS.has(key)) {
          output[key] = item
          continue
        }
        output[key] = await this.filterInputValue(item, useOllama, collisionTexts)
      }
      return output
    }

    return value
  }

  private rejectNonTextIfConfigured(): void {
    if (this.config.blockNonText) throw new UnsupportedContentError()
  }

  private async filterText(
    text: string,
    useOllama: boolean,
    collisionTexts: readonly string[],
  ): Promise<string> {
    if (!text.trim()) return text

    let filtered = text
    const categories = getActiveCategories(getConfiguredCategories(this.config))
    const plugins = await loadFilterPlugins(this.config.plugins)
    if (categories.length === 0 && plugins.length === 0) return filtered

    if (categories.length > 0) {
      const dictionaryMatches = detectDictionaryPII(
        filtered,
        categories,
        [...this.config.dictionary, ...getCustomDictionary(this.config)],
      )
      filtered = applyReplacements(filtered, dictionaryMatches, (match) => this.registerMaskedMatch(match, collisionTexts))

      const regexMatches = detectRegexPII(filtered, categories, getCustomPatterns(this.config))
      filtered = applyReplacements(filtered, regexMatches, (match) => this.registerMaskedMatch(match, collisionTexts))

      if (wantsHeuristicNer(this.config, categories)) {
        const heuristicMatches = detectHeuristicPII(filtered, categories)
        filtered = applyReplacements(filtered, heuristicMatches, (match) => this.registerMaskedMatch(match, collisionTexts))
      }
    }

    const pluginMatches = await detectPluginPII(filtered, plugins)
    filtered = applyReplacements(filtered, pluginMatches, (match) => this.registerMaskedMatch(match, collisionTexts))

    if (this.config.ollamaEnabled && useOllama) {
      const ollamaMatches = await detectOllamaPII(
        [{ index: 0, text: filtered }],
        this.config.ollamaEndpoint,
        this.config.ollamaModel,
        categories,
      )

      if (ollamaMatches.length > 0) {
        filtered = applyReplacements(filtered, ollamaMatches, (match) => this.registerMaskedMatch(match, collisionTexts))
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
      const record = value as Record<string, unknown>
      if (record['type'] === 'thinking' || record['type'] === 'redacted_thinking') {
        // Do not reintroduce PII into provider-signed reasoning blocks.
        return { ...record }
      }

      const output: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(record)) {
        output[key] = this.restoreRecursive(item)
      }
      return output
    }

    return value
  }
}
