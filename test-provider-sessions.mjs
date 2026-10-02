import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { Agent, createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const projectDir = process.env.CLOAKROOM_TEST_REPO ?? dirname(fileURLToPath(import.meta.url))
const testHome = mkdtempSync(join(tmpdir(), 'cloakroom-provider-sessions-'))
const configDir = join(testHome, '.claude')
const configPath = join(configDir, 'pii-filter.json')
mkdirSync(configDir)

// Preserve the real JSON parser, config cache, filter and store. Only redirect
// homedir so configuration and the synthetic master key never touch real files.
const bundle = await build({
  stdin: {
    contents: [
      "export { createProxyServer } from './src/server/app.ts';",
      "export { loadPIIConfig, resetPIIConfigCache } from './src/core/config.ts';",
      "export { resetControlState } from './src/core/controlState.ts';",
      "export { resetStats } from './src/core/stats.ts';",
    ].join('\n'),
    resolveDir: projectDir, loader: 'ts',
  },
  bundle: true, platform: 'node', target: 'node22', format: 'esm', write: false,
  plugins: [{
    name: 'test-homedir-only',
    setup(builder) {
      builder.onResolve({ filter: /^node:os$/ }, () => ({ path: 'test-os', namespace: 'test-os' }))
      builder.onLoad({ filter: /.*/, namespace: 'test-os' }, () => ({
        contents: `export const homedir = () => ${JSON.stringify(testHome)};`, loader: 'js',
      }))
    },
  }],
})
const { createProxyServer, loadPIIConfig, resetPIIConfigCache, resetControlState, resetStats } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))

after(() => {
  resetPIIConfigCache()
  for (const path of [configPath, join(configDir, 'cloakroom-key')]) {
    if (existsSync(path)) unlinkSync(path)
  }
  rmdirSync(configDir)
  rmdirSync(testHome)
})

const baseConfig = {
  enabled: true, categories: ['EMAIL', 'IP_ADDRESS'], mode: 'pseudonymize',
  ollamaEnabled: false, heuristicNerEnabled: false,
  customPatterns: [], customCategories: [], dictionary: [], allowlist: [], plugins: [],
  categoryActions: {}, categoryOptions: {}, providerOverrides: {},
  auditLog: { enabled: false }, responseDetection: { enabled: false },
  vaultEnabled: false, fpe: { enabled: false },
}
const emailA = 'fictional.alpha@example.test'
const emailB = 'fictional.beta@example.test'
const ip = '203.0.113.42'
const providers = [
  { kind: 'anthropic', path: '/v1/messages', response: (text) => ({ content: [{ type: 'text', text }] }), text: (body) => body.content[0].text },
  { kind: 'openai', path: '/v1/chat/completions', response: (text) => ({ choices: [{ index: 0, message: { role: 'assistant', content: text } }] }), text: (body) => body.choices[0].message.content },
]
const writeConfig = (config) => writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
async function closeServer(server) {
  const closing = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  server.closeAllConnections()
  await closing
}
async function until(predicate, message) {
  const deadline = Date.now() + 1200
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function fixture(t, config = baseConfig) {
  writeConfig(config)
  resetPIIConfigCache()
  resetControlState()
  resetStats()
  const calls = []
  const agents = new Set()
  const sockets = new Set()
  const clients = new Set()
  const outgoing = new Set()
  const upstreamAgent = new Agent({ keepAlive: true, maxSockets: 1 })
  const agent = () => {
    const created = new Agent({ keepAlive: true, maxSockets: 1 })
    agents.add(created)
    return created
  }
  const defaultAgent = agent()
  const captureSocket = (server) => server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const mock = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const provider = providers.find((candidate) => candidate.path === req.url)
    assert.ok(provider, 'all upstream calls use supported routes')
    const text = body.messages[0].content
    calls.push({ kind: provider.kind, body, text })
    if (body.stream) {
      const reply = body.probeReply ?? text
      const delta = (value) => provider.kind === 'anthropic'
        ? { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } }
        : { choices: [{ index: 0, delta: { content: value } }] }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // Split the prior placeholder across complete SSE events.
      const middle = Math.floor(reply.length / 2)
      for (const part of [reply.slice(0, middle), reply.slice(middle)]) {
        res.write(`data: ${JSON.stringify(delta(part))}\n\n`)
      }
      res.end(provider.kind === 'anthropic'
        ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        : 'data: [DONE]\n\n')
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(provider.response(body.probeReply ?? text)))
    }
  })
  captureSocket(mock)
  await listen(mock)
  const mockPort = mock.address().port
  // This is the production default construction path, including newStore().
  const proxy = createProxyServer({
    requestUpstream: (url, options, callback) => {
      const req = request({
        hostname: '127.0.0.1', port: mockPort, path: new URL(url).pathname,
        ...options, agent: upstreamAgent,
        headers: { ...options.headers, host: '127.0.0.1:' + mockPort },
      }, callback)
      outgoing.add(req)
      req.once('close', () => outgoing.delete(req))
      return req
    },
  })
  captureSocket(proxy)
  const accepted = []
  proxy.prependListener('request', (req) => { accepted.push(req.socket) })
  await listen(proxy)
  const port = proxy.address().port
  t.after(async () => {
    for (const req of clients) req.destroy()
    for (const req of outgoing) req.destroy()
    for (const created of agents) created.destroy()
    upstreamAgent.destroy()
    await Promise.all([closeServer(proxy), closeServer(mock)])
    await until(() => sockets.size === 0 && clients.size === 0 && outgoing.size === 0, 'all fixture connections close')
    assert.equal(proxy.listening, false)
    assert.equal(mock.listening, false)
    if (existsSync(configPath)) unlinkSync(configPath)
    resetPIIConfigCache()
    resetControlState()
    resetStats()
    t.diagnostic('teardown complete: clients/upstream sockets closed; both listeners stopped; task config removed')
  })
  async function http(path, { body, headers = {}, clientAgent = defaultAgent } = {}) {
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
    return new Promise((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port, path, method: 'POST', agent: clientAgent,
        headers: { 'content-type': 'application/json', 'content-length': payload.length, ...headers },
      }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.once('error', reject)
        res.once('end', () => {
          const raw = Buffer.concat(chunks).toString()
          if (res.headers['content-type']?.includes('text/event-stream')) {
            const events = raw.split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
              .map((line) => JSON.parse(line.slice(6)))
            resolve({ status: res.statusCode, body: events, raw })
          } else resolve({ status: res.statusCode, body: JSON.parse(raw) })
        })
      })
      clients.add(req)
      req.once('close', () => clients.delete(req))
      req.once('error', reject)
      req.end(payload)
    })
  }
  async function send(provider, text, options = {}) {
    const before = calls.length
    const result = await http(provider.path, {
      ...options,
      body: { model: 'synthetic-test', ...(options.stream ? { stream: true } : {}), messages: [{ role: 'user', content: text }],
        ...(options.reply === undefined ? {} : { probeReply: options.reply }) },
    })
    if (result.status === 200) {
      assert.equal(calls.length, before + 1)
      return { ...result, text: options.stream ? result.body.map((event) => event.delta?.text ?? event.choices?.[0]?.delta?.content ?? '').join('') : provider.text(result.body), upstream: calls.at(-1).text, socket: accepted.at(-1) }
    }
    assert.equal(calls.length, before, 'blocked requests never reach upstream')
    return result
  }
  async function reload(next) {
    writeConfig(next)
    const result = await http('/control/reload')
    assert.equal(result.status, 200)
    assert.deepEqual(loadPIIConfig().providerOverrides, next.providerOverrides ?? {})
  }
  return { send, reload, calls, agent }
}

function assertMasked(result, original) {
  assert.equal(result.status, 200)
  assert.notEqual(result.upstream, original)
  assert.ok(!result.upstream.includes(original), 'original is removed from upstream request')
  assert.match(result.upstream, /\[[^\]]+\]/u)
  assert.equal(result.text, original, 'upstream placeholder is restored exactly')
  return result.upstream
}

const configurations = [
  { name: 'enabled false overrides global true', global: { enabled: true }, override: { enabled: false }, text: emailA, check: (r) => { assert.equal(r.status, 200); assert.equal(r.upstream, emailA); assert.equal(r.text, emailA) } },
  { name: 'enabled true overrides global false', global: { enabled: false }, override: { enabled: true }, text: emailA, check: (r) => assertMasked(r, emailA) },
  { name: 'categories replaces global list', global: { categories: ['EMAIL', 'IP_ADDRESS'] }, override: { categories: [] }, text: emailA + ' ' + ip, check: (r) => { assert.equal(r.status, 200); assert.equal(r.upstream, emailA + ' ' + ip); assert.equal(r.text, emailA + ' ' + ip) } },
  { name: 'categoryActions replaces object rather than merging', global: { categoryActions: { EMAIL: 'block', IP_ADDRESS: 'block' } }, override: { categoryActions: { EMAIL: 'warn' } }, text: emailA + ' ' + ip, check: (r) => { assert.equal(r.status, 200); assert.ok(r.upstream.includes(emailA)); assert.ok(!r.upstream.includes(ip)); assert.match(r.upstream, /\[[^\]]+\]/u); assert.equal(r.text, emailA + ' ' + ip) } },
]

for (const provider of providers) {
  for (const scenario of configurations) {
    for (const phase of ['startup', 'reload']) {
      test(`${provider.kind}: ${phase} ${scenario.name}`, async (t) => {
        const config = { ...baseConfig, ...scenario.global, providerOverrides: { [provider.kind]: scenario.override } }
        const f = await fixture(t, phase === 'startup' ? config : { ...baseConfig, ...scenario.global })
        if (phase === 'reload') await f.reload(config)
        scenario.check(await f.send(provider, scenario.text))
      })
    }
  }

  for (const session of ['explicit ID', 'keep-alive socket']) {
    test(`${provider.kind}: override mapping survives multiple turns on ${session}`, async (t) => {
      const config = { ...baseConfig, providerOverrides: { [provider.kind]: { categories: ['EMAIL'] } } }
      const f = await fixture(t, config)
      // Activate overrides through the control endpoint too: on the baseline,
      // startup ignores them and would conceal the separate session-cache bug.
      await f.reload(config)
      const options = session === 'explicit ID' ? { headers: { 'x-pii-session-id': 'synthetic-turns' } } : {}
      const first = await f.send(provider, emailA, options)
      const marker = assertMasked(first, emailA)
      const second = await f.send(provider, 'Please repeat the prior contact.', { ...options, reply: marker })
      assert.equal(second.text, emailA)
      const third = await f.send(provider, emailB, options)
      assertMasked(third, emailB)
      assert.notEqual(third.upstream, marker, 'new original gets a distinct placeholder within the same session')
      if (session === 'keep-alive socket') assert.equal(first.socket, third.socket)
    })
  }

  test(`${provider.kind}: session header aliases preserve mappings and precedence`, async (t) => {
    const config = { ...baseConfig, providerOverrides: { [provider.kind]: { enabled: true } } }
    const f = await fixture(t, config)
    await f.reload(config)
    const marker = assertMasked(await f.send(provider, emailA, { headers: { 'x-pii-session-id': 'synthetic-alias' } }), emailA)
    for (const alias of ['anthropic-session-id', 'x-session-id']) {
      const result = await f.send(provider, 'repeat', { headers: { [alias]: 'synthetic-alias' }, reply: marker, clientAgent: f.agent() })
      assert.equal(result.text, emailA, 'explicit ID survives a different socket and alias')
    }
    const result = await f.send(provider, 'repeat', { headers: { 'x-pii-session-id': 'synthetic-alias', 'anthropic-session-id': 'different-id', 'x-session-id': 'another-id' }, reply: marker })
    assert.equal(result.text, emailA, 'x-pii-session-id has highest precedence')
  })

  for (const session of ['explicit ID', 'keep-alive socket']) {
    test(`${provider.kind}: adding, changing and removing overrides preserves ${session} mappings`, async (t) => {
      const f = await fixture(t)
      const headers = session === 'explicit ID' ? { 'x-pii-session-id': 'synthetic-reload' } : {}
      const marker = assertMasked(await f.send(provider, emailA, { headers }), emailA)
      await f.reload({ ...baseConfig, providerOverrides: { [provider.kind]: { categories: [] } } })
      const added = await f.send(provider, emailB, { headers, reply: marker })
      assert.equal(added.upstream, emailB)
      assert.equal(added.text, emailA)
      await f.reload({ ...baseConfig, providerOverrides: { [provider.kind]: { enabled: false } } })
      const disabled = await f.send(provider, emailB, { headers, reply: marker })
      assert.equal(disabled.upstream, emailB)
      assert.equal(disabled.text, marker, 'disabled provider does not restore response placeholders')
      const disabledStream = await f.send(provider, 'repeat', { headers, reply: marker, stream: true })
      assert.equal(disabledStream.text, marker, 'disabled provider does not restore SSE placeholders')
      await f.reload({ ...baseConfig, providerOverrides: { [provider.kind]: { enabled: true } } })
      assert.equal((await f.send(provider, 'repeat', { headers, reply: marker })).text, emailA)
      assert.equal((await f.send(provider, 'repeat', { headers, reply: marker, stream: true })).text, emailA)
      await f.reload({ ...baseConfig, providerOverrides: { [provider.kind]: { categoryActions: { EMAIL: 'block' } } } })
      const blocked = await f.send(provider, emailB, { headers })
      assert.equal(blocked.status, 446)
      assert.deepEqual(blocked.body.error.categories, ['EMAIL'])
      assert.equal((await f.send(provider, 'repeat', { headers, reply: marker })).text, emailA)
      await f.reload(baseConfig)
      const removed = await f.send(provider, emailB, { headers, reply: marker })
      assert.ok(!removed.upstream.includes(emailB))
      assert.notEqual(removed.upstream, marker)
      assert.equal(removed.text, emailA)
    })
  }
}

test('different explicit IDs isolate mappings and reset only the selected session', async (t) => {
  const f = await fixture(t)
  const provider = providers[0]
  const options = (id, extra = {}) => ({ headers: { 'x-pii-session-id': id, ...extra } })
  const a = options('synthetic-a')
  const b = options('synthetic-b')
  const marker = assertMasked(await f.send(provider, emailA, a), emailA)
  assert.equal((await f.send(provider, 'repeat', { ...b, reply: marker })).text, marker)
  assert.equal(assertMasked(await f.send(provider, emailB, b), emailB), marker)
  assert.equal((await f.send(provider, 'repeat', { ...a, reply: marker })).text, emailA)
  assert.equal((await f.send(provider, 'repeat', { ...options('synthetic-a', { 'x-pii-session-reset': 'true' }), reply: marker })).text, marker)
  assert.equal((await f.send(provider, 'repeat', { ...b, reply: marker })).text, emailB)
})

test('different keep-alive sockets isolate mappings and reset only the selected socket', async (t) => {
  const f = await fixture(t)
  const provider = providers[1]
  const a = f.agent()
  const b = f.agent()
  const first = await f.send(provider, emailA, { clientAgent: a })
  const marker = assertMasked(first, emailA)
  const unknown = await f.send(provider, 'repeat', { clientAgent: b, reply: marker })
  assert.notEqual(first.socket, unknown.socket)
  assert.equal(unknown.text, marker)
  const second = await f.send(provider, emailB, { clientAgent: b })
  assert.equal(assertMasked(second, emailB), marker)
  assert.equal(second.socket, unknown.socket)
  assert.equal((await f.send(provider, 'repeat', { clientAgent: a, headers: { 'x-pii-session-reset': '1' }, reply: marker })).text, marker)
  assert.equal((await f.send(provider, 'repeat', { clientAgent: b, reply: marker })).text, emailB)
})

for (const session of ['explicit ID', 'keep-alive socket']) {
  test(`providers isolate mappings and reset scope on the same ${session}`, async (t) => {
    // No override: provider isolation is required even on the global defaults.
    const f = await fixture(t)
    const options = session === 'explicit ID' ? { headers: { 'x-pii-session-id': 'same-synthetic-id' } } : {}
    const first = await f.send(providers[0], emailA, options)
    const marker = assertMasked(first, emailA)
    const unknown = await f.send(providers[1], 'repeat', { ...options, reply: marker })
    assert.equal(first.socket, unknown.socket)
    assert.equal(unknown.text, marker, 'provider B must not restore provider A mapping')
    const second = await f.send(providers[1], emailB, options)
    assert.equal(assertMasked(second, emailB), marker, 'provider B starts its own placeholder sequence')
    assert.equal((await f.send(providers[0], 'repeat', { ...options, reply: marker })).text, emailA)
    await f.reload({ ...baseConfig, providerOverrides: { anthropic: { categories: ['EMAIL'] }, openai: { categoryActions: { EMAIL: 'mask' } } } })
    assert.equal((await f.send(providers[0], 'repeat', { ...options, reply: marker })).text, emailA)
    assert.equal((await f.send(providers[1], 'repeat', { ...options, reply: marker })).text, emailB)
    const reset = { ...options, headers: { ...options.headers, 'x-pii-session-reset': 'true' }, reply: marker }
    assert.equal((await f.send(providers[0], 'repeat', reset)).text, marker)
    assert.equal((await f.send(providers[1], 'repeat', { ...options, reply: marker })).text, emailB)
  })
}

for (const provider of providers) {
  for (const session of ['explicit ID', 'keep-alive socket']) {
    test(`${provider.kind}: SSE restores prior-turn override mapping on ${session}`, async (t) => {
      const config = { ...baseConfig, providerOverrides: { [provider.kind]: { categories: ['EMAIL'] } } }
      const f = await fixture(t, config)
      await f.reload(config)
      const options = session === 'explicit ID' ? { headers: { 'x-pii-session-id': 'synthetic-sse' } } : {}
      const first = await f.send(provider, emailA, options)
      const marker = assertMasked(first, emailA)
      const second = await f.send(provider, 'Repeat the prior contact.', { ...options, reply: marker, stream: true })
      assert.equal(second.text, emailA)
      assert.ok(second.raw.includes(provider.kind === 'anthropic' ? 'message_stop' : '[DONE]'))
      if (session === 'keep-alive socket') assert.equal(first.socket, second.socket)
    })
  }
}
