import { createServer, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { resolveApiAdapter } from '../api/index.js'
import { handleAnalyze } from './analyze.js'
import { handleControlRequest } from './control.js'
import { writeJson, writeProxyError } from './httpUtils.js'
import { getRequestPath } from './provider.js'
import { proxyFilteredRequest, proxyPassThrough } from './proxy.js'
import { RequestBodyTooLargeError } from './requestBody.js'
import { SessionFilterStore } from './sessionFilterStore.js'

export type ProxyServerOptions = {
  readonly sessionFilters?: SessionFilterStore
  readonly requestUpstream?: typeof httpsRequest
}

// Construction is separate from listening and process signal registration.
export function createProxyServer(options: ProxyServerOptions = {}): Server {
  const sessionFilters = options.sessionFilters ?? new SessionFilterStore()
  const requestUpstream = options.requestUpstream ?? httpsRequest

  return createServer(async (req, res) => {
    try {
      if (req.url === '/health' && req.method === 'GET') {
        writeJson(res, 200, { status: 'ok' })
        return
      }

      if (handleControlRequest(req, res, sessionFilters)) return

      const path = getRequestPath(req)
      if (req.method === 'POST' && path === '/analyze') {
        await handleAnalyze(req, res)
        return
      }

      const adapter = req.method === 'POST' ? resolveApiAdapter(path) : undefined
      if (adapter) {
        await proxyFilteredRequest(req, res, adapter, sessionFilters, requestUpstream)
        return
      }

      await proxyPassThrough(req, res, requestUpstream)
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        writeJson(res, 413, {
          error: `Request body exceeds the ${error.maxBytes}-byte limit`,
        })
        return
      }
      writeProxyError(res)
    }
  })
}
