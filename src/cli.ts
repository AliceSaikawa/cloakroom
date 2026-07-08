import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PIIFilter } from './piiFilter.js'
import { DEFAULT_CONFIG } from './types.js'

const DEFAULT_PROXY_URL = 'http://127.0.0.1:8787'
const CLAUDE_DIR = join(homedir(), '.claude')
const CONFIG_PATH = join(CLAUDE_DIR, 'pii-filter.json')
const CLAUDE_ENV_PATH = join(CLAUDE_DIR, '.env')

type CommandContext = {
  readonly args: readonly string[]
}

function printHelp(): void {
  process.stdout.write(`cloakroom

Usage:
  cloakroom start
  cloakroom init [--yes] [--force]
  cloakroom install --for=claude-code
  cloakroom status
  cloakroom test

Commands:
  start      Start the local PII proxy
  init       Create ~/.claude/pii-filter.json
  install    Write Claude Code proxy environment settings
  status     Show proxy health and runtime filter status
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

function installForClaudeCode(ctx: CommandContext): void {
  const target = getOption(ctx.args, '--for')
  if (target !== 'claude-code') {
    throw new Error('install currently supports only --for=claude-code')
  }

  ensureClaudeDir()
  const proxyUrl = process.env['PII_PROXY_URL'] ?? DEFAULT_PROXY_URL
  const existing = existsSync(CLAUDE_ENV_PATH) ? readFileSync(CLAUDE_ENV_PATH, 'utf8') : ''
  let updated = upsertEnvLine(existing, 'ANTHROPIC_BASE_URL', proxyUrl)
  updated = upsertEnvLine(updated, 'OPENAI_BASE_URL', `${proxyUrl}/v1`)
  writeFileSync(CLAUDE_ENV_PATH, updated)

  process.stdout.write(`Updated Claude Code env: ${CLAUDE_ENV_PATH}\n`)
  process.stdout.write(`Proxy URL: ${proxyUrl}\n`)
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
  const filter = new PIIFilter(DEFAULT_CONFIG)
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
    installForClaudeCode(ctx)
    return
  }

  if (command === 'status') {
    await printStatus()
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
