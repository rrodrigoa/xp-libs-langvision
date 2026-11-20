import { createHash, randomUUID } from 'node:crypto';
import { assistantDebugDatabase, addMessage, getConversation, createAssistantClarification, getAssistantClarification, resolveAssistantClarification, createToolCall, updateToolCall, setConversationState, setAssistantTurnStatus, recordWorkspaceAuditEvent } from './assistantStore.js';
import { capabilityByName, validateCapabilityArguments } from './assistantCapabilities.js';
import { invokeGraphModel } from './assistantModelInvocation.js';
import { traceNode, debugTraceContext, executionNodeContext, linkDebugToolCall, saveDebugArtifact } from './assistantDebugTrace.js';
import { beginExecutionSpan, endExecutionSpan } from './assistantSpans.js';
import { readPrimitivePath, resolvePrimitiveBinding } from '../shared/primitiveAgentModel.js';
import { nativeFinishTool, nativeModelMessages } from '../shared/primitiveNativeProtocol.js';
import { nativeModelAdapter, normalizeNativeModelResponse } from '../shared/nativeModelAdapter.js';
import { PROGRESS_CAPABILITY, PROGRESS_TOOL, CODE_CHANGES_CAPABILITY, CODE_CHANGES_TOOL, recordAppliedCodeChange, validateCodeChangeSnapshot } from '../shared/agentExperience.js';
import { validateAgentSchema } from '../shared/agentJsonSchema.js';
import { HISTORY_TOOLS } from '../shared/agentHistoryProtocol.js';
import { readAgentHistory } from './assistantHistoryTools.js';
import { modelPresentation } from '../shared/agentWaterfall.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const skillTools = ['skills.list', 'skills.search', 'skills.read', 'skills.reference'];
export const PRIMITIVE_KNOWLEDGE_TOOLS = [
  ['skills.list', 'List up to 20 allowed skill descriptions from the pinned agent revision; never returns skill bodies. Use skills.search for a narrower list.', [], {}],
  ['skills.search', 'Find relevant allowed skills by topic. Read selected results with skills.read.', ['query'], { query: { type: 'string', minLength: 1, maxLength: 300, description: 'Keywords for the knowledge you need.' } }],
  ['skills.read', 'Load one allowed skill body. References remain metadata until requested.', ['id'], { id: { type: 'string', minLength: 1, description: 'Exact ID returned by skills.search or skills.list.' } }],
  ['skills.reference', 'Read one reference named by a loaded skill.', ['id', 'reference'], { id: { type: 'string', minLength: 1 }, reference: { type: 'string', minLength: 1 } }]
].map(([name, description, required, properties]) => ({ name, description, risk: 'read', version: 1, schema: { type: 'object', required, properties, additionalProperties: false } }));
export const PRIMITIVE_DISCOVERY_TOOLS = [
  { name: 'tools.list', description: 'List concise metadata for tools permitted to this node; does not grant additional tools.', risk: 'read', version: 1, schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'tools.describe', description: 'Read the authoritative argument schema and risk of one permitted tool by its exact name.', risk: 'read', version: 1, schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false } }
];
const reportStatus = { name: 'agent.report_status', description: 'Send a short, user-facing update about a meaningful discovery, decision or blockage. This does not update the task checklist, authorize an action or prove completion. Do not include secrets or private reasoning.', risk: 'read', version: 1,
  schema: { type: 'object', required: ['message'], properties: { message: { type: 'string', minLength: 1, maxLength: 800 } }, additionalProperties: false } };
export const PRIMITIVE_REGISTERED_TOOLS = [...PRIMITIVE_KNOWLEDGE_TOOLS, ...PRIMITIVE_DISCOVERY_TOOLS, PROGRESS_CAPABILITY, CODE_CHANGES_CAPABILITY, reportStatus, ...HISTORY_TOOLS];
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

export function createPrimitiveAdapters({ definition, fetchImpl, serviceBaseUrl, toolHost, emit = () => {}, onModelActivity = () => {}, onNodeActivity = () => {} }) {
  const execution = (config, state) => ({ ...toolHost.executionContext(config.signal), identity: state.identity });
  const metadata = state => ({ conversationId: state.identity.conversationId, userMessageId: state.identity.userMessageId, turnId: state.identity.turnId });
  function publishStatus(state, node, phase, content, key) {
    if (!state.identity.conversationId || typeof content !== 'string' || !content.trim() || content.length > 800) return false;
    const db = assistantDebugDatabase();
    const statusKey = hash([state.identity.userMessageId, state.invocationId, node.id, phase, key]);
    const trace = executionNodeContext();
    const nodeIdentity = { invocationId: state.invocationId, nodeExecutionId: phase === 'update' ? state.native?.originAttempt ?? trace?.nodeExecutionId : trace?.nodeExecutionId, nodeId: node.id, nodeLabel: node.label };
    const message = db.transaction(() => {
      if (db.prepare("SELECT 1 FROM ai_messages WHERE conversation_id=? AND json_extract(payload_json,'$.statusKey')=?").get(state.identity.conversationId, statusKey)) return null;
      return addMessage(state.identity.conversationId, 'assistant', content.trim(), state.identity.surface, { ...metadata(state), ...nodeIdentity, messageKind: 'node-status', phase, statusKey });
    })();
    if (message) {
      const entry = { phase, message: content.trim(), sourceNodeId: node.id };
      debugTraceContext()?.capture?.('node-status', entry);
      if (trace && nodeIdentity.nodeExecutionId && trace.nodeExecutionId !== nodeIdentity.nodeExecutionId) {
        saveDebugArtifact({ ...trace, nodeExecutionId: nodeIdentity.nodeExecutionId }, 'node-status', entry);
      }
      emit(state.identity.conversationId, 'assistant-message', { message });
    }
    return true;
  }
  const skillsFor = node => (definition.resources?.skills ?? []).filter(skill => node?.settings?.skillIds === undefined || node.settings.skillIds.includes(skill.id));
  const readSkill = (request, origin) => {
    const args = request.arguments;
    const skills = skillsFor(origin);
    if (request.name === 'skills.list') return { count: skills.length, items: skills.slice(0, 20).map(({ id, title, description, version }) => ({ id, title, description, version })), truncated: skills.length > 20 };
    if (request.name === 'skills.search') {
      if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('skills.search requires query.');
      const terms = args.query.toLowerCase().split(/\W+/).filter(Boolean);
      return skills.map(skill => ({ skill, score: terms.filter(term => `${skill.title} ${skill.description} ${skill.body}`.toLowerCase().includes(term)).length }))
        .filter(item => item.score).sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id)).slice(0, 12)
        .map(({ skill, score }) => ({ id: skill.id, title: skill.title, description: skill.description, version: skill.version, hash: hash(skill), score }));
    }
    const skill = skills.find(item => item.id === args.id);
    if (!skill) throw Object.assign(new Error(`Skill '${args.id}' is not available to this node. Use skills.search or skills.list to select an allowed ID.`), { code: 'SKILL_NOT_AVAILABLE' });
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
      return executionNodeContext()?.nodeExecutionId;
    },
    nativeDecision(call, { node, state }, outcome) {
      const span = beginExecutionSpan(executionNodeContext(), 'decision', `finish_step -> ${call.arguments.exit}`, { nativeCallId: call.id, toolCallId: call.id, ...outcome });
      debugTraceContext()?.capture?.('native-step-decision', { requestId: call.id, nodeId: node.id, ...call.arguments, ...outcome });
      endExecutionSpan(span, outcome.status);
    },
    async model(request, { node, workflow, state, config }) {
      const profile = request.profileId ? state.identity.profiles?.[request.profileId] : state.identity.defaultProfile;
      if (!profile) throw Object.assign(new Error(`No model profile is configured for '${node.label}'. Set one under Agent Editor > Edit node > Model profile, or select a workspace profile in chat settings.`), { primitiveBudgetExhausted: true });
      const tools = request.toolNames.map(name => {
        const capability = tool(name);
        if (!capability) throw new Error(`Unknown registered tool '${name}'.`);
        return { type: 'function', function: { name, description: capability.description, parameters: request.native ? capability.nativeSchema ?? capability.schema : capability.schema } };
      });
      if (request.native) {
        const finish = nativeFinishTool(workflow, node, request);
        if (finish) tools.push(finish);
      }
      const skills = skillsFor(node);
      const instructionSkills = (node.settings.instructionSkillIds ?? []).map(id => skills.find(skill => skill.id === id)).filter(Boolean);
      const messages = request.native ? nativeModelMessages({ ...request, instructionSkills, skillDiscovery: request.toolNames.includes('skills.read') && skills.length ? {
        count: skills.length,
        ...(skills.length <= 8 ? { metadata: skills.map(({ id, title, description }) => ({ id, title, description: description?.slice(0, 240) })) } : {}),
        instruction: 'If relevant, discover allowed skills with skills.search or skills.list and use skills.read to load one. Skills do not grant permissions.',
      } : undefined }) : [{ role: 'system', content: request.systemPrompt }, { role: 'user', content: JSON.stringify({ input: request.input, ...(request.availableActions ? { availableActions: request.availableActions } : {}) }) }];
      const adapter = { ...nativeModelAdapter(profile.model), provider: profile.provider ?? 'ollama' };
      if (profile.provider === 'openai-compatible') adapter.id = `openai-compatible-${adapter.family}-native-v1`;
      debugTraceContext()?.capture?.('context-assembly', { messages, profile, adapter, skillsInjected: instructionSkills.length > 0, instructionSkills: instructionSkills.map(skill => ({ id: skill.id, version: skill.version, hash: hash(skill) })), availableTools: request.toolNames });
      const conversationId = state.identity.conversationId;
      if (conversationId) onModelActivity(conversationId, { nodeId: node.id, node: node.label, model: profile.model, startedAt: Date.now() });
      let value;
      try {
      const response = await invokeGraphModel({ fetchImpl, serviceBaseUrl, workflow, nodeId: node.id, profile, signal: config.signal,traceMetadata:{nodeId:node.id,nodeLabel:node.label,profileId:profile.id,provider:profile.provider??'ollama',digest:profile.expectedDigest??null,adapterId:adapter.id},
        body: { baseAddress: profile.baseUrl, model: profile.model, messages, tools, ...(!request.native ? { format: request.responseSchema } : {}),
          think: ['low','medium','high'].includes(profile.thinkingMode) ? profile.thinkingMode : profile.thinkingMode === 'on' || (profile.thinkingMode == null && profile.think), thinkingMode: profile.provider === 'openai-compatible' ? profile.reasoningEffort || 'provider-default' : profile.thinkingMode, options: { temperature: profile.temperature ?? 0, seed: profile.seed ?? 42, ...(request.native ? { num_predict: node.settings.maxOutputTokens ?? 8192 } : {}) }, keepAlive: profile.keepAlive } });
      value = await response.json();
      if (!response.ok) throw Object.assign(new Error(value.error ?? `Model HTTP ${response.status}`),
        { primitiveProviderFailure: ['model_template', 'model_memory', 'model_runner', 'model_transport'].includes(value.code) });
      } finally { if (conversationId) onModelActivity(conversationId, null); }
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
    async prepareTools(requests, { node, workflow, state, config }) {
      const db = primitivePersistence(), prepared = [];
      const preparation=beginExecutionSpan(executionNodeContext(),'preparation','Validate and prepare tool requests');
      try {
      const plannedEdits = Boolean(state.native?.codeChanges && requests.some(request => request.name === 'workspace.edit') &&
        workflow.edges.some(edge => edge.id === 'ready_to_verify' && edge.source === state.native.origin));
      const activeChange = plannedEdits ? state.native.codeChanges.find(change => change.status === 'active') : null;
      if (plannedEdits) {
        const observations = state.native.observations;
        const lastPlan = observations.findLastIndex(item => item.success && item.name === CODE_CHANGES_TOOL);
        if (!activeChange ||
          requests.filter(request => request.name === 'workspace.edit').length > 1 ||
          observations.slice(lastPlan + 1).some(item => item.success && item.name === 'workspace.edit' && !item.appliedCodeChanges)) {
          throw new Error('Execute one edit for the active change, then update the code change snapshot before editing again.');
        }
      }
      for (const request of requests) {
        if (request.name === 'terminal.open' && state.native?.codeChanges?.length &&
            workflow.edges.some(edge => edge.id === 'ready_to_verify' && edge.source === state.native.origin)) {
          const pending = state.native.codeChanges.some(change => ['active', 'pending'].includes(change.status));
          throw Object.assign(new Error(pending
            ? 'Save the active file change with workspace.edit and obtain approval before opening a terminal. Then report its edit evidence and choose ready_to_verify.'
            : 'The file change is finished. Choose ready_to_verify with the approved edit request ID; open the terminal from the verification node.'), { code: pending ? 'FILE_EDIT_REQUIRED' : 'VERIFICATION_HANDOFF_REQUIRED' });
        }
        const exitChecks = request.name === 'terminal.close' ? workflow.edges.filter(edge => edge.source === state.native?.origin)
          .flatMap(edge => [...(edge.evidenceChecks ?? []), ...(edge.evidenceAlternatives ?? []).flatMap(path => path.checks)]) : [];
        if (request.arguments?.discard !== true && exitChecks.some(check => check.toolName === 'terminal.close' && check.afterTool === 'terminal.get_screen')) {
          const sessionId = request.arguments?.session_id;
          const opened = state.native.observations.findLastIndex(item => item.success && item.name === 'terminal.open' && item.result?.session_id === sessionId);
          const recent = state.native.observations.slice(opened + 1);
          if (opened >= 0 && !recent.some(item => item.success && item.name === 'terminal.get_screen' && item.result?.session_id === sessionId)) {
            throw new Error('Before closing this verification terminal, call terminal.get_screen for the same session and inspect the current prompt row.');
          }
          if (opened >= 0 && exitChecks.some(check => check.toolName === 'terminal.wait_for')) {
            const matched = recent.findLastIndex(item => item.success && item.name === 'terminal.wait_for' &&
              item.result?.session_id === sessionId && item.result.source === 'screen' && item.result.matched_text);
            if (matched < 0 || !recent.slice(matched + 1).some(item => item.success && item.name === 'terminal.get_screen' &&
                item.result?.session_id === sessionId && item.result.current_line === recent[matched].result.matched_text)) {
              throw Object.assign(new Error('Before closing, use terminal.wait_for with a regex for the entire expected screen line. Then read the same current line with terminal.get_screen. If verification failed, close with discard:true before repairing the file.'), { code: 'TERMINAL_EVIDENCE_REQUIRED' });
            }
          }
        }
        if(request.name.startsWith('web.') && request.name !== 'web.close') {
          const count=db.prepare("SELECT COUNT(*) n FROM ai_primitive_calls WHERE execution_id=? AND request_id<>? AND json_extract(request_json,'$.name') LIKE 'web.%'").get(state.identity.userMessageId,request.id).n;
          if(count>=Number(process.env.CHRONUS_RESEARCH_MAX_CALLS??12))throw new Error('The per-turn web research budget is exhausted.');
        }
        const capability = tool(request.name);
        if (!capability) throw new Error(`Unknown registered tool '${request.name}'.`);
        if (!state.identity.conversationId && !['read', 'navigate'].includes(capability.risk)) throw new Error('A conversation and human approval are required for mutations.');
        const errors = validateCapabilityArguments(node.operationVersion === 2 && capability.nativeSchema ? { ...capability, schema: capability.nativeSchema } : capability, request.arguments);
        if (errors.length) throw Object.assign(new Error(`Invalid arguments for '${request.name}': ${errors.join('; ')}. Read this tool's native definition or call tools.describe with {"name":"${request.name}"}; the registered schema is authoritative. Argument schema: ${JSON.stringify(capability.nativeSchema??capability.schema)}`), { code: 'invalid_tool_arguments' });
        await capability.preflight?.(request.arguments, execution(config, state));
        const revision = capability.revision ? await capability.revision(request.arguments, execution(config, state)) : null;
        const previous = db.prepare('SELECT * FROM ai_primitive_calls WHERE execution_id=? AND request_id=?').get(state.identity.userMessageId, request.id);
        // Existing approvals retain the fingerprint stored when the request was prepared.
        const codeChangeId = previous ? JSON.parse(previous.request_json).codeChangeId : request.name === 'workspace.edit' ? activeChange?.id : undefined;
        const fingerprint = hash({ request, revision, codeChangeId });
        if (previous && previous.fingerprint !== fingerprint) throw Object.assign(new Error(`Request ID '${request.id}' was reused with different arguments or revision. Use a new request ID.`), { code: 'tool_request_identity_conflict' });
        const approvalRequired = !['read', 'navigate'].includes(capability.risk) || (node.settings.approvalRisks ?? []).includes(capability.risk);
        if (!previous) db.prepare('INSERT INTO ai_primitive_calls(execution_id,request_id,fingerprint,request_json,revision_json,approval_required,status) VALUES(?,?,?,?,?,?,?)')
          .run(state.identity.userMessageId, request.id, fingerprint, JSON.stringify({ ...request, codeChangeId }), JSON.stringify(revision), Number(approvalRequired), 'prepared');
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
        if (hash({ request: { id: request.id, name: request.name, arguments: request.arguments }, revision: JSON.parse(row.revision_json), codeChangeId: saved.codeChangeId }) !== row.fingerprint) throw new Error('Prepared arguments were modified.');
        if (row.approval_required && !row.approved) throw new Error(`Approval of exact request '${request.id}' is required.`);
        if (row.status === 'completed' || row.status === 'failed') {
          const cached=JSON.parse(row.result_json),span=beginExecutionSpan(executionNodeContext(),'tool',request.name,{toolCallId:request.id,reused:true});
          debugTraceContext()?.capture('native-tool-input',{requestId:request.id,name:request.name,arguments:request.arguments});debugTraceContext()?.capture('native-tool-result',cached);
          endExecutionSpan(span,row.status);results.push(cached);continue;
        }
        if (row.status === 'executing') throw new Error(`Request '${request.id}' has an unknown outcome after interruption. Reconcile it before retrying; it will not be replayed.`);
        const capability = tool(saved.name);
        if (capability.revision && hash(await capability.revision(saved.arguments, execution(config, state))) !== hash(JSON.parse(row.revision_json))) throw Object.assign(new Error('Product revision changed after preparation. Prepare a new request.'), { code: 'product_revision_stale' });
        const claimed = db.prepare("UPDATE ai_primitive_calls SET status='executing' WHERE execution_id=? AND request_id=? AND status='prepared'").run(state.identity.userMessageId, request.id).changes;
        if (claimed !== 1) throw new Error('This request is already executing.');
        let result;
        const spanId=beginExecutionSpan(executionNodeContext(),skillTools.includes(saved.name)?'skill':'tool',saved.name,{toolCallId:saved.id});
        debugTraceContext()?.capture('native-tool-input',{requestId:saved.id,name:saved.name,arguments:saved.arguments});
        try {
          if (saved.name === CODE_CHANGES_TOOL) {
            const changes = saved.arguments.changes;
            validateCodeChangeSnapshot(changes, state.native?.codeChanges, state.native?.observations);
            const message = addMessage(state.identity.conversationId, 'assistant', 'Code change plan updated.', state.identity.surface, { ...metadata(state), messageKind: 'code-changes', changes });
            emit(state.identity.conversationId, 'assistant-message', { message });
            result = { requestId: saved.id, name: saved.name, success: true, result: { changes } };
          }
          else if (saved.name === reportStatus.name) {
            const origin = workflow.nodes.find(item => item.id === state.native?.origin) ?? node;
            if (!publishStatus(state, origin, 'update', saved.arguments.message, saved.arguments.message.trim())) throw new Error('A chat update requires a conversation and nonempty message.');
            result = { requestId: saved.id, name: saved.name, success: true, result: { published: true } };
          }
          else if (saved.name === PROGRESS_TOOL) {
            const prior = state.native?.progress;
            const tasks = structuredClone(saved.arguments.tasks ?? prior?.tasks ?? []);
            if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('Task IDs must be unique.');
            const removed = (prior?.tasks ?? []).filter(task => !tasks.some(next => next.id === task.id));
            if (removed.length && !saved.arguments.planChangeReason?.trim()) throw new Error('Removing outcomes requires planChangeReason. Send the complete revised task list, including unchanged tasks.');
            for (const task of tasks) {
              const verified = prior?.tasks?.find(previous=>previous.id===task.id && previous.title===task.title && previous.status==='completed');
              if (task.status==='completed' && task.evidenceReferences===undefined && verified) task.evidenceReferences=structuredClone(verified.evidenceReferences);
              if (task.status === 'completed' && !task.evidenceReferences?.some(id => state.native?.observations?.some(observation => observation.success && ![PROGRESS_TOOL, CODE_CHANGES_TOOL, reportStatus.name].includes(observation.name) && [observation.requestId, observation.toolCallId].includes(id)))) throw new Error(`Completed task '${task.title}' requires an actual successful observation reference.`);
              if (['blocked','canceled'].includes(task.status) && !task.reason?.trim()) throw new Error('Blocked or canceled outcomes need an explanation.');
            }
            const activeTasks = tasks.filter(task => task.status === 'active');
            const requestedCurrent = saved.arguments.currentTaskId;
            const currentTaskId = activeTasks.some(task => task.id === requestedCurrent) ? requestedCurrent : activeTasks[0]?.id ?? null;
            const progress = { ...saved.arguments, tasks, currentTaskId, ...(removed.length ? { removedTasks: removed } : {}) };
            if (state.identity.turnId && (workflow === definition || workflowId === 'assistant')) db.transaction(() => {
              const previousMax = db.prepare('SELECT COALESCE(MAX(ordinal),0) AS value FROM ai_turn_tasks WHERE turn_id=?').get(state.identity.turnId).value;
              // Move old ordinals out of the way before reordering or inserting tasks.
              db.prepare('UPDATE ai_turn_tasks SET ordinal=ordinal+? WHERE turn_id=?').run(Math.max(previousMax, tasks.length) + 1, state.identity.turnId);
              db.prepare('UPDATE ai_turns SET current_task_id=? WHERE turn_id=?').run(currentTaskId?`${state.identity.turnId}-outcome-${currentTaskId}`:null,state.identity.turnId);
              for (const task of removed) db.prepare("UPDATE ai_turn_tasks SET status='removed',error=?,updated_at=? WHERE task_id=?").run(saved.arguments.planChangeReason, new Date().toISOString(), `${state.identity.turnId}-outcome-${task.id}`);
              for (const [index, task] of tasks.entries()) {
              const taskId = `${state.identity.turnId}-outcome-${task.id}`;
              const ordinal = index + 1;
              db.prepare(`INSERT INTO ai_turn_tasks(task_id,turn_id,ordinal,title,surface,expected_tools_json,status,error,created_at,updated_at) VALUES(?,?,?,?,?,'[]',?,?,?,?)
                ON CONFLICT(task_id) DO UPDATE SET title=excluded.title,ordinal=excluded.ordinal,status=excluded.status,updated_at=excluded.updated_at,error=excluded.error`).run(taskId, state.identity.turnId, ordinal, task.title, state.identity.surface ?? 'creatio', task.status === 'blocked' ? 'needs-attention' : task.status, task.reason ?? null, new Date().toISOString(), new Date().toISOString());
              }
              const removedRows = db.prepare("SELECT task_id FROM ai_turn_tasks WHERE turn_id=? AND status='removed' ORDER BY ordinal").all(state.identity.turnId);
              const moveRemoved = db.prepare('UPDATE ai_turn_tasks SET ordinal=? WHERE task_id=?');
              removedRows.forEach((row, index) => moveRemoved.run(tasks.length + index + 1, row.task_id));
            })();
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
          else if (skillTools.includes(saved.name)) result = { requestId: saved.id, name: saved.name, success: true, result: readSkill(saved, workflow.nodes.find(item => item.id === state.native?.origin) ?? node) };
          else {
            const message = addMessage(state.identity.conversationId, 'assistant', `Execute ${saved.name}.`, state.identity.surface, { ...metadata(state), requestId: saved.id });
            let call = createToolCall({ conversationId: state.identity.conversationId, messageId: message.id, capability, args: saved.arguments,
              preview: capability.preview?.(saved.arguments), expectedRevision: JSON.parse(row.revision_json), requiresApproval: false });
            if (row.approved) call = updateToolCall(call.id, 'executing', { approved: true });
            linkDebugToolCall(call); emit(state.identity.conversationId, 'tool-call', { toolCall: call });
            const outcome = await toolHost.executeTool(call, capability, saved.arguments, execution(config, state), state.identity.surface);
            result = { requestId: saved.id, toolCallId: call.id, name: saved.name, success: outcome.ok, ...(outcome.ok ? { result: outcome.result } : { error: outcome.error.message, ...(outcome.error.code ? { errorCode: outcome.error.code } : {}) }) };
            if (saved.name === 'workspace.edit' && outcome.ok && row.approved && saved.codeChangeId) {
              const changes = recordAppliedCodeChange(state.native?.codeChanges, saved.codeChangeId, saved.id);
              if (changes) result.appliedCodeChanges = changes;
            }
            if (saved.name === 'workspace.run' && outcome.ok && outcome.result.verified !== true) {
              result.success = false;
              result.error = outcome.result.error ?? `Command exited with code ${outcome.result.exitCode}.`;
            }
          }
        } catch (error) { result = { requestId: saved.id, name: saved.name, success: false, error: error.message, ...(error.code ? { errorCode: error.code } : {}) }; }
        debugTraceContext()?.capture('native-tool-result',result);
        endExecutionSpan(spanId,result.success?'completed':'failed');
        const message = db.transaction(() => {
          db.prepare('UPDATE ai_primitive_calls SET status=?, result_json=? WHERE execution_id=? AND request_id=?').run(result.success ? 'completed' : 'failed', JSON.stringify(result), state.identity.userMessageId, request.id);
          if (result.appliedCodeChanges) return addMessage(state.identity.conversationId, 'assistant', 'Approved edit applied; behavior still needs verification.', state.identity.surface, { ...metadata(state), messageKind: 'code-changes', changes: result.appliedCodeChanges, requestId: saved.id });
        })();
        if (message) emit(state.identity.conversationId, 'assistant-message', { message });
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
        presentation = { kind: 'approval', actions: requests.map(request => ({ name: request.name, requestId: request.id, repeated: Boolean(request.repeatedAction), previousResults: request.previousResults ?? [],
          ...((['workspace.edit', 'workspace.run', 'terminal.open'].includes(request.name) || request.name.startsWith('web.') || tool(request.name)?.connectionId) ? { preview: tool(request.name).preview(request.arguments) } : {}) })),
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
      const optional = path => { try { return path ? readPrimitivePath(input, path) : undefined; } catch { return undefined; } };
      const options = approval ? ['approve', 'deny'] : optional(node.settings.optionsPath) ?? [];
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1200 || !Array.isArray(options) || options.length > 4 || options.length === 1 || options.some(option => typeof option !== 'string' || !option.trim() || option.length > 300)) throw new Error('A human interaction needs a short question and either no options or 2–4 nonempty options.');
      const recommendation = approval ? null : optional(node.settings.recommendationPath);
      if (!approval) presentation = { kind: 'clarification', reason: optional(node.settings.reasonPath) ?? null };
      const clarification = createAssistantClarification({ conversationId: identity.conversationId, turnId: identity.turnId, prompt, options, presentation, recommendation });
      if (approval && identity.turnId) db.prepare("UPDATE ai_turn_tasks SET status='awaiting-approval' WHERE turn_id=? AND status='active'").run(identity.turnId);
      beginExecutionSpan(executionNodeContext(),'human',approval?'Approve prepared actions':'Clarification',{clarificationId:clarification.id,prompt,options,recommendation,presentation},clarification.id);
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
      emit(state.identity.conversationId, 'clarification-resolved', { clarificationId: pending.id });
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
    async trace({ node, workflow, workflowId, state, config }, execute) {
      const identity = state.identity;
      if (identity.conversationId) onNodeActivity(identity.conversationId, { nodeId: node.id, workflowId, graphVersion: identity.graphVersion });
      try { return await traceNode({ ...metadata(state), workspaceId: identity.workspaceId, invocationId: state.invocationId, workflow: { ...workflow, purpose: workflowId }, node, signal: config?.signal }, state, async () => {
        try {
          const session = node.handler === 'llm' && node.operationVersion === 2 ? state.native?.sessions?.[node.id] : null;
          debugTraceContext()?.capture?.('resolved-inputs', { binding: node.settings.input, value: session ? session.input : resolvePrimitiveBinding(node.settings.input, state), reusedStepInput: Boolean(session) });
        }
        catch (error) { debugTraceContext()?.capture?.('resolved-inputs', { binding: node.settings.input, missing: error.message }); }
        const status = (phase, output) => {
          const binding = node.settings.statusMessages?.[phase];
          if (!binding) return;
          let content;
          try { content = resolvePrimitiveBinding(binding, output ? { ...state, result: output.payload ?? output.result } : state); }
          catch (error) { debugTraceContext()?.capture?.('node-status-error', { phase, error: error.message }); return; }
          publishStatus(state, node, phase, content, state.steps ?? 0);
        };
        status('start');
        let result;
        try { result = await execute(); }
        catch (error) {
          if (!['GraphInterrupt', 'NodeInterrupt'].includes(error.name) && !config.signal?.aborted) status('failure', { result: { message: error.message } });
          throw error;
        }
        status(result.failure ? 'failure' : 'success', result);
        recordWorkspaceAuditEvent({ workspaceId: identity.workspaceId, kind: 'agent-primitive-node', title: node.label, summary: `${workflow.name} / ${result.route}`, status: result.failure ? 'failed' : 'completed', surface: 'ai', signature: randomUUID(),
          metadata: { ...metadata(state), workflowId, invocationId: state.invocationId, nodeId: node.id, handler: node.handler, graphVersion: identity.graphVersion, selectedBranch: result.route, transition: result.route, nextNodeId: workflow.edges.find(edge => edge.id === result.route)?.target, steps: result.steps, failure: result.failure } });
        return result;
      }); } finally { if (identity.conversationId) onNodeActivity(identity.conversationId, null); }
    }
  };
}
