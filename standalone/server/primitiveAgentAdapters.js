import { createHash, randomUUID } from 'node:crypto';
import { assistantDebugDatabase, addMessage, getConversation, createAssistantClarification, getAssistantClarification, resolveAssistantClarification, createToolCall, updateToolCall, setConversationState, setAssistantTurnStatus, recordWorkspaceAuditEvent } from './assistantStore.js';
import { capabilityByName, validateCapabilityArguments } from './assistantCapabilities.js';
import { invokeGraphModel } from './assistantModelInvocation.js';
import { traceNode, debugTraceContext, executionNodeContext, linkDebugToolCall } from './assistantDebugTrace.js';
import { beginExecutionSpan, endExecutionSpan } from './assistantSpans.js';
import { readPrimitivePath, resolvePrimitiveBinding } from '../shared/primitiveAgentModel.js';
import { nativeFinishTool, nativeModelMessages } from '../shared/primitiveNativeProtocol.js';
import { nativeModelAdapter, normalizeNativeModelResponse } from '../shared/nativeModelAdapter.js';
import { PROGRESS_CAPABILITY, PROGRESS_TOOL } from '../shared/agentExperience.js';
import { validateAgentSchema } from '../shared/agentJsonSchema.js';
import { HISTORY_TOOLS } from '../shared/agentHistoryProtocol.js';
import { readAgentHistory } from './assistantHistoryTools.js';
import { modelPresentation } from '../shared/agentWaterfall.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const skillTools = ['skills.list', 'skills.search', 'skills.read', 'skills.reference'];
export const PRIMITIVE_KNOWLEDGE_TOOLS = [
  ['skills.list', 'List concise metadata for the skills in this pinned agent revision. Does not load skill bodies.', [], {}],
  ['skills.search', 'Find relevant skill metadata by words, for example {"query":"MATCH provenance"}. Read selected results with skills.read.', ['query'], { query: { type: 'string', minLength: 1, description: 'Product or language topic to discover.' } }],
  ['skills.read', 'Read one pinned skill body, for example {"id":"chronusql"}. References remain metadata until explicitly requested.', ['id'], { id: { type: 'string', minLength: 1, description: 'Exact ID returned by skills.search or skills.list.' } }],
  ['skills.reference', 'Read a reference belonging to one pinned skill, for example {"id":"chronusql","reference":"windows"}.', ['id', 'reference'], { id: { type: 'string', minLength: 1 }, reference: { type: 'string', minLength: 1 } }]
].map(([name, description, required, properties]) => ({ name, description, risk: 'read', version: 1, schema: { type: 'object', required, properties, additionalProperties: false } }));
export const PRIMITIVE_DISCOVERY_TOOLS = [
  { name: 'tools.list', description: 'List concise metadata for tools permitted to this node; does not grant additional tools.', risk: 'read', version: 1, schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'tools.describe', description: 'Read the authoritative argument schema and risk of one permitted tool. Example: {"name":"creatio.inspect_input_schemas"}.', risk: 'read', version: 1, schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false } }
];
export const PRIMITIVE_REGISTERED_TOOLS = [...PRIMITIVE_KNOWLEDGE_TOOLS, ...PRIMITIVE_DISCOVERY_TOOLS, PROGRESS_CAPABILITY, ...HISTORY_TOOLS];
const tool = name => capabilityByName(name) ?? PRIMITIVE_REGISTERED_TOOLS.find(item => item.name === name);

export function primitivePersistence() {
  const db = assistantDebugDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS ai_primitive_calls (
    execution_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    request_json TEXT NOT NULL, revision_json TEXT, approval_required INTEGER NOT NULL,
    approved INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, result_json TEXT,
    PRIMARY KEY(execution_id,request_id));
    CREATE TABLE IF NOT EXISTS ai_primitive_humans (
    execution_id TEXT NOT NULL, node_id TEXT NOT NULL, step INTEGER NOT NULL,
    clarification_id TEXT NOT NULL, requests_json TEXT NOT NULL,
    PRIMARY KEY(execution_id,node_id,step));
    CREATE TABLE IF NOT EXISTS ai_primitive_human_instances (
    execution_id TEXT NOT NULL, invocation_id TEXT NOT NULL, node_id TEXT NOT NULL, step INTEGER NOT NULL,
    clarification_id TEXT NOT NULL, requests_json TEXT NOT NULL,
    PRIMARY KEY(execution_id,invocation_id,node_id,step));
    CREATE TABLE IF NOT EXISTS ai_primitive_runs (
    execution_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, definition_json TEXT NOT NULL);`);
  return db;
}
export function savePrimitiveRun(executionId, conversationId, definition) {
  primitivePersistence().prepare('INSERT INTO ai_primitive_runs VALUES (?,?,?)').run(executionId, conversationId, JSON.stringify(definition));
}
export function primitiveRun(executionId) {
  const row = primitivePersistence().prepare('SELECT * FROM ai_primitive_runs WHERE execution_id=?').get(executionId);
  return row ? { executionId, conversationId: row.conversation_id, definition: JSON.parse(row.definition_json) } : null;
}

export function createPrimitiveAdapters({ definition, fetchImpl, serviceBaseUrl, toolHost, emit = () => {} }) {
  const execution = config => toolHost.executionContext(config.signal);
  const metadata = state => ({ conversationId: state.identity.conversationId, userMessageId: state.identity.userMessageId, turnId: state.identity.turnId });
  const skills = definition.resources?.skills ?? [];
  const readSkill = request => {
    const args = request.arguments;
    if (request.name === 'skills.list') return skills.map(({ body, references, ...item }) => ({ ...item, hash: hash({ body, references }) }));
    if (request.name === 'skills.search') {
      if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('skills.search requires query.');
      const terms = args.query.toLowerCase().split(/\W+/).filter(Boolean);
      return skills.map(skill => ({ skill, score: terms.filter(term => `${skill.title} ${skill.description} ${skill.body}`.toLowerCase().includes(term)).length }))
        .filter(item => item.score).sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id)).slice(0, 12)
        .map(({ skill, score }) => ({ id: skill.id, title: skill.title, description: skill.description, version: skill.version, hash: hash(skill), score }));
    }
    const skill = skills.find(item => item.id === args.id);
    if (!skill) throw new Error(`Skill '${args.id}' is not in this pinned revision.`);
    if (request.name === 'skills.read') return { ...skill, references: (skill.references ?? []).map(({ body, ...reference }) => ({ ...reference, hash: hash(body) })), hash: hash(skill) };
    const reference = skill.references?.find(item => item.id === args.reference);
    if (!reference) throw new Error('The requested pinned skill reference does not exist.');
    return { skillId: skill.id, version: skill.version, ...reference, hash: hash(reference) };
  };
  return {
    budget(value) { debugTraceContext()?.capture?.('model-call-budget',value); },
    nativeRequests(calls) {
      for (const call of calls) {
        const span = beginExecutionSpan(executionNodeContext(), 'tool-request', call.name, { nativeCallId: call.id, toolCallId: call.id, executed: false });
        debugTraceContext()?.capture?.('native-tool-request', { requestId: call.id, name: call.name, arguments: call.arguments, executed: false });
        endExecutionSpan(span, 'requested');
      }
    },
    nativeDecision(call, { node, state }, outcome) {
      const span = beginExecutionSpan(executionNodeContext(), 'decision', `finish_step -> ${call.arguments.exit}`, { nativeCallId: call.id, toolCallId: call.id, ...outcome });
      debugTraceContext()?.capture?.('native-step-decision', { requestId: call.id, nodeId: node.id, ...call.arguments, ...outcome });
      endExecutionSpan(span, outcome.status);
    },
    async model(request, { node, workflow, state, config }) {
      const profile = request.profileId ? state.identity.profiles?.[request.profileId] : state.identity.defaultProfile;
      if (!profile) throw new Error(`Select a model profile for '${node.label}'.`);
      const tools = request.toolNames.map(name => {
        const capability = tool(name);
        if (!capability) throw new Error(`Unknown registered tool '${name}'.`);
        return { type: 'function', function: { name, description: capability.description, parameters: request.native ? capability.nativeSchema ?? capability.schema : capability.schema } };
      });
      if (request.native) tools.push(nativeFinishTool(workflow, node));
      const messages = request.native ? nativeModelMessages(request) : [{ role: 'system', content: request.systemPrompt }, { role: 'user', content: JSON.stringify({ input: request.input, ...(request.availableActions ? { availableActions: request.availableActions } : {}) }) }];
      const adapter = { ...nativeModelAdapter(profile.model), provider: profile.provider ?? 'ollama' };
      if (profile.provider === 'openai-compatible') adapter.id = `openai-compatible-${adapter.family}-native-v1`;
      debugTraceContext()?.capture?.('context-assembly', { messages, profile, adapter, skillsInjected: false, availableTools: request.toolNames });
      const response = await invokeGraphModel({ fetchImpl, serviceBaseUrl, workflow, nodeId: node.id, profile, signal: config.signal,traceMetadata:{profileId:profile.id,provider:profile.provider??'ollama',digest:profile.expectedDigest??null,adapterId:adapter.id},
        body: { baseAddress: profile.baseUrl, model: profile.model, messages, tools, ...(!request.native ? { format: request.responseSchema } : {}),
          think: profile.think, thinkingMode: profile.provider === 'openai-compatible' ? profile.reasoningEffort || 'provider-default' : profile.thinkingMode, options: { num_ctx: profile.numCtx, temperature: profile.temperature ?? 0, seed: profile.seed ?? 42, ...(request.native ? { num_predict: node.settings.maxOutputTokens ?? 8192 } : {}) }, keepAlive: profile.keepAlive } });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? `Model HTTP ${response.status}`);
      const calls = value.message?.toolCalls ?? value.message?.tool_calls ?? [];
      if (calls.length && !tools.length) throw new Error('This LLM node has no tool availability.');
      const content = value.message?.content;
      const text = typeof content === 'string' ? content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() : content;
      if (typeof text === 'string' && /<\/?think>/i.test(text)) throw new Error('Malformed private reasoning markup in model output.');
      const thinking = modelPresentation([{section:'model-response',value:{callId:'chat',body:value}}],'chat').thinking;
      if (typeof thinking === 'string' && thinking.trim() && state.identity.conversationId) {
        const message = addMessage(state.identity.conversationId,'assistant','',state.identity.surface,{...metadata(state),...executionNodeContext(),messageKind:'model-activity',providerThinking:thinking,model:profile.model,toolCalls:calls});
        emit(state.identity.conversationId,'assistant-message',{message});
      }
      if (request.native) {
        const result = normalizeNativeModelResponse({ ...value, message: { ...value.message, content: text } });
        debugTraceContext()?.capture?.('native-model-normalization', { adapter, ...result });
        return result;
      }
      const result = text ? typeof text === 'object' ? text : JSON.parse(text) : {};
      if (calls.length) {
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Tool-planning output must be a JSON object.');
        result.requests = calls.map(call => ({ id: call.id ?? randomUUID(), name: call.function.name, arguments: typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments }));
      }
      return result;
    },
    async prepareTools(requests, { node, state, config }) {
      const db = primitivePersistence(), prepared = [];
      const preparation=beginExecutionSpan(executionNodeContext(),'preparation','Validate and prepare tool requests');
      try {
      for (const request of requests) {
        if(request.name.startsWith('web.')) {
          const count=db.prepare("SELECT COUNT(*) n FROM ai_primitive_calls WHERE execution_id=? AND request_id<>? AND json_extract(request_json,'$.name') LIKE 'web.%'").get(state.identity.userMessageId,request.id).n;
          if(count>=Number(process.env.CHRONUS_RESEARCH_MAX_CALLS??12))throw new Error('The per-turn web research budget is exhausted.');
        }
        const capability = tool(request.name);
        if (!capability) throw new Error(`Unknown registered tool '${request.name}'.`);
        if (!state.identity.conversationId && !['read', 'navigate'].includes(capability.risk)) throw new Error('A conversation and human approval are required for mutations.');
        const errors = validateCapabilityArguments(node.operationVersion === 2 && capability.nativeSchema ? { ...capability, schema: capability.nativeSchema } : capability, request.arguments);
        if (errors.length) throw Object.assign(new Error(`Invalid arguments for '${request.name}': ${errors.join('; ')}. Read this tool's native definition or call tools.describe with {"name":"${request.name}"}; the registered schema is authoritative. Argument schema: ${JSON.stringify(capability.nativeSchema??capability.schema)}`), { code: 'invalid_tool_arguments' });
        const revision = capability.revision ? await capability.revision(request.arguments, execution(config)) : null;
        const fingerprint = hash({ request, revision });
        const previous = db.prepare('SELECT * FROM ai_primitive_calls WHERE execution_id=? AND request_id=?').get(state.identity.userMessageId, request.id);
        if (previous && previous.fingerprint !== fingerprint) throw Object.assign(new Error(`Request ID '${request.id}' was reused with different arguments or revision. Use a new request ID.`), { code: 'tool_request_identity_conflict' });
        const approvalRequired = !['read', 'navigate'].includes(capability.risk) || (node.settings.approvalRisks ?? []).includes(capability.risk);
        if (!previous) db.prepare('INSERT INTO ai_primitive_calls(execution_id,request_id,fingerprint,request_json,revision_json,approval_required,status) VALUES(?,?,?,?,?,?,?)')
          .run(state.identity.userMessageId, request.id, fingerprint, JSON.stringify(request), JSON.stringify(revision), Number(approvalRequired), 'prepared');
        const previousResults = approvalRequired ? db.prepare("SELECT request_json,result_json FROM ai_primitive_calls WHERE execution_id=? AND request_id<>? AND status='completed'").all(state.identity.userMessageId, request.id)
          .filter(row => { const prior = JSON.parse(row.request_json); return prior.name === request.name && hash(prior.arguments) === hash(request.arguments); })
          .map(row => ({ requestId: JSON.parse(row.request_json).id, ...JSON.parse(row.result_json) })) : [];
        prepared.push({ ...request, fingerprint, expectedRevision: revision, risk: capability.risk, approvalRequired, ...(previousResults.length ? { previousResults, repeatedAction: true } : {}) });
      }
      const result={ requests: prepared, requiresApproval: prepared.some(request => request.approvalRequired) };
      debugTraceContext()?.capture('tool-preparation',result);
      endExecutionSpan(preparation,'completed');return result;
      } catch(error) {endExecutionSpan(preparation,'failed');throw error;}
    },
    async executeTools(requests, { node, workflow, workflowId, state, config }) {
      const db = primitivePersistence(), results = [];
      for (const request of requests) {
        config.signal?.throwIfAborted();
        const row = db.prepare('SELECT * FROM ai_primitive_calls WHERE execution_id=? AND request_id=?').get(state.identity.userMessageId, request.id);
        if (!row || row.fingerprint !== request.fingerprint) throw new Error('Execute requires an unchanged prepared request.');
        const saved = JSON.parse(row.request_json);
        if (hash({ request: { id: request.id, name: request.name, arguments: request.arguments }, revision: JSON.parse(row.revision_json) }) !== row.fingerprint) throw new Error('Prepared arguments were modified.');
        if (row.approval_required && !row.approved) throw new Error(`Approval of exact request '${request.id}' is required.`);
        if (row.status === 'completed' || row.status === 'failed') {
          const cached=JSON.parse(row.result_json),span=beginExecutionSpan(executionNodeContext(),'tool',request.name,{toolCallId:request.id,reused:true});
          debugTraceContext()?.capture('native-tool-input',{requestId:request.id,name:request.name,arguments:request.arguments});debugTraceContext()?.capture('native-tool-result',cached);
          endExecutionSpan(span,row.status);results.push(cached);continue;
        }
        if (row.status === 'executing') throw new Error(`Request '${request.id}' has an unknown outcome after interruption. Reconcile it before retrying; it will not be replayed.`);
        const capability = tool(saved.name);
        if (capability.revision && hash(await capability.revision(saved.arguments, execution(config))) !== hash(JSON.parse(row.revision_json))) throw Object.assign(new Error('Product revision changed after preparation. Prepare a new request.'), { code: 'product_revision_stale' });
        const claimed = db.prepare("UPDATE ai_primitive_calls SET status='executing' WHERE execution_id=? AND request_id=? AND status='prepared'").run(state.identity.userMessageId, request.id).changes;
        if (claimed !== 1) throw new Error('This request is already executing.');
        let result;
        const spanId=beginExecutionSpan(executionNodeContext(),skillTools.includes(saved.name)?'skill':'tool',saved.name,{toolCallId:saved.id});
        debugTraceContext()?.capture('native-tool-input',{requestId:saved.id,name:saved.name,arguments:saved.arguments});
        try {
          if (saved.name === PROGRESS_TOOL) {
            const prior = state.native?.progress;
            const tasks = structuredClone(saved.arguments.tasks ?? prior?.tasks ?? []);
            if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('Task IDs must be unique.');
            const removed = (prior?.tasks ?? []).filter(task => !tasks.some(next => next.id === task.id));
            if (removed.length && !saved.arguments.planChangeReason?.trim()) throw new Error('Removing outcomes requires planChangeReason. Send the complete revised task list, including unchanged tasks.');
            for (const task of tasks) {
              const verified = prior?.tasks?.find(previous=>previous.id===task.id && previous.title===task.title && previous.status==='completed');
              if (task.status==='completed' && task.evidenceReferences===undefined && verified) task.evidenceReferences=structuredClone(verified.evidenceReferences);
              if (task.status === 'completed' && !task.evidenceReferences?.some(id => state.native?.observations?.some(observation => observation.success && observation.name !== PROGRESS_TOOL && [observation.requestId, observation.toolCallId].includes(id)))) throw new Error(`Completed task '${task.title}' requires an actual successful observation reference.`);
              if (['blocked','canceled'].includes(task.status) && !task.reason?.trim()) throw new Error('Blocked or canceled outcomes need an explanation.');
            }
            const currentTaskId = saved.arguments.currentTaskId ?? (tasks.filter(task=>task.status==='active').length===1 ? tasks.find(task=>task.status==='active').id : null);
            if (currentTaskId && !tasks.some(task=>task.id===currentTaskId && task.status==='active')) throw new Error('currentTaskId must identify an active task in this plan, or be null.');
            const progress = { ...saved.arguments, tasks, currentTaskId, ...(removed.length ? { removedTasks: removed } : {}) };
            if (state.identity.turnId && (workflow === definition || workflowId === 'assistant')) db.transaction(() => {
              db.prepare('UPDATE ai_turns SET current_task_id=? WHERE turn_id=?').run(currentTaskId?`${state.identity.turnId}-outcome-${currentTaskId}`:null,state.identity.turnId);
              for (const task of removed) db.prepare("UPDATE ai_turn_tasks SET status='removed',error=?,updated_at=? WHERE task_id=?").run(saved.arguments.planChangeReason, new Date().toISOString(), `${state.identity.turnId}-outcome-${task.id}`);
              for (const [index, task] of tasks.entries()) {
              const taskId = `${state.identity.turnId}-outcome-${task.id}`;
              const ordinal = index + 1;
              db.prepare(`INSERT INTO ai_turn_tasks(task_id,turn_id,ordinal,title,surface,expected_tools_json,status,error,created_at,updated_at) VALUES(?,?,?,?,?,'[]',?,?,?,?)
                ON CONFLICT(task_id) DO UPDATE SET title=excluded.title,ordinal=excluded.ordinal,status=excluded.status,updated_at=excluded.updated_at,error=excluded.error`).run(taskId, state.identity.turnId, ordinal, task.title, state.identity.surface ?? 'creatio', task.status === 'blocked' ? 'needs-attention' : task.status, task.reason ?? null, new Date().toISOString(), new Date().toISOString());
            } })();
            const message = state.identity.conversationId ? addMessage(state.identity.conversationId, 'assistant', progress.summary, state.identity.surface, { ...metadata(state), progress, messageKind: 'progress' }) : null;
            recordWorkspaceAuditEvent({ workspaceId: state.identity.workspaceId, kind: 'agent-progress', title: 'Task and progress update', summary: progress.summary, status: 'completed', surface: 'ai', signature: saved.id, metadata: { ...metadata(state), ...executionNodeContext(), progress, requestId: saved.id } });
            if (message) emit(state.identity.conversationId, 'assistant-message', { message });
            if (state.identity.conversationId) emit(state.identity.conversationId, 'task-updated', { turnId: state.identity.turnId });
            result = { requestId: saved.id, name: saved.name, success: true, result: progress };
          }
          else if (HISTORY_TOOLS.some(item => item.name === saved.name)) result = { requestId:saved.id,name:saved.name,success:true,result:readAgentHistory(saved.name,saved.arguments,state.identity) };
          else if (PRIMITIVE_DISCOVERY_TOOLS.some(item => item.name === saved.name)) {
            const origin = workflow.nodes.find(item => item.id === state.native?.origin) ?? node;
            const permitted = origin.settings.toolNames.filter(name => node.settings.toolNames.includes(name));
            if (saved.name === 'tools.describe' && !permitted.includes(saved.arguments.name)) throw new Error('The requested tool is not permitted to this node.');
            const entries = (saved.name === 'tools.describe' ? [saved.arguments.name] : permitted).map(name => tool(name));
            result = { requestId: saved.id, name: saved.name, success: true, result: entries.map(item => ({ name: item.name, description: item.description, risk: item.risk, version: item.version, ...(saved.name === 'tools.describe' ? { schema: node.operationVersion === 2 ? item.nativeSchema ?? item.schema : item.schema } : {}) })) };
          }
          else if (skillTools.includes(saved.name)) result = { requestId: saved.id, name: saved.name, success: true, result: readSkill(saved) };
          else {
            const message = addMessage(state.identity.conversationId, 'assistant', `Execute ${saved.name}.`, state.identity.surface, { ...metadata(state), requestId: saved.id });
            let call = createToolCall({ conversationId: state.identity.conversationId, messageId: message.id, capability, args: saved.arguments,
              preview: capability.preview?.(saved.arguments), expectedRevision: JSON.parse(row.revision_json), requiresApproval: false });
            if (row.approved) call = updateToolCall(call.id, 'executing', { approved: true });
            linkDebugToolCall(call); emit(state.identity.conversationId, 'tool-call', { toolCall: call });
            const outcome = await toolHost.executeTool(call, capability, saved.arguments, execution(config), state.identity.surface);
            result = { requestId: saved.id, toolCallId: call.id, name: saved.name, success: outcome.ok, ...(outcome.ok ? { result: outcome.result } : { error: outcome.error.message }) };
          }
        } catch (error) { result = { requestId: saved.id, name: saved.name, success: false, error: error.message }; }
        debugTraceContext()?.capture('native-tool-result',result);
        endExecutionSpan(spanId,result.success?'completed':'failed');
        db.prepare('UPDATE ai_primitive_calls SET status=?, result_json=? WHERE execution_id=? AND request_id=?').run(result.success ? 'completed' : 'failed', JSON.stringify(result), state.identity.userMessageId, request.id);
        results.push(result);
      }
      return { results };
    },
    async prepareHuman(input, { node, state, workflow, config }) {
      const db = primitivePersistence(), identity = state.identity;
      const invocationId = state.invocationId ?? 'root';
      const row = db.prepare('SELECT * FROM ai_primitive_human_instances WHERE execution_id=? AND invocation_id=? AND node_id=? AND step=?').get(identity.userMessageId, invocationId, node.id, state.steps ?? 0);
      if (row) return { id: row.clarification_id, kind: node.settings.kind };
      const approval = node.settings.kind === 'approval';
      const requests = approval ? readPrimitivePath(input, node.settings.requestsPath ?? 'requests') : [];
      if (approval && (!Array.isArray(requests) || !requests.length)) throw new Error('Approval needs prepared requests.');
      for (const request of requests) {
        const call = db.prepare('SELECT * FROM ai_primitive_calls WHERE execution_id=? AND request_id=?').get(identity.userMessageId, request.id);
        if (!call || call.fingerprint !== request.fingerprint) throw new Error('Approval input does not match a prepared request.');
      }
      // Import an older pending instance only when its exact prepared actions match.
      const old = approval ? db.prepare('SELECT * FROM ai_primitive_humans WHERE execution_id=? AND node_id=? AND step=?').get(identity.userMessageId, node.id, state.steps ?? 0) : null;
      if (old && hash(JSON.parse(old.requests_json)) === hash(requests) && getAssistantClarification(old.clarification_id)?.status === 'pending') {
        db.prepare('INSERT INTO ai_primitive_human_instances VALUES (?,?,?,?,?,?)').run(identity.userMessageId, invocationId, node.id, state.steps ?? 0, old.clarification_id, old.requests_json);
        return { id: old.clarification_id, kind: node.settings.kind };
      }
      let presentation = null;
      let prompt = approval ? (node.settings.prompt ?? 'Approve these actions?') : readPrimitivePath(input, node.settings.promptPath);
      if (approval) {
        const repeating = requests.filter(request => request.repeatedAction);
        const proposed = state.native?.progress?.nextAction;
        const explanation = requests.length === 1 && proposed?.name === requests[0].name && hash(proposed.arguments) === hash(requests[0].arguments) ? proposed : null;
        presentation = { kind: 'approval', actions: requests.map(request => ({ name: request.name, requestId: request.id, repeated: Boolean(request.repeatedAction), previousResults: request.previousResults ?? [] })),
          reason: explanation?.reason ?? 'The agent is requesting a product change to continue this request.', expectedOutcome: explanation?.expectedOutcome ?? 'The exact approved action will be executed and its result returned to the agent.', source: 'template' };
        if (node.settings.questionMode === 'model') {
          const responseSchema = { type: 'object', required: ['question','reason','expectedOutcome'], additionalProperties: false, properties: Object.fromEntries(['question','reason','expectedOutcome'].map(key => [key, { type: 'string', minLength: 1, maxLength: 1200 }])) };
          const questionInput = { request: state.entry?.request, savedPrompt: node.settings.prompt, preparedActions: requests, proposedExplanation: explanation ?? null, tasks: state.native?.progress?.tasks ?? [], previousObservations: state.native?.observations ?? [] };
          try {
            const wording = await this.model({ native: false, purpose: 'Explain an exact pending approval to the user. You cannot call tools or authorize actions.', systemPrompt: node.settings.questionInstructions ?? '', input: questionInput, responseSchema, toolNames: [],
              profileId: node.settings.profileId ?? workflow.profileId ?? definition.profileId }, { node, workflow, state, config });
            const errors = validateAgentSchema(responseSchema, wording);
            if (errors.length) throw new Error(errors.join('; '));
            prompt = wording.question; presentation = { ...presentation, ...wording, source: 'model' };
          } catch (error) {
            config?.signal?.throwIfAborted();
            presentation.generationError = error.message;
            debugTraceContext()?.capture?.('approval-wording-error', { error: error.message });
          }
        }
        if (presentation.source !== 'model') prompt = node.settings.prompt ?? 'May I execute these prepared actions?';
        presentation.repeatWarning = repeating.length ? 'This repeats an action that already succeeded in this turn. Approve only if you want another execution; otherwise reject and tell the agent to reuse the existing result.' : null;
        debugTraceContext()?.capture?.('approval-presentation', { prompt, presentation, preparedActions: requests });
      }
      const options = approval ? ['approve', 'deny'] : readPrimitivePath(input, node.settings.optionsPath);
      if (typeof prompt !== 'string' || !prompt.trim() || !Array.isArray(options) || options.length < 2 || options.length > 4 || options.some(option => typeof option !== 'string' || !option.trim())) throw new Error('A human interaction needs a question and 2–4 nonempty options.');
      const clarification = createAssistantClarification({ conversationId: identity.conversationId, turnId: identity.turnId, prompt, options, presentation });
      if (approval && identity.turnId) db.prepare("UPDATE ai_turn_tasks SET status='awaiting-approval' WHERE turn_id=? AND status='active'").run(identity.turnId);
      beginExecutionSpan(executionNodeContext(),'human',approval?'Approve prepared actions':'Clarification',{clarificationId:clarification.id},clarification.id);
      db.prepare('INSERT INTO ai_primitive_human_instances VALUES (?,?,?,?,?,?)').run(identity.userMessageId, invocationId, node.id, state.steps ?? 0, clarification.id, JSON.stringify(requests));
      emit(identity.conversationId, 'clarification-required', { clarification });
      return { id: clarification.id, kind: node.settings.kind, prompt, options };
    },
    async resolveHuman(pending, response, { node, state }) {
      const db = primitivePersistence(), row = db.prepare('SELECT * FROM ai_primitive_human_instances WHERE clarification_id=? AND execution_id=? AND invocation_id=? AND node_id=? AND step=?').get(pending.id, state.identity.userMessageId, state.invocationId ?? 'root', node.id, state.steps ?? 0);
      if (!row) throw new Error('Human response does not belong to this execution.');
      const clarification = getAssistantClarification(pending.id);
      const savedResponse = clarification.status === 'resolved' ? clarification.response : String(response ?? '').trim();
      resolveAssistantClarification(pending.id, savedResponse);
      endExecutionSpan(pending.id,'completed',{response:savedResponse});
      const requests = JSON.parse(row.requests_json), approved = node.settings.kind === 'approval' && savedResponse === 'approve';
      if (state.identity.turnId) db.prepare("UPDATE ai_turn_tasks SET status='active' WHERE turn_id=? AND status='awaiting-approval'").run(state.identity.turnId);
      if (approved) db.transaction(() => { for (const request of requests) db.prepare('UPDATE ai_primitive_calls SET approved=1 WHERE execution_id=? AND request_id=? AND fingerprint=?').run(state.identity.userMessageId, request.id, request.fingerprint); })();
      debugTraceContext()?.capture?.('human-decision', { kind: node.settings.kind, clarificationId: pending.id, response: savedResponse, approved, requests });
      setConversationState(state.identity.conversationId, 'generating', state.identity.surface);
      setAssistantTurnStatus(state.identity.turnId, 'active');
      return { response: savedResponse, approved, requests };
    },
    async publish(content, { state, node }) {
      const identity = state.identity;
      const previous = getConversation(identity.conversationId)?.messages.find(message => message.payload?.finalAnswer && message.payload?.userMessageId === identity.userMessageId);
      const evidenceCount = primitivePersistence().prepare("SELECT COUNT(*) AS count FROM ai_primitive_calls WHERE execution_id=? AND status='completed'").get(identity.userMessageId).count;
      const message = previous ?? addMessage(identity.conversationId, 'assistant', content, identity.surface, { ...metadata(state), finalAnswer: true, answerSource: 'model', answerValidation: 'graph-completed', evidenceCount, graphVersion: identity.graphVersion, executionSchemaVersion: 5 });
      const blocked = node.settings.terminalStatus === 'blocked';
      setAssistantTurnStatus(identity.turnId, blocked ? 'needs-attention' : 'completed');
      setConversationState(identity.conversationId, blocked ? 'needs-attention' : 'idle', identity.surface);
      emit(identity.conversationId, 'assistant-message', { message });
      emit(identity.conversationId, 'generation-completed');
    },
    trace({ node, workflow, workflowId, state, config }, execute) {
      const identity = state.identity;
      return traceNode({ ...metadata(state), workspaceId: identity.workspaceId, invocationId: state.invocationId, workflow: { ...workflow, purpose: workflowId }, node, signal: config?.signal }, state, async () => {
        try { debugTraceContext()?.capture?.('resolved-inputs', { binding: node.settings.input, value: resolvePrimitiveBinding(node.settings.input, state) }); }
        catch (error) { debugTraceContext()?.capture?.('resolved-inputs', { binding: node.settings.input, missing: error.message }); }
        const result = await execute();
        recordWorkspaceAuditEvent({ workspaceId: identity.workspaceId, kind: 'agent-primitive-node', title: node.label, summary: `${workflow.name} / ${result.route}`, status: result.failure ? 'failed' : 'completed', surface: 'ai', signature: randomUUID(),
          metadata: { ...metadata(state), workflowId, invocationId: state.invocationId, nodeId: node.id, handler: node.handler, graphVersion: identity.graphVersion, selectedBranch: result.route, transition: result.route, nextNodeId: workflow.edges.find(edge => edge.id === result.route)?.target, steps: result.steps, failure: result.failure } });
        return result;
      });
    }
  };
}
