import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PIIFilter } from './piiFilter.js'
import { DEFAULT_CONFIG } from './types.js'

const DEFAULT_PROXY_URL = 'http://127.0.0.1:8787'
const CLAUDE_DIR = join(homedir(), '.claude')
const CONFIG_PATH = join(CLAUDE_DIR, 'pii-filter.json')
const CLAUDE_SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json')
const CLAUDE_SETTINGS_BACKUP_PATH = join(CLAUDE_DIR, 'cloakroom-settings-backup.json')
const HERMES_ENV_PATH = join(homedir(), '.hermes', '.env')

type CommandContext = {
  readonly args: readonly string[]
}

function printHelp(): void {
  process.stdout.write(`cloakroom

Usage:
  cloakroom start
  cloakroom init [--force]
  cloakroom install --for=claude-code|hermes-agent
  cloakroom uninstall --for=claude-code
  cloakroom status
  cloakroom doctor
  cloakroom test

Commands:
  start      Start the local PII proxy
  init       Create ~/.claude/pii-filter.json
  install    Write proxy environment settings for Claude Code or Hermes Agent
  uninstall  Restore Claude Code settings saved by install
  status     Show proxy health and runtime filter status
  doctor     Check Claude Code settings and proxy health
  test       Run a local sample through the filter
`)
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag)
}

function getOption(args: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)

  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1]

  return undefined
}

function ensureClaudeDir(): void {
  mkdirSync(CLAUDE_DIR, { recursive: true })
}

function writeDefaultConfig(force: boolean): void {
  ensureClaudeDir()

  if (existsSync(CONFIG_PATH) && !force) {
    process.stdout.write(`Config already exists: ${CONFIG_PATH}\n`)
    process.stdout.write('Use --force to overwrite it.\n')
    return
  }

  writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`)
  process.stdout.write(`Created config: ${CONFIG_PATH}\n`)
}

function upsertEnvLine(contents: string, key: string, value: string): string {
  const line = `${key}=${value}`
  const lines = contents.split(/\r?\n/)
  const index = lines.findIndex((item) => item.startsWith(`${key}=`))

  if (index >= 0) {
    lines[index] = line
    return lines.filter((item, itemIndex) => item || itemIndex < lines.length - 1).join('\n')
  }

  const trimmed = contents.trimEnd()
  return `${trimmed}${trimmed ? '\n' : ''}${line}\n`
}

function installProxyEnvironment(ctx: CommandContext): void {
  const target = getOption(ctx.args, '--for')
  const proxyUrl = process.env['PII_PROXY_URL'] ?? DEFAULT_PROXY_URL

  if (target === 'claude-code') {
    installClaudeCodeSettings(proxyUrl)
  } else if (target === 'hermes-agent') {
    mkdirSync(dirname(HERMES_ENV_PATH), { recursive: true })
    const existing = existsSync(HERMES_ENV_PATH) ? readFileSync(HERMES_ENV_PATH, 'utf8') : ''
    writeFileSync(HERMES_ENV_PATH, upsertEnvLine(existing, 'OPENAI_BASE_URL', `${proxyUrl}/v1`))
    process.stdout.write(`Updated Hermes Agent env: ${HERMES_ENV_PATH}\n`)
  } else {
    throw new Error('install supports --for=claude-code or --for=hermes-agent')
  }

  process.stdout.write(`Proxy URL: ${proxyUrl}\n`)
}

type SavedEnvironmentValue = { readonly existed: boolean; readonly value?: unknown }
type ClaudeSettingsBackup = {
  readonly version: 1
  readonly hadEnv: boolean
  readonly original: Record<string, SavedEnvironmentValue>
  readonly installed: Record<string, string>
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${path}`)
  }
  return parsed as Record<string, unknown>
}

function writeJsonAtomically(path: string, value: unknown): void {
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporaryPath, path)
}

function getClaudeProxySettings(proxyUrl: string): Record<string, string> {
  const baseUrl = proxyUrl.replace(/\/+$/u, '')
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    OPENAI_BASE_URL: `${baseUrl}/v1`,
  }
}

function installClaudeCodeSettings(proxyUrl: string): void {
  ensureClaudeDir()
  const settings = readJsonObject(CLAUDE_SETTINGS_PATH)
  const existingEnv = settings['env']
  if (existingEnv !== undefined && (!existingEnv || typeof existingEnv !== 'object' || Array.isArray(existingEnv))) {
    throw new Error(`Expected "env" to be an object in ${CLAUDE_SETTINGS_PATH}`)
  }

  const env = { ...((existingEnv ?? {}) as Record<string, unknown>) }
  const installed = getClaudeProxySettings(proxyUrl)
  let backup: ClaudeSettingsBackup
  if (existsSync(CLAUDE_SETTINGS_BACKUP_PATH)) {
    const parsed = readJsonObject(CLAUDE_SETTINGS_BACKUP_PATH) as unknown as ClaudeSettingsBackup
    if (parsed.version !== 1 || !parsed.original) {
      throw new Error(`Invalid Cloakroom settings backup: ${CLAUDE_SETTINGS_BACKUP_PATH}`)
    }
    backup = { ...parsed, installed }
  } else {
    const original: Record<string, SavedEnvironmentValue> = {}
    for (const key of Object.keys(installed)) {
      original[key] = Object.hasOwn(env, key)
        ? { existed: true, value: env[key] }
        : { existed: false }
    }
    backup = {
      version: 1,
      hadEnv: existingEnv !== undefined,
      original,
      installed,
    }
  }

  writeJsonAtomically(CLAUDE_SETTINGS_BACKUP_PATH, backup)
  writeJsonAtomically(CLAUDE_SETTINGS_PATH, { ...settings, env: { ...env, ...installed } })
  process.stdout.write(`Updated Claude Code settings: ${CLAUDE_SETTINGS_PATH}\n`)
}

function uninstallClaudeCodeSettings(): void {
  if (!existsSync(CLAUDE_SETTINGS_BACKUP_PATH)) {
    process.stdout.write('Cloakroom settings backup not found; nothing to restore.\n')
    return
  }

  const backup = readJsonObject(CLAUDE_SETTINGS_BACKUP_PATH) as unknown as ClaudeSettingsBackup
  const settings = readJsonObject(CLAUDE_SETTINGS_PATH)
  const existingEnv = settings['env']
  if (existingEnv !== undefined && (!existingEnv || typeof existingEnv !== 'object' || Array.isArray(existingEnv))) {
    throw new Error(`Expected "env" to be an object in ${CLAUDE_SETTINGS_PATH}`)
  }

  const env = { ...((existingEnv ?? {}) as Record<string, unknown>) }
  const preserved: string[] = []
  for (const [key, original] of Object.entries(backup.original)) {
    if (env[key] !== backup.installed[key]) {
      preserved.push(key)
      continue
    }
    if (original.existed) env[key] = original.value
    else delete env[key]
  }

  const nextSettings = { ...settings }
  if (!backup.hadEnv && Object.keys(env).length === 0) delete nextSettings['env']
  else nextSettings['env'] = env
  writeJsonAtomically(CLAUDE_SETTINGS_PATH, nextSettings)
  unlinkSync(CLAUDE_SETTINGS_BACKUP_PATH)
  process.stdout.write(`Restored Claude Code settings: ${CLAUDE_SETTINGS_PATH}\n`)
  if (preserved.length > 0) {
    process.stdout.write(`Kept values changed after install: ${preserved.join(', ')}\n`)
  }
}

async function runDoctor(): Promise<void> {
  const proxyUrl = (process.env['PII_PROXY_URL'] ?? DEFAULT_PROXY_URL).replace(/\/+$/u, '')
  const expected = getClaudeProxySettings(proxyUrl)
  let settingsOkay = false
  try {
    const settings = readJsonObject(CLAUDE_SETTINGS_PATH)
    const env = settings['env'] as Record<string, unknown> | undefined
    settingsOkay = Object.entries(expected).every(([key, value]) => env?.[key] === value)
  } catch {
    settingsOkay = false
  }

  let proxyOkay = false
  try {
    const response = await fetch(`${proxyUrl}/health`, { signal: AbortSignal.timeout(3000) })
    proxyOkay = response.ok && (await response.json()).status === 'ok'
  } catch {
    proxyOkay = false
  }

  process.stdout.write(`${JSON.stringify({ settingsOkay, proxyOkay, proxyUrl }, null, 2)}\n`)
  if (!settingsOkay || !proxyOkay) process.exitCode = 1
}

async function printStatus(): Promise<void> {
  const proxyUrl = process.env['PII_PROXY_URL'] ?? DEFAULT_PROXY_URL

  try {
    const [healthRes, controlRes] = await Promise.all([
      fetch(`${proxyUrl}/health`),
      fetch(`${proxyUrl}/control/status`),
    ])

    const health = await healthRes.json()
    const control = await controlRes.json()

    process.stdout.write(
      `${JSON.stringify(
        {
          proxyUrl,
          health,
          control,
        },
        null,
        2,
      )}\n`,
    )
  } catch {
    process.stdout.write(`Proxy is not reachable at ${proxyUrl}\n`)
    process.exitCode = 1
  }
}

async function runFilterSample(): Promise<void> {
  const filter = new PIIFilter({ ...DEFAULT_CONFIG, ollamaEnabled: false })
  const input = {
    messages: [
      {
        role: 'user',
        content: '連絡先は yamada.taro@example.com、電話は 09011112222 です。',
      },
    ],
  }

  const filtered = await filter.filterRequestBody(input)
  process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`)
}

function startServer(): void {
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), 'server.js')
  const child = spawn(process.execPath, [serverPath], {
    env: process.env,
    stdio: 'inherit',
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.exit(signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1)
      return
    }
    process.exit(code ?? 0)
  })
}

async function main(): Promise<void> {
  const [command = 'start', ...args] = process.argv.slice(2)
  const ctx = { args }

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return
  }

  if (command === 'start') {
    startServer()
    return
  }

  if (command === 'init') {
    writeDefaultConfig(hasFlag(args, '--force'))
    return
  }

  if (command === 'install') {
    installProxyEnvironment(ctx)
    return
  }

  if (command === 'uninstall') {
    const target = getOption(args, '--for')
    if (target !== 'claude-code') throw new Error('uninstall supports --for=claude-code')
    uninstallClaudeCodeSettings()
    return
  }

  if (command === 'status') {
    await printStatus()
    return
  }

  if (command === 'doctor') {
    await runDoctor()
    return
  }

  if (command === 'test') {
    await runFilterSample()
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
