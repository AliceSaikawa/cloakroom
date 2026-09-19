import type { IncomingMessage, ServerResponse } from 'node:http'
import { PIIFilter } from '../core/piiFilter.js'
import { readBody, writeJson } from './httpUtils.js'

export async function handleAnalyze(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawBody = await readBody(req)

  let parsedBody: Record<string, unknown>
  try {
    parsedBody = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>
  } catch {
    writeJson(res, 400, { error: 'Invalid JSON body' })
    return
  }

  if (typeof parsedBody['text'] !== 'string') {
    writeJson(res, 400, { error: 'Expected JSON body with a string "text" field' })
    return
  }

  const filter = new PIIFilter()
  const detections = await filter.analyzeText(parsedBody['text'], {
    useOllama: parsedBody['useOllama'] === true,
  })

  writeJson(res, 200, { detections })
}
