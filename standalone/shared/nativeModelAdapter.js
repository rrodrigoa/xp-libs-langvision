export const DEFAULT_NATIVE_CALL_PROTOCOL = `Every response from this node must be a native function call, not final text or a JSON document in message.content. Use the supplied tool definitions. To finish, call finish_step with exit, result and evidenceReferences (actual request-ID strings); summary is optional. Put answerMarkdown inside finish_step.result, never directly in message.content. An exit is not selected by writing its name in prose. Inspect tool results before claiming an action succeeded. Follow the selected exit's evidence and result contracts; this protocol does not waive them. If received context is sufficient, reference its actual input/context paths. Otherwise request the relevant tool. Never invent observations or call IDs.`;

export const DRAFT_EXPLANATION_GUIDANCE = `For a request about the current saved draft, read it with creatio.inspect_draft using the bound draft/workspace ID before explaining it. For a running job use creatio.inspect_run instead. Explain the SQL actually returned. Canvas generatedSql and aiIntent may be stale authoring metadata, not compiler output. Do not invent compiler behavior, decoder behavior, missing-field rules or schema features; retrieve language guidance when those facts are needed. If evidence is unavailable, disclose that limitation.`;

export function nativeModelAdapter(model) {
  const family = /^gpt-oss(?:[:\-]|$)/i.test(model) ? 'gpt-oss' : /^qwen3(?:[.:\-]|$)/i.test(model) ? 'qwen3' : 'generic';
  return { id: `ollama-${family}-native-v1`, family, calls: 'message.tool_calls', contentIsExecutable: false };
}

// Ollama, not Chronusphaera, renders and parses Harmony/Qwen model templates.
// Never infer executable requests or finish_step from model-authored prose/JSON.
export function normalizeNativeModelResponse(value) {
  const message = value.message ?? {}, content = message.content ?? '';
  const fail = text => { throw Object.assign(new Error(text), { modelResponse: message }); };
  if ((value.doneReason ?? value.done_reason) === 'length') fail('Model generation limit reached before a complete native response. Increase this node\'s output-token limit; no returned action was executed.');
  const calls = message.toolCalls ?? message.tool_calls ?? [];
  if (!Array.isArray(calls)) fail('Native tool_calls must be an array.');
  const requests = calls.map(call => {
    let args = call.function?.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { fail('Native tool arguments are not valid JSON.'); } }
    if (typeof call.function?.name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) fail('Native tool call requires an exact function name and object arguments.');
    return { id: call.id ?? crypto.randomUUID(), name: call.function.name, arguments: args };
  });
  return { requests, message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content),
    tool_calls: requests.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } };
}
