import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { listWorkflowVersions, editWorkflowVersion, activateWorkflowVersion, cloneWorkflowVersion } from '../assistantVersions.js';
import { ASSISTANT_CAPABILITIES } from '../assistantCapabilities.js';
import { activeAssistantWorkflow, listAssistantWorkflows, saveAssistantWorkflow, selectAssistantWorkflow, listWorkspaceAiSkills, getAiProfile, getWorkspaceAiProfile, selectWorkspaceAiProfile, recordWorkspaceAuditEvent, systemAgentPolicy, deleteAssistantWorkflow } from '../assistantStore.js';
import { IMMUTABLE_SECURITY_POLICY } from '../assistantContext.js';
import { ensureGraphKnowledge } from '../assistantGraphConfiguration.js';
import { rawDebugEnabled,listDebugArtifacts,readDebugArtifact,inspectDebugArtifact,listDebugNodes,debugExecutionStorage,deleteDebugExecution,exportDebugExecution } from '../assistantDebugTrace.js';
import { listAssistantWorkflowDrafts, saveAssistantWorkflowDraft, publishAssistantWorkflowDraft } from '../assistantStore.js';
import { PRIMITIVE_TYPES, PRIMITIVE_PRESETS, blankPrimitiveAgent, resolvePrimitiveBinding, primitiveActions, primitiveWorkflows, validatePrimitiveAgent } from '../../shared/primitiveAgentModel.js';
import { starterPrimitiveAgent } from '../../shared/primitiveAgentStarter.js';
import { addApproachPlanning, migrateInstructionSkills } from '../../shared/codingAgent.js';
import { PRIMITIVE_REGISTERED_TOOLS } from '../primitiveAgentAdapters.js';
import { migratePrimitiveNative } from '../../shared/primitiveNativeMigration.js';
import { nativeModelMessages, nativeFinishTool } from '../../shared/primitiveNativeProtocol.js';
import { listExecutionSpans } from '../assistantSpans.js';
import { latestSelectableAssistantWorkflow } from '../assistantStore.js';

function auditProjection(value, depth = 0) {
  if (depth > 7) return '[bounded]';
  if (typeof value === 'string') return value.slice(0, 16000).replace(/(SharedAccessKey|Password|ApiKey|Bearer)(\s*[=: ]\s*)[^;\s"']+/gi, '$1$2[redacted]');
  if (Array.isArray(value)) return value.slice(0, 100).map(item => auditProjection(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(thinking|reasoning|password|connectionString|apiKey|token)$/i.test(key)).map(([key, item]) => [key, auditProjection(item, depth + 1)]));
  return value;
}

export function createAssistantDesignRouter({ agent, contextBroker, fetchImpl = fetch, serviceBaseUrl }) {
  const router = Router();
  const wrap = handler => async (request, response) => {
    try { await handler(request, response); } catch (error) { if (!response.headersSent && !response.destroyed) response.status(error.status ?? 400).json({ error: error.message }); else if (!response.destroyed) response.destroy(error); }
  };
  const workspace = request => String(request.body?.workspaceId ?? request.query.workspaceId ?? 'default').slice(0, 160);
  const draftShape = definition => {
    if (!definition || definition.schemaVersion !== 5 || JSON.stringify(definition).length > 2_000_000 || typeof definition.name !== 'string' || !definition.name.trim() || definition.name.length > 100) throw new Error('A builder draft needs a name and a bounded primitive version 5 definition.');
    for (const [, graph] of primitiveWorkflows(definition)) {
      if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length > 64 || !Array.isArray(graph.edges) || graph.edges.length > 128) throw new Error('A draft needs workflows with up to 64 nodes and 128 links each.');
      if (new Set(graph.nodes.map(node => node.id)).size !== graph.nodes.length || graph.nodes.some(node => !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(node.id))) throw new Error('Draft node IDs must be unique stable identifiers.');
    }
  };
  router.get('/node-types', wrap((_request, response) => response.json({ version: 5, types: PRIMITIVE_TYPES, presets: PRIMITIVE_PRESETS })));
  router.post('/workflows/:id/coding-planning-draft', wrap((request, response) => {
    const id = request.params.id;
    if (id !== 'langvision-coding-agent') throw new Error('Only the built-in Coding Agent has a planning upgrade.');
    const saved = listAssistantWorkflows().find(item => item.id === id);
    const draft = listAssistantWorkflowDrafts().find(item => item.id === id);
    if (!saved || (draft?.draftVersion ?? 0) !== request.body.expectedDraftVersion || saved.version !== request.body.expectedVersion) {
      throw Object.assign(new Error('Reload the latest Coding Agent before upgrading it.'), { status: 409 });
    }
    const definition = structuredClone(draft?.definition ?? saved.definition);
    if (!addApproachPlanning(definition)) throw new Error('The draft already has approach planning or its existing stage links no longer match the built-in graph.');
    migrateInstructionSkills(definition);
    draftShape(definition);
    const diagnostics = validatePrimitiveAgent(definition);
    if (diagnostics.length) throw new Error(diagnostics.join('\n'));
    response.json({ ...saveAssistantWorkflowDraft(id, definition, draft?.draftVersion ?? 0), version: saved.version });
  }));
  router.post('/workflows/:id/native-draft', wrap((request, response) => {
    const draft = listAssistantWorkflowDrafts().find(item => item.id === request.params.id);
    if ((draft?.draftVersion ?? 0) !== request.body.expectedDraftVersion) throw Object.assign(new Error('Reload the latest draft before migrating.'), { status: 409 });
    const saved = draft ?? listAssistantWorkflows().find(item => item.id === request.params.id);
    if (!saved) throw new Error('Agent not found.');
    const migration = migratePrimitiveNative(saved.definition, [...ASSISTANT_CAPABILITIES, ...PRIMITIVE_REGISTERED_TOOLS]);
    if (!migration.definition) return response.status(409).json({ error: 'Custom configuration requires review; no draft or active revision was changed.', report: migration.report });
    draftShape(migration.definition);
    response.json({ ...saveAssistantWorkflowDraft(request.params.id, migration.definition, draft?.draftVersion ?? 0), version: saved.version ?? 0, migrationReport: migration.report });
  }));
  router.get('/executions/:id/spans',wrap((request,response)=>response.json(listExecutionSpans(workspace(request),request.params.id,request.query))));
  router.get('/debug/executions/:id/nodes',wrap((request,response)=>response.json({...listDebugNodes(workspace(request),request.params.id,request.query.after,request.query.limit),storage:debugExecutionStorage(workspace(request),request.params.id)})));
  router.get('/debug/executions/:id/storage',wrap((request,response)=>response.json(debugExecutionStorage(workspace(request),request.params.id))));
  router.get('/debug/nodes/:id/artifacts',wrap((request,response)=>response.json({enabled:rawDebugEnabled(),artifacts:listDebugArtifacts(workspace(request),request.params.id)})));
  router.get('/debug/artifacts/:id',wrap((request,response)=>{const value=readDebugArtifact(workspace(request),request.params.id,request.query.offset,request.query.limit);return value?response.json(value):response.status(404).json({error:'Debug payload unavailable: capture was disabled or this payload was cleared.'});}));
  router.get('/debug/artifacts/:id/value',wrap((request,response)=>{const value=inspectDebugArtifact(workspace(request),request.params.id,request.query);return value?response.json(value):response.status(404).json({error:'Captured value or path is unavailable.'});}));
  router.get('/debug/executions/:id/export',wrap(async(request,response)=>{if(!rawDebugEnabled())throw new Error('Raw debug capture is disabled.');response.type('application/x-ndjson');response.setHeader('Content-Disposition','attachment; filename="agent-debug.ndjson"');await pipeline(Readable.from(exportDebugExecution(workspace(request),request.params.id)),response);}));
  router.delete('/debug/executions/:id',wrap((request,response)=>{if(request.body.confirmExecutionId!==request.params.id)throw new Error('Confirm the exact execution ID before clearing payloads.');deleteDebugExecution(workspace(request),request.params.id);response.json({cleared:true});}));
  router.get('/workflow-resources', wrap(async (_request, response) => response.json({
    securityPolicy: IMMUTABLE_SECURITY_POLICY,
    catalog: { sections: [] },
    tools: [...ASSISTANT_CAPABILITIES, ...PRIMITIVE_REGISTERED_TOOLS].map(({ execute, preview, revision, evidence, ...contract }) => contract),
    routing: { source: 'Saved primitive graph links', types: PRIMITIVE_TYPES },
    modelProtocol: { provider: 'ollama-chat', answer: 'message.content', tools: 'message.tool_calls',
      reasoning: 'message.thinking', reasoningPolicy: 'Exclude from conversation and tool instructions. Provider-returned thinking is retained only in explicitly enabled sensitive raw debug artifacts.' }
  })));
  const validate = (definition, workspaceId) => {
    const errors = validatePrimitiveAgent(definition);
    if (definition?.schemaVersion === 5) {
      if (definition.nodes.some(node => node.handler === 'end' && node.settings.mode !== 'publish')) errors.push('Conversation End nodes must publish a final response.');
      const toolNames = new Set([...ASSISTANT_CAPABILITIES, ...PRIMITIVE_REGISTERED_TOOLS].map(tool => tool.name));
      for (const [key, graph] of primitiveWorkflows(definition)) {
        if (key !== 'assistant' && graph.nodes.some(node => node.handler === 'end' && node.settings.mode !== 'return')) errors.push(`${key}: Return JSON to the caller; only the conversation publishes its final answer.`);
        for (const node of graph.nodes) for (const name of node.settings.toolNames ?? []) if (!toolNames.has(name)) errors.push(`${node.id}: Tool '${name}' is not registered.`);
      }
    }
    if (errors.length) throw new Error(errors.join(' '));
    for (const [, graph] of primitiveWorkflows(definition)) {
      for (const id of [graph.profileId, ...graph.nodes.map(node => node.settings?.profileId)].filter(Boolean)) {
        if (!getAiProfile(id)) throw new Error('Bind each imported model profile to a locally saved profile before activation.');
      }
    }
    if (typeof agent?.buildGraph !== 'function') throw new Error('Editable workflows require CHRONOSQL_ASSISTANT_RUNTIME=langgraph.');
    agent.buildGraph(definition);
  };
  router.get('/workflows/:id/versions', wrap((request,response) => response.json({ versions:listWorkflowVersions(workspace(request),request.params.id), active:activeAssistantWorkflow(workspace(request)) && {id:activeAssistantWorkflow(workspace(request)).id,version:activeAssistantWorkflow(workspace(request)).version} })));
  router.patch('/workflows/:id/versions/:version', wrap((request,response) => response.json(editWorkflowVersion(request.params.id,request.params.version,request.body))));
  router.delete('/workflows/:id/versions/:version', wrap((request,response) => response.json(editWorkflowVersion(request.params.id,request.params.version,{...request.body,remove:true}))));
  router.post('/workflows/:id/versions/:version/clone', wrap((request,response) => response.json(cloneWorkflowVersion(request.params.id,request.params.version,request.body.expectedDraftVersion))));
  router.post('/workflows/:id/versions/:version/activate', wrap((request,response) => {
    const saved=activateWorkflowVersion(workspace(request),request.params.id,request.params.version,request.body.expectedActive,definition=>validate(definition,workspace(request)));
    if(saved.definition.profileId)selectWorkspaceAiProfile(workspace(request),saved.definition.profileId);
    recordWorkspaceAuditEvent({workspaceId:workspace(request),kind:'agent-definition',title:'Agent version activated',summary:`${saved.label} / v${saved.version}`,status:'completed',surface:'ai',signature:randomUUID(),metadata:{workflowId:saved.id,version:saved.version}});
    response.json(saved);
  }));
  router.get('/workflows', wrap(async (request, response) => {
    await ensureGraphKnowledge(contextBroker, workspace(request));
    const published = listAssistantWorkflows(), drafts = listAssistantWorkflowDrafts();
    const workflows = [...new Set([...published, ...drafts].map(item => item.id))].map(id => {
      const saved = published.find(item => item.id === id), draft = drafts.find(item => item.id === id);
      return { ...saved, ...draft, version: saved?.version ?? 0, draftVersion: draft?.draftVersion ?? 0, definition: draft?.definition ?? saved.definition, ...systemAgentPolicy(id, draft?.definition ?? saved.definition) };
    });
    const active = activeAssistantWorkflow(workspace(request));
    response.json({ workflows, activeId: active.id, activeVersion: active.version,
      handlers: PRIMITIVE_TYPES, primitiveTypes: PRIMITIVE_TYPES, tools: [...ASSISTANT_CAPABILITIES, ...PRIMITIVE_REGISTERED_TOOLS].map(({ name, description, risk, schema, nativeSchema }) => ({ name, description, risk, schema: nativeSchema ?? schema })), skills: listWorkspaceAiSkills(workspace(request)) });
  }));
  router.post('/workflows', wrap(async (request, response) => {
    if (request.body.mode) {
      const source = request.body.sourceId ? listAssistantWorkflows().find(item => item.id === request.body.sourceId)?.definition : activeAssistantWorkflow(workspace(request)).definition;
      if (!source || !['blank', 'starter', 'copy', 'primitive-blank', 'primitive-starter'].includes(request.body.mode)) throw new Error('Select a supported agent creation mode.');
      const skills = structuredClone(source.resources?.skills ?? []);
      const definition = ['blank', 'primitive-blank'].includes(request.body.mode) ? blankPrimitiveAgent(request.body.name)
        : ['starter', 'primitive-starter'].includes(request.body.mode) ? starterPrimitiveAgent(request.body.name, { tools: [...ASSISTANT_CAPABILITIES, ...PRIMITIVE_REGISTERED_TOOLS], skills })
        : { ...structuredClone(source), name: request.body.name };
      definition.profileId = request.body.profileId ?? null;
      draftShape(definition);
      const saved = saveAssistantWorkflowDraft(`agent-${randomUUID()}`, definition, 0);
      return response.status(201).json({ ...saved, version: 0 });
    }
    const definition = request.body.definition ?? starterPrimitiveAgent();
    validate(definition, workspace(request));
    const id = `agent-${randomUUID()}`;
    const saved = saveAssistantWorkflow(id, definition, 0);
    recordWorkspaceAuditEvent({ workspaceId: workspace(request), kind: 'agent-definition', title: 'Agent definition created', summary: `${definition.name} version 1`, status: 'completed', surface: 'ai', signature: `${saved.id}@1`, metadata: { workflowId: saved.id, version: 1 } });
    response.status(201).json(saved);
  }));
  router.delete('/workflows/:id', wrap((request, response) => {
    const result = deleteAssistantWorkflow(request.params.id, request.body.expectedDraftVersion, request.body.expectedVersion);
    recordWorkspaceAuditEvent({ workspaceId: workspace(request), kind: 'agent-definition', title: 'Agent deleted', summary: request.params.id, status: 'completed', surface: 'ai', signature: randomUUID(), metadata: result });
    response.json(result);
  }));
  router.put('/workflow-drafts/:id', wrap((request, response) => {
    draftShape(request.body.definition);
    const saved = saveAssistantWorkflowDraft(request.params.id, request.body.definition, request.body.expectedDraftVersion);
    const published = listAssistantWorkflows().find(item => item.id === saved.id);
    response.json({ ...saved, version: published?.version ?? 0, ...systemAgentPolicy(saved.id, saved.definition) });
  }));
  router.post('/workflows/:id/validate', wrap(async (request, response) => {
    const definition = request.body.definition ?? listAssistantWorkflowDrafts().find(item => item.id === request.params.id)?.definition ?? listAssistantWorkflows().find(item => item.id === request.params.id)?.definition;
    if (!definition) throw new Error('Agent was not found.');
    const diagnostics = validatePrimitiveAgent(definition).map(message => ({ severity: 'error', message }));
    if (!diagnostics.length) try {
      validate(definition, workspace(request));
    } catch (error) { diagnostics.push({ severity: 'error', message: error.message }); }
    response.json({ valid: !diagnostics.length, diagnostics });
  }));
  router.post('/node-preview', wrap((request, response) => {
    const workflow = request.body.workflow;
    const node = workflow?.nodes?.find(item => item.id === request.body.nodeId);
    if (!node) throw new Error('Choose a node from the working graph.');
    if (workflow.schemaVersion === 5) {
      const input = resolvePrimitiveBinding(node.settings.input, request.body.sampleState ?? {});
      const actions = primitiveActions(workflow, node.id);
      if (node.handler === 'llm' && node.operationVersion === 2) {
        const settings = node.settings;
        const context = settings.context ? resolvePrimitiveBinding(settings.context, request.body.sampleState ?? {}) : undefined;
        const instructionSkills = (settings.instructionSkillIds ?? []).map(id => workflow.resources?.skills?.find(skill => skill.id === id)).filter(Boolean);
        return response.json({ nodeId: node.id, input, messages: nativeModelMessages({ ...settings, input, context, workflow, node, instructionSkills }), tools: [...[...ASSISTANT_CAPABILITIES, ...PRIMITIVE_REGISTERED_TOOLS].filter(tool => settings.toolNames.includes(tool.name)).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.schema } })), ...[nativeFinishTool(workflow, node, { input, context })].filter(Boolean)] });
      }
      return response.json({ nodeId: node.id, input, ...(node.handler === 'llm' ? { messages: [{ role: 'system', content: node.settings.systemPrompt }, { role: 'user', content: JSON.stringify({ input, ...(node.settings.actionPath ? { availableActions: actions } : {}) }) }], toolNames: node.settings.toolNames, responseSchema: node.settings.responseSchema } : {}), actions });
    }
    throw new Error('Only primitive node previews are supported.');
  }));
  router.put('/workflows/:id', wrap(async (request, response) => {
    validate(request.body.definition, workspace(request));
    const saved = saveAssistantWorkflow(request.params.id, request.body.definition, request.body.expectedVersion);
    if (activeAssistantWorkflow(workspace(request)).id === saved.id && saved.definition.profileId) selectWorkspaceAiProfile(workspace(request), saved.definition.profileId);
    recordWorkspaceAuditEvent({ workspaceId: workspace(request), kind: 'agent-definition', title: 'Agent definition saved', summary: `${saved.definition.name} version ${saved.version}`, status: 'completed', surface: 'ai', signature: `${saved.id}@${saved.version}`, metadata: { workflowId: saved.id, version: saved.version } });
    response.json(saved);
  }));
  router.post('/workflows/:id/activate', wrap(async (request, response) => {
    const active = activeAssistantWorkflow(workspace(request));
    const expectedActive = { id: active.id, version: active.version };
    let selected;
    const draft = listAssistantWorkflowDrafts().find(item => item.id === request.params.id);
    if (draft) {
      if (request.body.expectedDraftVersion !== draft.draftVersion) throw Object.assign(new Error('Save or reload the latest draft before activating.'), { status: 409 });
      validate(draft.definition, workspace(request));
      selected = publishAssistantWorkflowDraft(workspace(request), draft.id, draft.draftVersion, expectedActive);
    } else {
      const candidate = latestSelectableAssistantWorkflow(request.params.id);
      validate(candidate.definition, workspace(request));
      selected = selectAssistantWorkflow(workspace(request), candidate.id, expectedActive);
    }
    const saved = selected;
    if (selected.definition.profileId) selectWorkspaceAiProfile(workspace(request), selected.definition.profileId);
    recordWorkspaceAuditEvent({ workspaceId: workspace(request), kind: 'agent-definition', title: 'Active agent changed', summary: `${saved.definition.name} version ${saved.version}`, status: 'completed', surface: 'ai', signature: randomUUID(), metadata: { workflowId: saved.id, version: saved.version } });
    response.json(saved);
  }));
  return router;
}
