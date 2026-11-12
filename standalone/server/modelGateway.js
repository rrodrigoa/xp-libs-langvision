import { createHash } from 'node:crypto';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const nameFor = name => 'tool_' + createHash('sha256').update(name).digest('hex').slice(0, 24);
function boundEnvironment(name) {
  if (!/^LANGVISION_SECRET_[A-Z0-9_]+$/.test(name ?? '') || !process.env[name]) {
    throw new Error('Select a configured LANGVISION_SECRET_ environment variable.');
  }
  return process.env[name];
}
export async function localModelGateway(resource, options = {}) {
  const path = new URL(resource).pathname;
  if (path === '/api/runs') return json({ workspaceRuns: [], activeRuns: [] });
  if (!path.startsWith('/api/ai/')) return json({ error: 'This product operation is not available in LangVision.' }, 404);
  try {
    const input = JSON.parse(options.body ?? '{}');
    const connection = input.connection;
    const compatible = !!connection || path === '/api/ai/openai/models';
    const base = new URL(connection?.baseUrlSource === 'environment' ? boundEnvironment(connection.baseUrlEnvironmentVariable) : input.baseAddress);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid model endpoint.');
    const tail = { '/api/ai/chat': compatible ? '/chat/completions' : '/api/chat',
      '/api/ai/ollama/models': '/api/tags', '/api/ai/openai/models': '/models',
      '/api/ai/ollama/show': '/api/show', '/api/ai/ollama/processes': '/api/ps' }[path];
    if (!tail) return json({ error: 'Unknown model operation.' }, 404);
    const headers = { 'Content-Type': 'application/json' };
    const key = connection?.authMode && connection.authMode !== 'none' && connection.apiKeySource === 'environment'
      ? boundEnvironment(connection.apiKeyEnvironmentVariable) : connection?.apiKey;
    if (key) {
      if (connection.authMode === 'api-key') headers['api-key'] = key;
      else if (connection.authMode === 'bearer') headers.Authorization = 'Bearer ' + key;
    }
    const { model, messages, tools, format, options: tuning, think, keepAlive } = input;
    const names = new Map((tools ?? []).map(tool => [nameFor(tool.function.name), tool.function.name]));
    const requestBody = path.endsWith('/chat') ? compatible ? {
      model, stream: false,
      messages: messages.map(({ tool_name: _name, tool_calls, ...message }) => ({
        ...message, ...(tool_calls ? { tool_calls: tool_calls.map(({ function: fn, ...call }) => ({
          ...call, function: { ...fn, name: nameFor(fn.name), arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments) },
        })) } : {}),
      })),
      ...(tools?.length ? { tools: tools.map(tool => ({ ...tool, function: { ...tool.function, name: nameFor(tool.function.name) } })) } : {}),
      ...(format ? { response_format: { type: 'json_object' } } : {}),
      ...(connection.sendSampling !== false && Number.isFinite(tuning?.temperature) ? { temperature: tuning.temperature } : {}),
      ...(connection.reasoningEffort ? { reasoning_effort: connection.reasoningEffort } : {}),
      ...(tuning?.num_predict ? { [connection.tokenLimitParameter ?? 'max_tokens']: tuning.num_predict } : {}),
    } : { model, messages, tools, format, options: tuning, think, keep_alive: keepAlive, stream: false }
      : path.endsWith('/show') ? { model } : undefined;
    const target = base.href.replace(/\/$/, '') + tail;
    if (!compatible && path.endsWith('/chat') && input.expectedDigest) {
      const tags = await fetch(base.href.replace(/\/$/, '') + '/api/tags', {
        signal: options.signal ?? AbortSignal.timeout(15000), redirect: 'error',
      });
      if (!tags.ok || !(await tags.json()).models?.some(item => (item.name ?? item.model) === model && item.digest === input.expectedDigest)) {
        return json({ error: 'The cached model no longer matches its saved digest.' }, 409);
      }
    }
    const response = await fetch(target, { method: requestBody ? 'POST' : 'GET', headers,
      body: requestBody ? JSON.stringify(requestBody) : undefined, signal: options.signal ?? AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) return json({ error: 'Model endpoint returned HTTP ' + response.status + '.' }, response.status);
    const value = await response.json();
    if (path.endsWith('/models') && compatible) return json({ models: (value.data ?? []).map(item => ({ name: item.id })) });
    if (!compatible || !path.endsWith('/chat')) return json(value);
    const message = value.choices?.[0]?.message;
    if (!message) return json({ error: 'Model returned no message.' }, 502);
    return json({ model: value.model, usage: value.usage, message: {
      ...message, ...(message.reasoning_content || message.reasoning ? { thinking: message.reasoning_content ?? message.reasoning } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map(({ function: fn, ...call }) => ({
        ...call, function: { ...fn, name: names.get(fn.name) ?? fn.name },
      })) } : {}),
    } });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return json({ error: 'Model gateway could not reach or read the selected endpoint.' }, 502);
  }
}
