import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http'

type UpstreamLifecycle = {
  readonly active: boolean
  trackRequest(request: ClientRequest): boolean
  trackResponse(response: IncomingMessage): boolean
  resolve(): void
  reject(error: Error): void
}

// Bind a single upstream exchange to its downstream response, not req.close:
// the latter also fires when the uploaded request body finishes normally.
export function withUpstreamLifecycle(
  downstream: ServerResponse,
  start: (lifecycle: UpstreamLifecycle) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let state: 'active' | 'complete' | 'cancelled' | 'failed' = 'active'
    let request: ClientRequest | undefined
    let response: IncomingMessage | undefined

    const detachDownstream = () => {
      downstream.removeListener('close', onDownstreamClose)
      downstream.removeListener('error', cancel)
    }
    const destroyUpstream = () => {
      response?.unpipe(downstream)
      response?.destroy()
      // Test/injected transports may only implement the writable interface.
      request?.destroy?.()
    }
    const cancel = () => {
      if (state !== 'active') return
      state = 'cancelled'
      detachDownstream()
      destroyUpstream()
      resolve()
    }
    const onDownstreamClose = () => {
      if (!downstream.writableFinished) cancel()
    }
    const fail = (error: Error) => {
      if (state !== 'active') return
      state = 'failed'
      detachDownstream()
      destroyUpstream()
      reject(error)
    }
    const lifecycle: UpstreamLifecycle = {
      get active() { return state === 'active' },
      resolve() {
        if (state !== 'active') return
        state = 'complete'
        detachDownstream()
        resolve()
      },
      reject: fail,
      trackRequest(upstream) {
        request = upstream
        const onClose = () => {
          upstream.removeListener('error', fail)
          if (!response && state === 'active') fail(new Error('Upstream closed before a response'))
        }
        // Keep error handlers until close: destroy() can emit ECONNRESET later.
        upstream.once('error', fail)
        upstream.once('close', onClose)
        if (state === 'cancelled' || state === 'failed') upstream.destroy?.()
        return state === 'active'
      },
      trackResponse(upstream) {
        response = upstream
        const onAborted = () => fail(new Error('Upstream response aborted'))
        const onClose = () => {
          upstream.removeListener('error', fail)
          upstream.removeListener('aborted', onAborted)
          if (!upstream.readableEnded && state === 'active') fail(new Error('Upstream response closed before end'))
        }
        upstream.once('error', fail)
        upstream.once('aborted', onAborted)
        upstream.once('close', onClose)
        if (state === 'cancelled' || state === 'failed') upstream.destroy()
        return state === 'active'
      },
    }

    // Filtering may have awaited local detection while the client disconnected.
    if (downstream.destroyed || downstream.closed || downstream.writableEnded) {
      cancel()
      return
    }
    downstream.once('close', onDownstreamClose)
    downstream.once('error', cancel)
    try {
      start(lifecycle)
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
