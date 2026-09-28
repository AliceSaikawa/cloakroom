import type { PIIFilter } from '../../core/piiFilter.js'
import type { ApiAdapter } from '../types.js'
import { StreamRestorer } from './streamRestorer.js'

export function createStreamRestorer(filter: PIIFilter): StreamRestorer {
  const { mappingTable, restoreEncodedText } = filter.getStreamRestorationContext()
  return new StreamRestorer(mappingTable, restoreEncodedText)
}

export const messagesApi: ApiAdapter = {
  paths: ['/v1/messages', '/v1/messages/count_tokens'],
  filterRequest: (body, filter) => filter.filterRequestBody(body),
  createStreamRestorer,
}
