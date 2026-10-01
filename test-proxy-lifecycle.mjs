import assert from 'node:assert/strict'
import { Agent, createServer, request } from 'node:http'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'

// The override permits an immutable baseline checkout to run this same suite.
const projectDir = process.env.CLOAKROOM_TEST_REPO ?? dirname(fileURLToPath(import.meta.url))
const bundle = await build({
  stdin: { contents: [
    "export { createProxyServer } from './src/server/app.ts';",
    "export { SessionFilterStore } from './src/server/sessionFilterStore.ts';",
    "export { loadPIIConfig } from './src/core/config.ts';",
    "export { resetControlState } from './src/core/controlState.ts';",
  ].join('\n'), resolveDir: projectDir, loader: 'ts' },
  bundle: true, platform: 'node', target: 'node22', format: 'esm', write: false,
  plugins: [{
    name: 'isolated-lifecycle-config',
    setup(builder) {
      builder.onLoad({ filter: /[/\\]core[/\\]config\.ts$/ }, ({ path }) => ({
        contents: [
          "import { DEFAULT_CONFIG } from './types.js';",
          "const config = { ...DEFAULT_CONFIG, categories: ['EMAIL'], ollamaEnabled: false,",
          'heuristicNerEnabled: false, customPatterns: [], customCategories: [],',
          'dictionary: [], allowlist: [], plugins: [], categoryActions: {}, categoryOptions: {},',
          "auditLog: { ...DEFAULT_CONFIG.auditLog, enabled: false }, responseDetection: { enabled: false, action: 'warn' },",
          'providerOverrides: {}, vaultEnabled: false, fpe: { enabled: false } };',
          'export function loadPIIConfig() { return config; }',
          'export function reloadPIIConfig() { return config; }',
        ].join('\n'), resolveDir: dirname(path), loader: 'ts',
      }))
    },
  }],
})
const { createProxyServer, SessionFilterStore, loadPIIConfig, resetControlState } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))

const email = 'fictional.person@example.test'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, message, timeout = 1200) {
  const end = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= end) assert.fail(message)
    await sleep(10)
  }
}
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
async function closeServer(server) {
  const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  server.closeAllConnections()
  await closed
}
const targets = [
  {
    name: 'Messages', path: '/v1/messages',
    delta: (text) => 'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) + '\n\n',
    terminal: 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    json: (text) => ({ content: [{ type: 'text', text }] }),
    eventText: (value) => value.delta?.text ?? '',
  },
  {
    name: 'Completions', path: '/v1/chat/completions',
    delta: (text) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }) + '\n\n',
    terminal: 'data: [DONE]\n\n',
    json: (text) => ({ choices: [{ index: 0, message: { role: 'assistant', content: text } }] }),
    eventText: (value) => value.choices?.[0]?.delta?.content ?? '',
  },
  {
    name: 'Pass-through', path: '/v1/models', passthrough: true,
    delta: (text) => 'data: ' + JSON.stringify({ text }) + '\n\n',
    terminal: 'data: [DONE]\n\n',
    json: (text) => ({ text }),
    eventText: (value) => value.text ?? '',
  },
]
function sseText(target, text) {
  return text.split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => target.eventText(JSON.parse(line.slice(6)))).join('')
}

async function fixture(t, target, { enabled = true, keepAlive = false, gatedFilter = false } = {}) {
  resetControlState()
  const upstreams = []
  const mocks = []
  const downstreams = []
  const clients = []
  const timers = new Set()
  const clientAgent = new Agent({ keepAlive, maxSockets: 1 })
  const upstreamAgent = new Agent({ keepAlive, maxSockets: 1 })
  const store = new SessionFilterStore({ ...loadPIIConfig(), enabled })
  let enterFilter
  const filterEntered = new Promise((resolve) => { enterFilter = resolve })
  let releaseFilter
  const filterReleased = new Promise((resolve) => { releaseFilter = resolve })
  if (gatedFilter) {
    const acquire = store.acquire.bind(store)
    store.acquire = (req) => {
      const filter = acquire(req)
      const original = filter.filterRequestBody.bind(filter)
      filter.filterRequestBody = async (body) => {
        enterFilter()
        await filterReleased
        return original(body)
      }
      return filter
    }
  }
  const mock = createServer(async (req, res) => {
    const item = { req, res, socket: req.socket, bodyEnded: false, responseClosed: false, socketClosed: false, writes: 0 }
    mocks.push(item)
    req.on('end', () => { item.bodyEnded = true })
    res.once('close', () => {
      item.responseClosed = true
      if (item.timer) { clearInterval(item.timer); timers.delete(item.timer) }
    })
    req.socket.once('close', () => { item.socketClosed = true })
    const chunks = []
    try { for await (const chunk of req) chunks.push(chunk) } catch { return }
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    const mode = new URL(req.url, 'http://local.test').searchParams.get('mode')
    const text = body.messages?.[0]?.content ?? 'Synthetic sample'
    if (mode === 'headers-held') return
    if (mode === 'connection-error') { req.socket.destroy(); return }
    if (mode === 'buffered-held') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.flushHeaders()
      res.write('{"incomplete":')
      return
    }
    if (mode === 'json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(target.json(text)))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = () => { item.writes++; res.write(target.delta(text + ' ')) }
    if (mode === 'healthy') {
      // Full UTF-8 strings: this test does not depend on the separate decoder fix.
      res.write(target.delta(text))
      res.write(target.delta(' tail ['))
      res.end(target.terminal)
      return
    }
    send()
    if (mode === 'truncate') {
      item.timer = setTimeout(() => { timers.delete(item.timer); req.socket.destroy() }, 40)
    } else {
      item.timer = setInterval(send, 30)
    }
    timers.add(item.timer)
  })
  await listen(mock)
  const mockPort = mock.address().port
  const proxy = createProxyServer({
    sessionFilters: store,
    requestUpstream: (url, options, callback) => {
      const item = { responseClosed: false, requestClosed: false, socketClosed: false }
      upstreams.push(item)
      item.req = request({
        hostname: '127.0.0.1', port: mockPort, path: new URL(url).pathname + new URL(url).search,
        ...options, agent: upstreamAgent, headers: { ...options.headers, host: '127.0.0.1:' + mockPort },
      }, (res) => {
        item.res = res
        res.once('close', () => { item.responseClosed = true })
        callback(res)
      })
      item.req.once('socket', (socket) => {
        item.socket = socket
        socket.once('close', () => { item.socketClosed = true })
      })
      item.req.once('close', () => { item.requestClosed = true })
      item.req.on('error', () => {})
      return item.req
    },
  })
  // Await application promises too: a closed peer must not leave a pending handler.
  const handler = proxy.listeners('request')[0]
  proxy.removeListener('request', handler)
  proxy.on('request', (req, res) => {
    const item = { req, res, finished: false, closed: false, settled: false,
      initialCloseListeners: res.listenerCount('close'), initialFinishListeners: res.listenerCount('finish') }
    downstreams.push(item)
    const onFinish = () => { item.finished = true }
    res.once('finish', onFinish)
    res.once('close', () => { item.closed = true; res.removeListener('finish', onFinish) })
    Promise.resolve(handler(req, res)).then(() => { item.settled = true }, (error) => { item.error = error; item.settled = true })
  })
  await listen(proxy)
  const proxyPort = proxy.address().port
  function send(mode, { text = email, abortOnData = false, stream = true } = {}) {
    const body = JSON.stringify({ model: 'synthetic-local', stream, messages: [{ role: 'user', content: text }] })
    const item = { chunks: [], ended: false, closed: false, responseSeen: false }
    clients.push(item)
    item.req = request({ hostname: '127.0.0.1', port: proxyPort, path: target.path + '?mode=' + mode,
      method: 'POST', agent: clientAgent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      item.res = res
      item.responseSeen = true
      item.status = res.statusCode
      res.on('data', (chunk) => {
        item.chunks.push(chunk)
        if (abortOnData) { res.destroy(); item.req.destroy() }
      })
      res.once('end', () => { item.ended = true })
      res.once('close', () => { item.closed = true })
      res.on('error', (error) => { item.error = error })
    })
    item.req.on('error', (error) => { item.error = error })
    item.req.once('close', () => { if (!item.res) item.closed = true })
    item.req.end(body)
    item.text = () => Buffer.concat(item.chunks).toString()
    return item
  }
  function checkListeners(item) {
    assert.equal(item.res.listenerCount('close'), item.initialCloseListeners, 'lifecycle close listener leaked')
    assert.ok(item.res.listenerCount('finish') <= item.initialFinishListeners, 'lifecycle finish listener leaked')
    assert.equal(item.error, undefined, 'request handler rejected outside proxy error handling')
  }
  t.after(async () => {
    releaseFilter()
    await sleep(0)
    for (const timer of timers) { clearInterval(timer); clearTimeout(timer) }
    timers.clear()
    for (const item of clients) { item.res?.destroy(); item.req.destroy() }
    const teardownError = new Error('Lifecycle fixture teardown')
    for (const item of upstreams) { item.res?.destroy(teardownError); item.req.destroy(teardownError) }
    clientAgent.destroy()
    upstreamAgent.destroy()
    await closeServer(proxy)
    await closeServer(mock)
    await until(() => downstreams.every((item) => item.settled && item.closed), 'handler teardown did not settle')
    await until(() => upstreams.every((item) => item.requestClosed && item.socketClosed && (!item.res || item.responseClosed)), 'upstream teardown did not close all endpoints')
    await until(() => mocks.every((item) => item.responseClosed && item.socketClosed), 'mock teardown did not close all endpoints')
    await until(() => store.activeSessionCount() === 0, 'socket session leaked after teardown')
    assert.equal(timers.size, 0)
    assert.equal(proxy.listening, false)
    assert.equal(mock.listening, false)
    for (const item of downstreams) checkListeners(item)
    store.clear()
    resetControlState()
    t.diagnostic('teardown complete: all handlers and upstream endpoints closed; sessions/timers/listeners cleared; both listeners stopped')
  })
  async function cancelled(index = 0) {
    await until(() => {
      const up = upstreams[index], remote = mocks[index], down = downstreams[index]
      return up && remote && down && down.closed && down.settled
        && up.requestClosed && up.socketClosed && (!up.res || up.responseClosed)
        && remote.responseClosed && remote.socketClosed
    }, 'client disconnect did not cancel and settle the actual upstream connection before teardown')
    assert.equal(upstreams[index].req.destroyed, true)
    assert.equal(upstreams[index].socket.destroyed, true)
    assert.equal(mocks[index].socket.destroyed, true)
    if (upstreams[index].res) assert.equal(upstreams[index].res.destroyed, true)
    checkListeners(downstreams[index])
    await until(() => store.activeSessionCount() === 0, 'aborted socket session remains active')
  }
  async function healthy(mode = 'healthy') {
    const item = send(mode, { stream: mode !== 'json' })
    await until(() => item.ended, 'healthy response did not complete')
    const index = downstreams.length - 1
    await until(() => downstreams[index].closed && downstreams[index].settled, 'healthy handler did not settle')
    assert.equal(item.status, 200)
    if (mode === 'json') assert.equal(item.text(), JSON.stringify(target.json(email)))
    else {
      assert.equal(sseText(target, item.text()), email + ' tail [', 'restored content and terminal flush must be complete')
      const terminalData = target.name === 'Messages' ? 'data: {"type":"message_stop"}' : 'data: [DONE]'
      assert.equal(item.text().split('\n').filter((line) => line === terminalData).length, 1)
      assert.ok(item.text().trimEnd().endsWith(terminalData), 'terminal marker must be last')
    }
    checkListeners(downstreams[index])
    return item
  }
  return { send, healthy, cancelled, upstreams, mocks, downstreams, store, filterEntered, releaseFilter }
}

for (const target of targets) {
  test(target.name + ' cancels a disconnect before upstream headers', async (t) => {
    const f = await fixture(t, target)
    const client = f.send('headers-held')
    await until(() => f.mocks[0]?.bodyEnded, 'mock did not receive request')
    client.req.destroy()
    await until(() => client.closed, 'client socket did not close')
    await f.cancelled()
  })
  test(target.name + ' cancels a disconnect during restored SSE or pass-through', async (t) => {
    const f = await fixture(t, target)
    const client = f.send('sse-held', { abortOnData: true })
    await until(() => client.closed, 'SSE client did not disconnect')
    await f.cancelled()
  })
  test(target.name + ' cancels a buffered JSON response', async (t) => {
    const f = await fixture(t, target)
    const client = f.send('buffered-held', { stream: false })
    await until(() => f.upstreams[0]?.res, 'upstream JSON headers not received')
    client.req.destroy()
    await until(() => client.closed, 'buffered client did not disconnect')
    await f.cancelled()
  })
  test(target.name + ' completes normal SSE including terminal flush', async (t) => {
    const f = await fixture(t, target)
    await f.healthy()
  })
  test(target.name + ' completes normal buffered JSON', async (t) => {
    const f = await fixture(t, target)
    await f.healthy('json')
  })
  test(target.name + ' returns 502 for an upstream connection error before response', async (t) => {
    const f = await fixture(t, target)
    const client = f.send('connection-error')
    await until(() => client.ended, 'upstream failure did not produce a completed response')
    assert.equal(client.status, 502)
    assert.deepEqual(JSON.parse(client.text()), { error: 'Upstream proxy error' })
  })
  test(target.name + ' closes a truncated SSE without appending a JSON error', async (t) => {
    const f = await fixture(t, target)
    const client = f.send('truncate')
    await until(() => client.closed, 'truncated SSE client did not close')
    assert.equal(client.ended, false)
    assert.equal(client.status, 200)
    assert.ok(!client.text().includes('Upstream proxy error'))
    await f.cancelled()
  })
  test(target.name + ' permits healthy requests after repeated aborts on the same proxy and agents', async (t) => {
    const f = await fixture(t, target, { keepAlive: true })
    for (let i = 0; i < 3; i++) {
      const client = f.send('sse-held', { abortOnData: true })
      await until(() => client.closed, 'repeat abort client did not close')
      await f.cancelled(i)
    }
    await f.healthy()
    await f.healthy('json')
  })
  if (target.passthrough) continue
  for (const [name, options, text] of [
    ['identity', {}, 'Synthetic sample'],
    ['disabled filter', { enabled: false }, email],
  ]) {
    test(target.name + ' cancels SSE with ' + name, async (t) => {
      const f = await fixture(t, target, options)
      const client = f.send('sse-held', { text, abortOnData: true })
      await until(() => client.closed, 'identity SSE client did not close')
      await f.cancelled()
    })
  }
  test(target.name + ' suppresses upstream work when disconnected during an asynchronous filter', async (t) => {
    const f = await fixture(t, target, { gatedFilter: true })
    const client = f.send('json', { stream: false })
    await f.filterEntered
    client.req.destroy()
    await until(() => client.closed && f.downstreams[0]?.closed, 'filtering client did not disconnect')
    f.releaseFilter()
    await until(() => f.downstreams[0].settled, 'disconnected filter handler did not settle')
    assert.equal(f.upstreams.length, 0, 'upstream contacted after downstream disconnected during filtering')
    assert.equal(f.mocks.length, 0)
    await until(() => f.store.activeSessionCount() === 0, 'filtered aborted session remains active')
  })
}
