import { createHash } from 'node:crypto';
import { Agent, fetch as modelFetch } from 'undici';
import { nativeModelAdapter } from '../shared/nativeModelAdapter.js';
import { debugTraceContext } from './assistantDebugTrace.js';

// Model deadlines and user cancellation come from invokeGraphModel's AbortSignal.
const modelTransport = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const nameFor = name => 'tool_' + createHash('sha256').update(name).digest('hex').slice(0, 24);
const ollamaWireName = name => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? name
  : name.replace(/[^a-zA-Z0-9_]+/g, '_').slice(0, 45) + '_' + nameFor(name).slice(-8);
const loopback = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
export function boundedOllamaOptions(endpoint, options, env = process.env) {
  const cap = Number(env.LANGVISION_LOCAL_OLLAMA_CONTEXT);
  if (!Number.isInteger(cap) || cap < 2048 || cap > 262144 || !endpoint || !loopback(new URL(endpoint).hostname)) return options;
  return { ...options, num_ctx: Math.min(options?.num_ctx ?? cap, cap) };
}
function classifyOllamaError(message) {
  if (/jinja|system message must be|chat template/i.test(message)) return ['model_template', 'Ollama rejected the model chat template. Check the model template and native tool compatibility.'];
  if (/out of memory|allocat.*memory|vram/i.test(message)) return ['model_memory', 'Local Ollama ran out of memory. Reduce context or select a smaller model.'];
  if (/cuda/i.test(message)) return ['model_runner', 'Local Ollama reported a CUDA runner failure. Check the Ollama server log.'];
  if (/runner|llama-server/i.test(message)) return ['model_runner', 'The local Ollama model runner failed. Check the Ollama server log.'];
  return [];
}
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
    const local = !compatible && loopback(base.hostname);
    const harmony = !compatible && path.endsWith('/chat') && nativeModelAdapter(model).family === 'gpt-oss';
    const wireName = compatible ? nameFor : harmony ? ollamaWireName : name => name;
    const names = new Map((tools ?? []).map(tool => [wireName(tool.function.name), tool.function.name]));
    const ollamaMessages = harmony ? messages.map(message => ({
      ...message,
      ...(message.tool_name ? { tool_name: wireName(message.tool_name) } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map(call => ({ ...call, function: { ...call.function, name: wireName(call.function.name) } })) } : {}),
    })) : messages;
    const ollamaTools = harmony ? tools?.map(tool => {
      const original = tool.function.name;
      const name = wireName(original);
      return { ...tool, function: { ...tool.function, name,
        description: name === original ? tool.function.description : `LangVision tool ${original}. Call using the provided name ${name}. ${tool.function.description ?? ''}` } };
    }) : tools;
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
    } : { model, messages: ollamaMessages, tools: ollamaTools, format, options: boundedOllamaOptions(base.href, tuning), think, keep_alive: keepAlive, stream: false }
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
    if (harmony) debugTraceContext()?.capture?.('provider-wire-request', { aliases: [...names], body: requestBody });
    const response = await modelFetch(target, { dispatcher: modelTransport, method: requestBody ? 'POST' : 'GET', headers,
      body: requestBody ? JSON.stringify(requestBody) : undefined, signal: options.signal ?? AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) {
      let detail = '';
      let code;
      // Keep local Ollama runner failures actionable without echoing remote provider bodies.
      if (local) {
        const reader = response.body?.getReader();
        if (reader) {
          try {
            const chunks = [];
            let bytes = 0;
            while (bytes < 8192) {
              const { value, done } = await reader.read();
              if (done) break;
              chunks.push(Buffer.from(value.subarray(0, 8192 - bytes)));
              bytes += chunks.at(-1).length;
            }
            const raw = Buffer.concat(chunks).toString();
            let message = raw;
            try { const value = JSON.parse(raw).error; message = value?.message ?? value ?? raw; } catch {}
            [code, detail = ''] = classifyOllamaError(String(message));
          } catch { /* Keep the HTTP status if the provider error is not structured. */ }
          finally { await reader.cancel().catch(() => {}); }
        }
      }
      if (!code && path.endsWith('/chat') && response.status >= 500) {
        code = 'model_transport';
        detail = 'The model provider could not complete inference. Check its logs; graph retries cannot repair a provider failure.';
      }
      return json({ error: 'Model endpoint returned HTTP ' + response.status + '.' + (detail ? ' ' + detail : ''), ...(code ? { code } : {}) }, response.status);
    }
    const value = await response.json();
    if (harmony) debugTraceContext()?.capture?.('provider-wire-response', value);
    if (path.endsWith('/models') && compatible) return json({ models: (value.data ?? []).map(item => ({ name: item.id })) });
    if (harmony && value.message?.tool_calls) return json({ ...value, message: { ...value.message,
      tool_calls: value.message.tool_calls.map(({ function: fn, ...call }) => ({ ...call, function: { ...fn, name: names.get(fn.name) ?? fn.name } })),
    } });
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
    const transportCode = error.cause?.code ?? error.code;
    const detail = typeof transportCode === 'string' && /^[A-Z][A-Z0-9_]{0,59}$/.test(transportCode) ? ` (${transportCode})` : '';
    return json({ code: 'model_transport', error: 'Model gateway could not reach or read the selected endpoint' + detail + '. Check the provider and retry the turn.' }, 502);
  }
}
