import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default {
  name: 'ginza-ner',
  detect(text) {
    const result = spawnSync('python3', [join(__dirname, 'detect.py')], {
      input: text,
      encoding: 'utf8',
      timeout: 5000,
    })
    if (result.status !== 0 || !result.stdout) return []
    try {
      // detect.py returns {text, start, end, category}
      // FilterPluginMatch requires {value, start, end, category?, confidence?}
      return JSON.parse(result.stdout).map(m => ({
        value: m.text,
        start: m.start,
        end: m.end,
        category: m.category,
        confidence: 0.8,
      }))
    } catch {
      return []
    }
  },
}
