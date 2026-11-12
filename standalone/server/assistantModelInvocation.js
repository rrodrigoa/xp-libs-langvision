import { traceModelRequest } from './assistantDebugTrace.js';
import { modelConnectionForProfile } from './assistantStore.js';

export function invokeGraphModel({ fetchImpl, serviceBaseUrl, workflow, nodeId, body, profile, signal, traceMetadata }) {
  if (!workflow?.nodes?.some(node => node.id === nodeId)) throw new Error('Model calls require a pinned graph node.');
  const request = { ...body, expectedDigest: profile?.expectedDigest, ...(profile?.provider === 'openai-compatible' ? { connection: modelConnectionForProfile(profile) } : {}) };
  const deadline = AbortSignal.timeout(profile?.timeoutMs ?? 120000);
  return traceModelRequest(body, () => fetchImpl(new URL('/api/ai/chat', serviceBaseUrl), {
    method: 'POST', body: JSON.stringify(request), signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  }), traceMetadata);
}
