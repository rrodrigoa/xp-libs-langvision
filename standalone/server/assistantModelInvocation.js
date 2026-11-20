import { traceModelRequest } from './assistantDebugTrace.js';
import { modelConnectionForProfile } from './assistantStore.js';
import { modelTimeoutMs } from './assistantDeadlines.js';
import { boundedOllamaOptions } from './modelGateway.js';

export function invokeGraphModel({ fetchImpl, serviceBaseUrl, workflow, nodeId, body, profile, signal, traceMetadata }) {
  if (!workflow?.nodes?.some(node => node.id === nodeId)) throw new Error('Model calls require a pinned graph node.');
  const effective = profile?.provider === 'openai-compatible' ? body : { ...body, options: boundedOllamaOptions(body.baseAddress, body.options) };
  const request = { ...effective, expectedDigest: profile?.expectedDigest, ...(profile?.provider === 'openai-compatible' ? { connection: modelConnectionForProfile(profile) } : {}) };
  const timeoutMs = modelTimeoutMs(profile);
  const deadline = AbortSignal.timeout(timeoutMs);
  return traceModelRequest(effective, () => fetchImpl(new URL('/api/ai/chat', serviceBaseUrl), {
    method: 'POST', body: JSON.stringify(request), signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  }).catch(error => {
    if (deadline.aborted && !signal?.aborted) throw Object.assign(new Error(`Model '${profile?.model ?? body.model}' exceeded its ${timeoutMs / 1000}s request timeout.`, { cause: error }), { primitiveProviderFailure: true });
    throw error;
  }), { ...traceMetadata, timeoutMs });
}
