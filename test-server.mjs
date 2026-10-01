import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer, request } from 'node:http'
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

async function startProxy(t, respond = () => ({ body: '{}' }), configOverrides = {}, requestUpstream) {
  resetControlState()
  resetStats()
  const calls = []
  const sessionFilters = new SessionFilterStore({ ...getTestConfig(), ...configOverrides })
  const server = createProxyServer({
    sessionFilters,
    requestUpstream: requestUpstream ?? fakeUpstream(respond, calls),
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

  function send(path, body, headers = {}, method = body === undefined ? 'GET' : 'POST', trailers) {
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
          ...(bytes ? {
            'content-type': 'application/json',
            ...(headers['transfer-encoding'] ? {} : { 'content-length': bytes.length }),
          } : {}),
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
      if (bytes && headers['transfer-encoding'] === 'chunked') {
        const split = Math.floor(bytes.length / 2)
        client.write(bytes.subarray(0, split))
        client.write(bytes.subarray(split))
        if (trailers !== undefined) client.addTrailers(trailers)
        client.end()
      } else {
        client.end(bytes)
      }
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

// Use a real HTTP parser upstream: the in-memory mock cannot reject conflicting
// Content-Length / Transfer-Encoding headers on the proxy's outgoing request.
for (const provider of [...providers, { name: 'Pass-through', path: '/v1/unknown?chunked=1' }]) {
  for (const chunked of [true, false]) {
    test(`${provider.name} forwards ${chunked ? 'chunked' : 'fixed-length'} bodies with valid upstream framing`, async (t) => {
      const received = []
      const parserErrors = []
      const upstream = createServer(async (req, res) => {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = Buffer.concat(chunks)
        received.push({ headers: req.headers, body })
        const parsed = JSON.parse(body.toString('utf8'))
        const response = provider.response
          ? provider.response(parsed.messages[0].content)
          : parsed
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(response))
      })
      upstream.on('clientError', (error, socket) => {
        parserErrors.push(error.code)
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      })
      t.after(async () => {
        upstream.closeAllConnections()
        await new Promise((resolve) => upstream.close(resolve))
      })
      await new Promise((resolve, reject) => {
        upstream.once('error', reject)
        upstream.listen(0, '127.0.0.1', resolve)
      })
      const requestRealUpstream = (url, options, callback) => {
        const target = new URL(url)
        return request(`http://127.0.0.1:${upstream.address().port}${target.pathname}${target.search}`, options, callback)
      }
      const { send } = await startProxy(t, undefined, {}, requestRealUpstream)
      const body = provider.response ? requestBody() : { input: email }
      const response = await send(provider.path, body, chunked ? { 'transfer-encoding': 'chunked' } : {})
      assert.equal(response.status, 200, `upstream parser errors: ${parserErrors.join(', ')}`)
      assert.deepEqual(parserErrors, [])
      assert.equal(received.length, 1)
      assert.equal(received[0].headers['transfer-encoding'], undefined)
      assert.equal(Number(received[0].headers['content-length']), received[0].body.length)
      if (provider.response) {
        assert.ok(!received[0].body.includes(Buffer.from(email)))
        assert.equal(provider.text(response.json()), email)
      } else {
        assert.deepEqual(JSON.parse(received[0].body.toString('utf8')), body)
        assert.deepEqual(response.json(), body)
      }
    })
  }
}

const contentDigest = (body) => `sha-256=:${createHash('sha256').update(body).digest('base64')}:`
const passThrough = { name: 'Pass-through', path: '/v1/unknown?trailers=1' }
const trailerCases = [
  { name: 'declared checksum and repeated metadata', provider: passThrough, text: '架空 🧥',
    declared: 'Content-Digest, X-Note', repeated: true },
  { name: 'undeclared actual trailers', provider: passThrough, text: '架空 🧥' },
  { name: 'declaration without actual trailers', provider: passThrough, text: email,
    declared: 'Content-Digest', noActual: true },
  { name: 'empty GET body with actual trailer', provider: passThrough, empty: true, method: 'GET',
    declared: 'Content-Digest' },
  { name: 'empty-valued metadata', provider: passThrough, text: 'test',
    declared: 'Content-Digest, X-Note', emptyValue: true },
  { name: 'empty declaration without actual trailers', provider: passThrough, text: 'test',
    declared: '', noActual: true, emptyDeclaration: true },
  { name: 'ignored empty declaration elements', provider: passThrough, text: 'test',
    declared: ', ', noActual: true, emptyDeclaration: true },
  ...providers.flatMap((provider) => [
    { name: 'unchanged body with checksum', provider, text: '架空 🧥', declared: 'Content-Digest' },
    { name: 'masked body rejects stale checksum', provider, text: email, declared: 'Content-Digest', rejected: true },
    { name: 'reserialized whitespace rejects stale checksum', provider, text: 'test', pretty: true,
      declared: 'Content-Digest', rejected: true },
    { name: 'masked body with undeclared trailer rejects stale checksum', provider, text: email, rejected: true },
    { name: 'masked body with declaration only still restores', provider, text: email,
      declared: 'Content-Digest', noActual: true },
    { name: 'disabled filter with unchanged body preserves checksum', provider, text: email,
      declared: 'Content-Digest', disabled: true },
  ]),
]

for (const entry of trailerCases) {
  test(`${entry.provider.name} trailers: ${entry.name}`, async (t) => {
    const received = []
    const parserErrors = []
    const original = entry.empty ? '' : JSON.stringify({
      model: 'test-model', messages: [{ role: 'user', content: entry.text }],
    }, null, entry.pretty ? 2 : undefined)
    const trailers = entry.noActual ? undefined : [
      ['Content-Digest', contentDigest(original)],
      ...(entry.repeated ? [['X-Note', 'first'], ['X-Note', 'second']] : []),
      ...(entry.emptyValue ? [['X-Note', '']] : []),
    ]
    const upstream = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      received.push({ headers: req.headers, trailers: req.trailers, rawTrailers: req.rawTrailers, body })
      // Verify a real content checksum, rather than accepting stale metadata.
      if (req.trailers['content-digest'] && req.trailers['content-digest'] !== contentDigest(body)) {
        res.writeHead(422); res.end('Content-Digest mismatch'); return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(entry.provider.response
        ? JSON.stringify(entry.provider.response(JSON.parse(body.toString('utf8')).messages[0].content))
        : body)
    })
    upstream.on('clientError', (error, socket) => {
      parserErrors.push(error.code)
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    })
    t.after(async () => {
      upstream.closeAllConnections()
      await new Promise((resolve) => upstream.close(resolve))
    })
    await new Promise((resolve, reject) => {
      upstream.once('error', reject)
      upstream.listen(0, '127.0.0.1', resolve)
    })
    const requestRealUpstream = (url, options, callback) => {
      const target = new URL(url)
      return request(`http://127.0.0.1:${upstream.address().port}${target.pathname}${target.search}`, options, callback)
    }
    const { send } = await startProxy(t, undefined, entry.disabled ? { enabled: false } : {}, requestRealUpstream)
    const response = await send(entry.provider.path, original, {
      'transfer-encoding': 'chunked', ...(entry.declared !== undefined ? { trailer: entry.declared } : {}),
    }, entry.method ?? 'POST', trailers)
    if (entry.rejected) {
      assert.equal(response.status, 400)
      assert.deepEqual(response.json(), { error: 'Request trailers cannot be forwarded after transforming the body' })
      assert.equal(received.length, 0, 'a transformed body with trailers must never reach upstream')
    } else {
      assert.equal(response.status, 200, response.text)
      assert.equal(received.length, 1)
      const sent = received[0]
      if (entry.emptyDeclaration) {
        assert.equal(Number(sent.headers['content-length']), sent.body.length)
        assert.equal(sent.headers['transfer-encoding'], undefined)
        assert.equal(sent.headers.trailer, undefined)
      } else {
        assert.equal(sent.headers['content-length'], undefined)
        assert.equal(sent.headers['transfer-encoding'], 'chunked')
        assert.ok(sent.headers.trailer.toLowerCase().split(',').map((name) => name.trim()).includes('content-digest'))
      }
      assert.deepEqual(sent.rawTrailers, trailers?.flat() ?? [], 'preserve duplicate fields, order, case and values')
      if (entry.provider.response) {
        assert.equal(entry.provider.text(response.json()), entry.text)
        if (entry.noActual) assert.ok(!sent.body.includes(Buffer.from(email)), 'declaration-only input must still be masked')
        else assert.equal(sent.body.toString('utf8'), original)
      } else {
        assert.equal(sent.body.toString('utf8'), original)
        assert.equal(response.text, original)
      }
    }
    assert.deepEqual(parserErrors, [])
  })
}

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
