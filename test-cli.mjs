import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const projectDir = dirname(fileURLToPath(import.meta.url))
const testDir = mkdtempSync(join(tmpdir(), 'cloakroom-cli-test-'))
const home = join(testDir, 'home')
mkdirSync(home)
const commonBuild = { bundle: true, platform: 'node', target: 'node22', format: 'esm' }
await build({ ...commonBuild, entryPoints: [join(projectDir, 'src/cli.ts')], outfile: join(testDir, 'cli.js') })
await build({
  ...commonBuild,
  entryPoints: [join(projectDir, 'src/server.ts')],
  outfile: join(testDir, 'server.js'),
  // Observe the real server process without requiring platform-specific ps tools.
  banner: { js: 'process.stdout.write(`CLOAKROOM_TEST_SERVER_PID=${process.pid}\\n`);' },
})
// Explicit ESM mode for the temporary bundles, independently of the caller's cwd.
writeFileSync(join(testDir, 'package.json'), '{"type":"module"}\n')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function isAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
async function until(predicate, message) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message)
    await delay(20)
  }
}
function launch(t, port = '0', entry = join(testDir, 'cli.js')) {
  const env = { HOME: home, PII_PROXY_PORT: port, CLAUDE_PII_FILTER: '0' }
  for (const key of ['PATH', 'TMPDIR', 'LANG']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const cli = spawn(process.execPath, [entry, 'start'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let result
  cli.stdout.on('data', (chunk) => { output += chunk })
  cli.stderr.on('data', (chunk) => { output += chunk })
  cli.once('exit', (code, signal) => { result = { code, signal } })
  cli.once('error', (error) => { result = { error } })
  const serverPid = () => Number(output.match(/CLOAKROOM_TEST_SERVER_PID=(\d+)/)?.[1])
  t.after(async () => {
    // Also clean up an orphan from the pre-fix regression failure.
    for (const pid of [serverPid(), cli.pid]) {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL')
    }
    await until(() => result !== undefined, 'test CLI cleanup timed out')
    await until(() => !isAlive(serverPid()), 'test server cleanup timed out')
  })
  return { cli, serverPid, output: () => output, result: () => result }
}
async function ready(proc) {
  await until(() => proc.result() !== undefined || /listening on http:\/\/127\.0\.0\.1:\d+/.test(proc.output()), 'CLI startup timed out')
  assert.equal(proc.result(), undefined, proc.output())
  assert.ok(proc.serverPid(), 'the CLI must spawn the actual server child')
  return Number(proc.output().match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)[1])
}
function health(port) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/health', agent: false }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.setTimeout(1000, () => req.destroy(new Error('health request timed out')))
    req.end()
  })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`CLI forwards parent-only ${signal}, waits for its child, and releases its port`, { skip: process.platform === 'win32' }, async (t) => {
    const proc = launch(t)
    const port = await ready(proc)
    assert.deepEqual(await health(port), { status: 200, body: { status: 'ok' } })
    process.kill(proc.cli.pid, signal)
    await until(() => proc.result() !== undefined, `CLI did not exit after ${signal}`)
    await until(() => !isAlive(proc.serverPid()), `server child ${proc.serverPid()} survived parent-only ${signal}`)
    assert.deepEqual(proc.result(), { code: 0, signal: null })
    assert.equal(isAlive(proc.cli.pid), false)
    await assert.rejects(health(port), { code: 'ECONNREFUSED' })
    t.diagnostic(`parent PID ${proc.cli.pid} and server PID ${proc.serverPid()} exited; port ${port} refuses connections`)
  })
}

test('CLI reports a server startup failure and exits without a child', async (t) => {
  const occupied = createServer()
  await new Promise((resolve, reject) => {
    occupied.once('error', reject)
    occupied.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => occupied.close(resolve)))
  const proc = launch(t, String(occupied.address().port))
  await until(() => proc.result() !== undefined, 'CLI did not report startup failure')
  assert.deepEqual(proc.result(), { code: 1, signal: null })
  assert.match(proc.output(), /EADDRINUSE/)
  await until(() => !isAlive(proc.serverPid()), 'failed server child remains alive')
  t.diagnostic(`startup failure: parent PID ${proc.cli.pid} and server PID ${proc.serverPid()} exited`)
})

test('CLI propagates a missing server entry point failure', async (t) => {
  const missingDir = join(testDir, 'missing-server')
  mkdirSync(missingDir)
  await build({ ...commonBuild, entryPoints: [join(projectDir, 'src/cli.ts')], outfile: join(missingDir, 'cli.js') })
  const proc = launch(t, '0', join(missingDir, 'cli.js'))
  await until(() => proc.result() !== undefined, 'CLI did not report missing server')
  assert.deepEqual(proc.result(), { code: 1, signal: null })
  assert.match(proc.output(), /MODULE_NOT_FOUND/)
})
