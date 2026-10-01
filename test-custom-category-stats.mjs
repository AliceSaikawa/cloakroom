import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const projectDir = dirname(fileURLToPath(import.meta.url))
const testHome = mkdtempSync(join(tmpdir(), 'cloakroom-category-stats-'))
mkdirSync(join(testHome, '.claude'))
const configPath = join(testHome, '.claude', 'pii-filter.json')

// Use the real file loader and filtering modules. Only os.homedir is redirected
// so configuration and generated keys never touch the caller's home directory.
const bundle = await build({
  stdin: {
    contents: `
      export { createProxyServer } from './src/server/app.ts';
      export { loadPIIConfig, resetPIIConfigCache } from './src/core/config.ts';
      export { resetStats } from './src/core/stats.ts';
    `,
    resolveDir: projectDir,
    loader: 'ts',
  },
  bundle: true, platform: 'node', target: 'node22', format: 'esm', write: false,
  plugins: [{
    name: 'isolated-home',
    setup(builder) {
      builder.onResolve({ filter: /^node:os$/ }, () => ({ path: 'os', namespace: 'test-home' }))
      builder.onLoad({ filter: /.*/, namespace: 'test-home' }, () => ({
        contents: `export const homedir = () => ${JSON.stringify(testHome)};`, loader: 'js',
      }))
    },
  }],
})
const { createProxyServer, loadPIIConfig, resetPIIConfigCache, resetStats } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

async function listen(t, server) {
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${server.address().port}`
}

const providers = [
  { path: '/v1/messages', response: (text) => ({ content: [{ type: 'text', text }] }),
    text: (body) => body.content[0].text },
  { path: '/v1/chat/completions', response: (text) => ({ choices: [{ message: { content: text } }] }),
    text: (body) => body.choices[0].message.content },
]

for (const source of ['customPatterns', 'customCategories', 'dictionary']) {
  for (const category of ['EMPLOYEE', 'constructor', 'toString', '__proto__']) {
    test(`${source}: configured ${category} is masked, restored, and counted numerically`, async (t) => {
      resetStats()
      resetPIIConfigCache()
      t.after(() => { resetStats(); resetPIIConfigCache() })
      const values = ['EMP-0101', 'EMP-0102']
      const config = {
        enabled: true, categories: [], ollamaEnabled: false, heuristicNerEnabled: false,
        auditLog: { enabled: false }, vaultEnabled: false, fpe: { enabled: false },
        responseDetection: { enabled: false },
        customCategories: [{ name: category, placeholder: '従業員',
          ...(source === 'customCategories' ? { patterns: ['EMP-\\d{4}'] } : {}) }],
        customPatterns: source === 'customPatterns' ? [{ name: 'employee-id', category, pattern: 'EMP-\\d{4}' }] : [],
        dictionary: source === 'dictionary' ? values.map((text) => ({ text, category })) : [],
      }
      writeFileSync(configPath, JSON.stringify(config))
      assert.equal(loadPIIConfig().customCategories[0].name, category, 'the actual JSON file loader must accept the name')
      const calls = []
      const upstream = createServer(async (req, res) => {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        calls.push(body.messages[0].content)
        const provider = providers.find((entry) => entry.path === req.url)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(provider.response(body.messages[0].content)))
      })
      const upstreamOrigin = await listen(t, upstream)
      const proxy = createProxyServer({
        requestUpstream: (url, options, callback) => {
          const target = new URL(url)
          return request(upstreamOrigin + target.pathname, options, callback)
        },
      })
      const origin = await listen(t, proxy)
      async function get(path) {
        const res = await fetch(origin + path, { signal: AbortSignal.timeout(3000) })
        assert.equal(res.status, 200)
        return res
      }
      assert.ok((await (await get('/control/status')).json()).activeCategories.includes(category))
      const original = values.join(' ')
      let expectedCount = 0
      for (const provider of providers) {
        for (let round = 0; round < 2; round++) {
          const response = await fetch(origin + provider.path, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-pii-session-id': 'synthetic-session' },
            body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: original }] }),
            signal: AbortSignal.timeout(3000),
          })
          assert.equal(response.status, 200)
          assert.equal(provider.text(await response.json()), original)
          assert.deepEqual(calls.at(-1).split(' ').sort(), ['[従業員A]', '[従業員B]'])
          expectedCount += values.length
          const stats = await (await get('/control/stats')).json()
          const metrics = await (await get('/metrics')).text()
          const categorySamples = metrics.split('\n').filter((line) => line.startsWith('cloakroom_detections_total'))
          if (stats.detectionsByCategory[category] !== expectedCount) {
            t.diagnostic(JSON.stringify({ category, expectedCount, detections: stats.detectionsByCategory, categorySamples }))
          }
          assert.deepEqual(stats.detectionsByCategory, { [category]: expectedCount })
          assert.equal(typeof stats.detectionsByCategory[category], 'number')
          assert.deepEqual(categorySamples,
            [`cloakroom_detections_total{category="${category}"} ${expectedCount}`])
        }
      }
      assert.equal(calls.length, 4, 'every upstream request must use the localhost mock')
      resetStats()
      assert.deepEqual((await (await get('/control/stats')).json()).detectionsByCategory, {})
      assert.ok(!(await (await get('/metrics')).text()).includes('cloakroom_detections_total'))
    })
  }
}
