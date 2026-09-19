import type { PIIFilter } from '../../core/piiFilter.js'
import type { ApiAdapter } from '../types.js'
import { OpenAIStreamRestorer } from './streamRestorer.js'

export function createStreamRestorer(filter: PIIFilter): OpenAIStreamRestorer {
  const { mappingTable, restoreEncodedText } = filter.getStreamRestorationContext()
  return new OpenAIStreamRestorer(mappingTable, restoreEncodedText)
}

export const completionsApi: ApiAdapter = {
  paths: ['/v1/chat/completions'],
  filterRequest: (body, filter) => filter.filterRequestBody(body),
  createStreamRestorer,
}
