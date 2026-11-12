export async function agentDesignRequest(path, { body, method = 'GET', signal } = {}) {
  const response = await fetch(`/api/assistant${path}`, { method, signal, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? 'Agent service is unavailable.');
  return payload;
}
