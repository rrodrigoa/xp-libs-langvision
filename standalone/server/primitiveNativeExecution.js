import { validateAgentSchema } from '../shared/agentJsonSchema.js';
import { resolvePrimitiveBinding } from '../shared/primitiveAgentModel.js';
import { FINISH_STEP, nativeExits, validateNativeFinish } from '../shared/primitiveNativeProtocol.js';
import {createHash} from 'node:crypto';

const edgeFor = (workflow, node, kind) => {
  const edges = workflow.edges.filter(edge => edge.source === node.id && edge.kind === kind);
  if (edges.length !== 1) throw new Error(`${node.label} requires exactly one saved '${kind}' transition.`);
  return edges[0].id;
};
const signature = calls => JSON.stringify(calls.map(({ name, arguments: args }) => ({ name, arguments: args })));
const toolMessage = (call, result) => ({ role: 'tool', tool_call_id: call.id, tool_name: call.name, content: JSON.stringify(result) });
function describeToolFailure(result) {
  if (result.success) return result;
  const code = result.errorCode ?? 'TOOL_FAILED';
  const correction = code === 'FILE_EDIT_REQUIRED' ? 'Write and obtain approval for the planned file edit; do not retry terminal.open yet.'
    : code === 'POWERSHELL_SYNTAX' ? 'Fix the reported parser line in the proposed script and submit the corrected edit. No file was written.'
    : code === 'RUNNER_PLATFORM_MISMATCH' ? 'Use an approved Windows terminal for host PowerShell. Do not retry a host command inside the Linux snapshot.'
    : code === 'SESSION_LIMIT' ? 'Reuse an open terminal. Close an unused terminal before requesting a new one.'
    : code === 'VERIFICATION_HANDOFF_REQUIRED' ? 'Select the saved verification exit with the file edit evidence.'
    : code === 'invalid_tool_arguments' || code === 'INVALID_ARGUMENT' ? 'Correct the arguments using the tool schema before issuing a new call.'
    : code === 'PERMISSION_DENIED' || code === 'SESSION_CLOSED' || code === 'SESSION_NOT_FOUND' ? 'Check the current grant or session. Do not retry unchanged.'
    : 'Use the error message and tool contract to change the next action. Do not repeat an unchanged failure or claim completion.';
  return { ...result, failure: { code, message: result.error, correction } };
}

// This checkpointed channel is not writable through model result/output mappings.
export async function executeNativePrimitive({ node, workflow, definition, state, config, input, adapters }) {
  if (node.handler !== 'llm' && !(node.handler === 'tool' && node.settings.mode === 'dispatch')) return null;
  const native = structuredClone(state.native ?? { sessions: {}, observations: [], pending: [], diagnostics: [] });
  const s = node.settings;
  try {
  if (node.handler === 'llm') {
    const session = native.sessions[node.id] ??= { input, transcript: [], calls: 0, repeated: 0, lastSignature: null, observationSignature: null };
    // Tool and Human back-edges append observations without replacing the model step's original input.
    const boundInput = session.input;
    native.callTotals ??= {};
    const total=native.callTotals[node.id]??session.calls;
    if (total >= s.maxModelCalls) throw Object.assign(new Error(`${node.label}: total model-call budget ${s.maxModelCalls} exhausted. Last diagnosis: ${native.diagnostics.at(-1)?.message ?? 'No verified completion was produced'}.`), { primitiveBudgetExhausted: true });
    if(s.maxNoProgressCalls && (session.stalledCalls??0)>=s.maxNoProgressCalls) throw Object.assign(new Error(`${node.label}: ${s.maxNoProgressCalls} calls without new successful tool evidence. Last diagnosis: ${native.diagnostics.at(-1)?.message??'No new authoritative observation'}.`),{primitiveBudgetExhausted:true});
    const errors = s.inputSchema ? validateAgentSchema(s.inputSchema, boundInput) : [];
    if (errors.length) throw new Error(`Input contract: ${errors.join('; ')}`);
    session.calls++;
    native.callTotals[node.id]=total+1;session.stalledCalls=(session.stalledCalls??0)+1;
    adapters.budget?.({totalCalls:total+1,hardLimit:s.maxModelCalls,callsWithoutProgress:session.stalledCalls,noProgressLimit:s.maxNoProgressCalls??null});
    const exitEvidence = nativeExits(workflow, node).flatMap(edge => [...(edge.evidenceChecks ?? []), ...(edge.evidenceAlternatives ?? []).flatMap(path => path.checks)].flatMap(contract => {
      const after = contract.afterTool ? native.observations.findLastIndex(item => item.success && item.name === contract.afterTool) : -1;
      const evidence = native.observations.findLast((item, index) => index > after && item.success && item.name === contract.toolName);
      return evidence ? [{ exit: edge.id, tool: evidence.name, requestId: evidence.requestId }] : [];
    }));
    const request = { native: true, workflow, node, purpose: s.purpose, systemPrompt: s.systemPrompt, exitEvidence,
      input: boundInput, inputSchema: s.inputSchema, responseSchema: s.responseSchema,
      ...(s.context ? { context: resolvePrimitiveBinding(s.context, state) } : {}),
      ...(s.context ? {
        latestObservation: native.observations.findLast(item => item.success && s.toolNames.includes(item.name) && item.name !== 'agent.report_progress'),
      } : {}),
      ...(s.toolNames.includes('agent.report_changes') && native.codeChanges ? { codeChanges: native.codeChanges } : {}),
      ...(s.toolNames.includes('agent.report_progress') && native.progress ? { progress: native.progress } : {}), transcript: session.transcript,
      profileId: s.profileId ?? workflow.profileId ?? definition.profileId, toolNames: [...s.toolNames] };
    const response = await adapters.model(request, { node, workflow, state, config });
    const calls = response.requests ?? [];
    if (!calls.length) {
      if (response.message) session.transcript.push(response.message);
      session.repeated = session.lastSignature === 'no-native-tool-call' ? session.repeated + 1 : 1;
      session.lastSignature = 'no-native-tool-call';
      const message = 'The model returned content but no native tool call. JSON/Markdown in message.content is not executable. Invoke a provided function through tool_calls, or call finish_step with exit, result and evidenceReferences. The rejected response is preserved in this attempt and recovery transcript.';
      throw Object.assign(new Error(session.repeated > s.maxRepeatedCalls ? `${message} Repeated protocol failure (${session.repeated} attempts; configured limit ${s.maxRepeatedCalls}). Edit the node native-call instructions or model profile before retrying.` : message), { modelResponse: response.message, ...(session.repeated > s.maxRepeatedCalls ? { primitiveBudgetExhausted: true } : {}) });
    }
    if (calls.length > 32 || new Set(calls.map(call => call.id)).size !== calls.length || calls.some(call => typeof call.id !== 'string' || !call.id || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments))) throw new Error('Invalid native tool-call identities or arguments.');
    session.transcript.push(response.message);
    if (s.requirePlan && !(native.planReported || native.progress?.tasks?.length) && calls.some(call => call.name !== 'agent.report_progress' && !(s.planExemptTools??[]).includes(call.name)))
      throw new Error('First report the requested customer outcomes with agent.report_progress and stable task IDs. Product actions and completion follow the saved plan.');
    const nextSignature = signature(calls.map(call => call.name === FINISH_STEP ? { ...call, arguments: { exit: call.arguments.exit, evidenceReferences: call.arguments.evidenceReferences } } : call));
    const observed = JSON.stringify(native.observations.slice(-calls.length).map(({ name, success, result, error }) => ({ name, success, result, error })));
    session.repeated = nextSignature === session.lastSignature && observed === session.observationSignature ? session.repeated + 1 : 1;
    session.lastSignature = nextSignature;
    session.observationSignature = observed;
    if (session.repeated > s.maxRepeatedCalls) throw Object.assign(new Error(`Repeated action without new evidence (${session.repeated} attempts). Last issue: ${native.diagnostics.at(-1)?.message ?? 'No change in tool evidence.'}`), { primitiveBudgetExhausted: true });
    const finishes = calls.filter(call => call.name === FINISH_STEP);
    if (finishes.length) {
      if (calls.length !== 1) throw new Error('finish_step cannot be combined with other tool requests. Inspect their results before finishing.');
      const call = finishes[0];
      try {
        const edge = validateNativeFinish(call, workflow, node, native.observations, { input: boundInput, ...(s.context ? { context: request.context } : {}) });
        const target = workflow.nodes.find(target => target.id === edge.target);
        if (edge.id === 'ready_to_verify' && native.codeChanges?.some(change => ['pending', 'active'].includes(change.status))) throw new Error('Update the code-change snapshot with evidence for the current change, then finish the remaining changes before verification.');
        const unfinished = native.progress?.tasks?.filter(task => !['completed', 'blocked', 'canceled'].includes(task.status)) ?? [];
        if (s.requirePlan && target?.handler === 'end' && unfinished.length) throw new Error(`Call agent.report_progress with the full checklist before finishing. Still open: ${unfinished.map(task => `${task.id} (${task.title})`).join(', ')}. Use actual evidence or explicitly explain why a task is blocked or out of scope.`);
        adapters.nativeDecision?.(call, { node, workflow, state }, { status: 'completed', edgeId: edge.id, nextNodeId: edge.target });
        session.transcript.push(toolMessage(call, { success: true, exit: edge.id }));
        // A later invocation of this node starts a new step; evidence remains immutable.
        if (target?.handler === 'human') native.origin = node.id;
        else delete native.sessions[node.id];
        return { native, result: call.arguments.result, route: edge.id };
      } catch (error) {
        adapters.nativeDecision?.(call, { node, workflow, state }, { status: 'failed', error: error.message });
        session.transcript.push(toolMessage(call, { success: false, error: error.message }));
        throw Object.assign(error, { nativeState: native });
      }
    }
    const unavailable = calls.filter(call => !s.toolNames.includes(call.name)).map(call => call.name);
    if (unavailable.length) {
      const exits = nativeExits(workflow, node);
      const exit = unavailable.find(name => exits.some(edge => edge.id === name));
      throw new Error(exit
        ? `'${exit}' is a saved exit, not a tool. Call the native tool finish_step with exit="${exit}", result matching its schema, and evidenceReferences.`
        : `The model requested an unavailable tool: ${unavailable.join(', ')}. Available: ${[...s.toolNames, FINISH_STEP].join(', ')}.`);
    }
    native.originAttempt = adapters.nativeRequests?.(calls, { node, workflow, state });
    native.pending = calls; native.origin = node.id;
    return { native, result: { requests: calls }, route: edgeFor(workflow, node, 'tools') };
  }
  if (node.handler === 'tool' && s.mode === 'dispatch') {
    if (!native.pending.length || !native.origin) throw new Error('No checkpointed native requests to dispatch.');
    const origin = workflow.nodes.find(item => item.id === native.origin && item.handler === 'llm');
    if (!origin || native.pending.some(call => !s.toolNames.includes(call.name) || !origin.settings.toolNames.includes(call.name))) throw new Error('Tool execution is outside the saved node availability.');
    let prepared;
    try {
      prepared = await adapters.prepareTools(native.pending.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })), { node, workflow, state, config });
    } catch (error) {
      const results = native.pending.map(call => describeToolFailure({ requestId: call.id, name: call.name, success: false, error: error.message, errorCode: error.code }));
      appendResults(native, results);
      return { native, result: { results }, route: edgeFor(workflow, node, 'result') };
    }
    native.pending = prepared.requests;
    if (prepared.requiresApproval && !native.approved) return { native, result: prepared, route: edgeFor(workflow, node, 'approval') };
    const output = await adapters.executeTools(native.pending, { node, workflow, state, config });
    appendResults(native, output.results);
    return { native, result: output, route: edgeFor(workflow, node, 'result') };
  }
  return null;
  } catch (error) {
    const session = native.sessions[node.id];
    if (session) {
      const answered = new Set(session.transcript.filter(message => message.role === 'tool').map(message => message.tool_call_id));
      for (const message of [...session.transcript]) for (const call of message.tool_calls ?? []) if (!answered.has(call.id)) {
        session.transcript.push(toolMessage({ id: call.id, name: call.function.name }, { success: false, error: error.message })); answered.add(call.id);
      }
    }
    error.nativeState ??= native; throw error;
  }
}

export function appendResults(native, results) {
  const session = native.sessions[native.origin];
  if (!session) throw new Error('Tool results have no originating model attempt.');
  for (const observation of results) {
    const result = describeToolFailure(observation);
    const request = native.pending.find(call => call.id === result.requestId);
    if (!request) throw new Error('Tool result has no matching request identity.');
    native.observations.push(structuredClone(result));
    if(result.success && !['agent.report_progress', 'agent.report_status'].includes(result.name)) {
      const canonical=value=>value && typeof value==='object'?Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
      const key=createHash('sha256').update(JSON.stringify(canonical({name:result.name,result:result.result}))).digest('hex');
      session.progressKeys??=[];
      if(!session.progressKeys.includes(key)){session.progressKeys.push(key);session.stalledCalls=0;}
    }
    if (result.name === 'agent.report_progress' && result.success) {
      native.progress = structuredClone(result.result);
      native.planReported ||= Boolean(native.progress.tasks?.length);
    }
    if (result.name === 'agent.report_changes' && result.success) native.codeChanges = structuredClone(result.result.changes);
    if (result.name === 'workspace.edit' && result.success && result.appliedCodeChanges) native.codeChanges = structuredClone(result.appliedCodeChanges);
    session.transcript.push(toolMessage(request, result));
  }
  native.pending = []; native.approved = false;
}

export function nativeHumanResult(nativeState, result, node) {
  const native = structuredClone(nativeState);
  if (node.settings.kind === 'approval') {
    native.approved = result.approved === true;
    if (!native.approved) appendResults(native, native.pending.map(call => ({ requestId: call.id, name: call.name, success: false, userFeedback: result.response, error: `The user rejected this exact prepared action. Do not report it as executed. Feedback: ${result.response}` })));
  } else {
    const session = native.sessions[native.origin];
    if (session) session.transcript.push({ role: 'user', content: JSON.stringify({ clarification: result.response }) });
  }
  return native;
}
