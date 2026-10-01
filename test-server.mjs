import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { request } from 'node:http'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const projectDir = dirname(fileURLToPath(import.meta.url))
const maxBodyBytes = 1024

// Bundle once so the server, policy error class, and control state all share
// their actual module instances. Keep configuration independent of local files.
const bundle = await build({
  stdin: {
    contents: `
      export { createProxyServer } from './src/server/app.ts';
      export { SessionFilterStore } from './src/server/sessionFilterStore.ts';
      export { resetControlState } from './src/core/controlState.ts';
      export { resetStats } from './src/core/stats.ts';
      export { loadPIIConfig as getTestConfig } from './src/core/config.ts';
    `,
    resolveDir: projectDir,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  write: false,
  plugins: [{
    name: 'isolated-test-config',
    setup(builder) {
      builder.onLoad({ filter: /[/\\]core[/\\]config\.ts$/ }, ({ path }) => ({
        contents: `
          import { DEFAULT_CONFIG } from './types.js';
          const config = {
            ...DEFAULT_CONFIG,
            enabled: true,
            maxRequestBodyBytes: ${maxBodyBytes},
            categories: ['EMAIL'],
            ollamaEnabled: false,
            heuristicNerEnabled: false,
            customPatterns: [],
            customCategories: [],
            dictionary: [],
            allowlist: [],
            plugins: [],
            categoryActions: {},
            categoryOptions: {},
            auditLog: { ...DEFAULT_CONFIG.auditLog, enabled: false },
            responseDetection: { enabled: false, action: 'warn' },
            providerOverrides: {},
            vaultEnabled: false,
            fpe: { enabled: false },
          };
          export function loadPIIConfig() { return config; }
          export function reloadPIIConfig() { return config; }
        `,
        resolveDir: dirname(path),
        loader: 'ts',
      }))
    },
  }],
})

const {
  createProxyServer,
  SessionFilterStore,
  resetControlState,
  resetStats,
  getTestConfig,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

function fakeUpstream(respond, calls) {
  return (url, options, callback) => {
    const outgoing = new EventEmitter()
    const chunks = []
    outgoing.write = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      return true
    }
    outgoing.end = () => {
      const call = { url, options, body: Buffer.concat(chunks) }
      calls.push(call)
      queueMicrotask(async () => {
        try {
          const result = await respond(call)
          const incoming = Readable.from(result.chunks ?? [result.body ?? Buffer.alloc(0)])
          incoming.statusCode = result.statusCode ?? 200
          incoming.headers = result.headers ?? { 'content-type': 'application/json' }
          callback(incoming)
        } catch (error) {
          outgoing.emit('error', error)
        }
      })
    }
    return outgoing
  }
}

async function startProxy(t, respond = () => ({ body: '{}' }), configOverrides = {}) {
  resetControlState()
  resetStats()
  const calls = []
  const sessionFilters = new SessionFilterStore({ ...getTestConfig(), ...configOverrides })
  const server = createProxyServer({
    sessionFilters,
    requestUpstream: fakeUpstream(respond, calls),
  })
  assert.equal(server.listening, false, 'creating a server must not bind a port')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    sessionFilters.clear()
    resetControlState()
    resetStats()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  function send(path, body, headers = {}, method = body === undefined ? 'GET' : 'POST') {
    const bytes = body === undefined ? undefined
      : Buffer.isBuffer(body) ? body
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    return new Promise((resolve, reject) => {
      const client = request({
        hostname: '127.0.0.1',
        port: server.address().port,
        path,
        method,
        agent: false,
        headers: {
          ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}),
          ...headers,
        },
      }, (response) => {
        const received = []
        response.on('data', (chunk) => received.push(chunk))
        response.on('error', reject)
        response.on('end', () => {
          const body = Buffer.concat(received)
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body,
            text: body.toString('utf8'),
            json: () => JSON.parse(body.toString('utf8')),
          })
        })
      })
      client.on('error', reject)
      client.setTimeout(3000, () => client.destroy(new Error('Local proxy test timed out')))
      client.end(bytes)
    })
  }

  return { calls, send }
}

const email = 'ada@example.test'
const requestBody = (stream = false) => ({
  model: 'test-model',
  stream,
  messages: [{ role: 'user', content: email }],
})
const outgoingText = (call) => JSON.parse(call.body.toString('utf8')).messages[0].content

const providers = [
  {
    name: 'Messages',
    path: '/v1/messages',
    origin: 'https://api.anthropic.com',
    response: (text) => ({ content: [{ type: 'text', text }] }),
    text: (body) => body.content[0].text,
    delta: (text) => `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
    })}\n\n`,
    terminal: 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    streamText: (event) => event.delta?.text ?? '',
  },
  {
    name: 'Chat Completions',
    path: '/v1/chat/completions',
    origin: 'https://api.openai.com',
    response: (text) => ({ choices: [{ index: 0, message: { role: 'assistant', content: text } }] }),
    text: (body) => body.choices[0].message.content,
    delta: (text) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`,
    terminal: 'data: [DONE]\n\n',
    streamText: (event) => event.choices?.[0]?.delta?.content ?? '',
  },
]

test('health, control, and analyze remain local HTTP endpoints', async (t) => {
  const { calls, send } = await startProxy(t)
  assert.deepEqual((await send('/health')).json(), { status: 'ok' })
  const initial = await send('/control/status')
  assert.equal(initial.status, 200)
  assert.equal(initial.json().filterEnabled, true)
  assert.deepEqual(initial.json().activeCategories, ['EMAIL'])

  assert.deepEqual((await send('/control/disable/EMAIL', '')).json().disabledCategories, ['EMAIL'])
  assert.deepEqual((await send('/control/enable/EMAIL', '')).json().disabledCategories, [])
  assert.equal((await send('/control/disable/NOT_A_CATEGORY', '')).status, 400)
  assert.equal((await send('/control/passthrough', '')).json().filterEnabled, false)
  assert.equal((await send('/control/filter', '')).json().filterEnabled, true)

  const analyzed = await send('/analyze', { text: `Contact ${email}`, useOllama: false })
  assert.equal(analyzed.status, 200)
  assert.ok(analyzed.json().detections.some((match) => match.category === 'EMAIL' && match.text === email))
  assert.equal((await send('/analyze', { text: 42 })).status, 400)
  assert.equal((await send('/control/stats')).status, 200)
  assert.match((await send('/metrics')).text, /cloakroom_active_sessions 0/)
  assert.equal(calls.length, 0)
})

test('invalid JSON and oversized bodies are rejected before upstream contact', async (t) => {
  const { calls, send } = await startProxy(t)
  for (const path of ['/analyze', ...providers.map((provider) => provider.path)]) {
    const response = await send(path, '{broken')
    assert.equal(response.status, 400)
    assert.equal(response.json().error, 'Invalid JSON body')
  }
  const oversized = await send('/v1/messages', Buffer.alloc(maxBodyBytes + 1, 'a'))
  assert.equal(oversized.status, 413)
  assert.match(oversized.json().error, /Request body exceeds/)
  assert.equal(calls.length, 0)
})

test('blocked EMAIL policy returns 446 without contacting the provider', async (t) => {
  const { calls, send } = await startProxy(t, undefined, { categoryActions: { EMAIL: 'block' } })
  const response = await send('/v1/messages', requestBody())
  assert.equal(response.status, 446)
  assert.equal(response.json().error.type, 'request_blocked')
  assert.deepEqual(response.json().error.categories, ['EMAIL'])
  assert.equal(calls.length, 0)
})

test('control changes affect filtering in an existing session', async (t) => {
  const provider = providers[1]
  const { calls, send } = await startProxy(t, (call) => ({
    body: JSON.stringify(provider.response(outgoingText(call))),
  }))
  const headers = { 'x-pii-session-id': 'control-regression-session' }
  await send(provider.path, requestBody(), headers)
  assert.notEqual(outgoingText(calls.at(-1)), email)

  await send('/control/disable/EMAIL', '')
  await send(provider.path, requestBody(), headers)
  assert.equal(outgoingText(calls.at(-1)), email)

  await send('/control/filter', '')
  await send(provider.path, requestBody(), headers)
  assert.notEqual(outgoingText(calls.at(-1)), email)

  await send('/control/passthrough', '')
  await send(provider.path, requestBody(), headers)
  assert.equal(outgoingText(calls.at(-1)), email)
})

for (const provider of providers) {
  test(`${provider.name} masks outbound content and restores JSON`, async (t) => {
    const { calls, send } = await startProxy(t, (call) => ({
      body: JSON.stringify(provider.response(outgoingText(call))),
      headers: { 'content-type': 'application/json', 'content-length': '9999' },
    }))
    const response = await send(`${provider.path}?test=1`, requestBody(), { 'accept-encoding': 'gzip' })
    assert.equal(response.status, 200)
    assert.equal(provider.text(response.json()), email)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `${provider.origin}${provider.path}?test=1`)
    assert.match(outgoingText(calls[0]), /^\[メールアドレス[A-Z]+\]$/)
    assert.ok(!calls[0].body.includes(Buffer.from(email)))
    assert.equal(calls[0].options.headers['content-length'], String(calls[0].body.length))
    assert.equal(calls[0].options.headers['accept-encoding'], undefined)
    assert.notEqual(response.headers['content-length'], '9999')
  })

  test(`${provider.name} restores placeholders split across SSE events and chunks`, async (t) => {
    const { calls, send } = await startProxy(t, (call) => {
      const masked = outgoingText(call)
      const splitAt = Math.floor(masked.length / 2)
      const stream = provider.delta(masked.slice(0, splitAt))
        + provider.delta(masked.slice(splitAt)) + provider.terminal
      return {
        headers: { 'content-type': 'text/event-stream' },
        chunks: [stream.slice(0, 11), stream.slice(11, 29), stream.slice(29)],
      }
    })
    const response = await send(provider.path, requestBody(true))
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /text\/event-stream/)
    const restored = response.text.split('\n')
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => provider.streamText(JSON.parse(line.slice(6))))
      .join('')
    assert.equal(restored, email)
    assert.ok(response.text.endsWith(provider.terminal))
    assert.equal(calls.length, 1)
    assert.ok(!calls[0].body.includes(Buffer.from(email)))
  })

  test(`${provider.name} preserves UTF-8 when every SSE byte is a separate chunk`, async (t) => {
    const { calls, send } = await startProxy(t, (call) => {
      const masked = outgoingText(call)
      const stream = Buffer.from(provider.delta(`こんにちは🧥 ${masked} さん`) + provider.terminal)
      return {
        headers: { 'content-type': 'text/event-stream' },
        chunks: Array.from(stream, (byte) => Buffer.from([byte])),
      }
    })
    const response = await send(provider.path, requestBody(true))
    assert.equal(response.status, 200)
    const restored = response.text.split('\n')
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => provider.streamText(JSON.parse(line.slice(6))))
      .join('')
    assert.equal(restored, `こんにちは🧥 ${email} さん`)
    assert.ok(response.text.endsWith(provider.terminal))
    assert.ok(!calls[0].body.includes(Buffer.from(email)))
  })

  test(`${provider.name} flushes a UTF-8 SSE event without its final delimiter`, async (t) => {
    const { send } = await startProxy(t, (call) => {
      const stream = Buffer.from(provider.delta(`🧥 ${outgoingText(call)} 完了`).trimEnd())
      return {
        headers: { 'content-type': 'text/event-stream' },
        chunks: Array.from(stream, (byte) => Buffer.from([byte])),
      }
    })
    const response = await send(provider.path, requestBody(true))
    assert.equal(response.status, 200)
    const restored = response.text.split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => provider.streamText(JSON.parse(line.slice(6))))
      .join('')
    assert.equal(restored, `🧥 ${email} 完了`)
  })
}

test('a session mapping survives multiple HTTP connections and conversation turns', async (t) => {
  let firstPlaceholder
  const provider = providers[1]
  const { calls, send } = await startProxy(t, (call) => {
    firstPlaceholder ??= outgoingText(call)
    return { body: JSON.stringify(provider.response(firstPlaceholder)) }
  })
  const headers = { 'x-pii-session-id': 'http-regression-session' }
  const first = await send(provider.path, requestBody(), headers)
  assert.equal(provider.text(first.json()), email)
  const second = await send(provider.path, {
    model: 'test-model', messages: [{ role: 'user', content: 'Repeat the previous contact.' }],
  }, headers)
  assert.equal(provider.text(second.json()), email)
  assert.equal(calls.length, 2)
  assert.equal(outgoingText(calls[1]), 'Repeat the previous contact.')
  assert.equal((await send('/control/stats')).json().activeSessions, 1)
})

for (const path of ['/v1/unknown?test=1', '/v1/responses']) {
  test(`${path} preserves pass-through request and binary response bytes`, async (t) => {
    const outbound = Buffer.from(`{ "input" : "${email}" }\n`)
    const inbound = Buffer.from([0, 255, 128, 10, 13, 42])
    const { calls, send } = await startProxy(t, () => ({
      body: inbound,
      statusCode: 201,
      headers: { 'content-type': 'application/octet-stream', 'x-upstream-test': 'present' },
    }))
    const response = await send(path, outbound, { 'x-provider': 'openai' })
    assert.equal(response.status, 201)
    assert.equal(response.headers['x-upstream-test'], 'present')
    assert.deepEqual(response.body, inbound)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].body, outbound)
    assert.equal(calls[0].url, `https://api.openai.com${path}`)
  })
}

test('upstream connection errors become a JSON 502 response', async (t) => {
  const { calls, send } = await startProxy(t, () => { throw new Error('Simulated connection failure') })
  const response = await send('/v1/chat/completions', requestBody())
  assert.equal(response.status, 502)
  assert.deepEqual(response.json(), { error: 'Upstream proxy error' })
  assert.equal(calls.length, 1)
})
