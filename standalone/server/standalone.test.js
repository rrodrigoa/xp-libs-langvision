import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { __setAssistantDbForTests, activeAssistantWorkflow, assistantDebugDatabase, closeAssistantStore, createConversation, listAssistantWorkflowDrafts, saveAssistantWorkflow, saveAiProfile, selectAssistantWorkflow } from './assistantStore.js';
import { starterPrimitiveAgent } from '../shared/primitiveAgentStarter.js';
import { ASSISTANT_CAPABILITIES, capabilityByName, mcpConnections, refreshMcpConnection, saveMcpConnection } from './assistantCapabilities.js';
import { AssistantLangGraphRuntime } from './assistantGraph.js';
import { ConsiliumToolHost } from './assistantAgent.js';
import { exportAgentPackage, importAgentPackage } from './agentPackage.js';
import { boundedOllamaOptions, localModelGateway } from './modelGateway.js';
import { provisionLocalCodingAgent, getAiProfile, deleteAiProfile } from './assistantStore.js';
import { CODE_CHANGES_TOOL, recordAppliedCodeChange, validateCodeChangeSnapshot } from '../shared/agentExperience.js';
import { availableNativeExits, nativeFinishTool, nativeModelMessages, validateNativeFinish } from '../shared/primitiveNativeProtocol.js';
import { addTerminalCodingTools, codingAgent } from '../shared/codingAgent.js';
import { invokeGraphModel } from './assistantModelInvocation.js';
import { validatePrimitiveAgent } from '../shared/primitiveAgentModel.js';

test('native model requests use one leading system message and retain ordered tool history', () => {
  const node = { id: 'reason', settings: { progressInstructions: 'progress', authoringInstructions: 'style', researchInstructions: 'research', toolContractInstructions: 'tools' } };
  const transcript = [{ role: 'assistant', content: '', tool_calls: [{ id: 'call' }] }, { role: 'tool', tool_call_id: 'call', content: 'result' }];
  const messages = nativeModelMessages({ node, workflow: { edges: [] }, systemPrompt: 'base', input: {}, transcript });
  assert.deepEqual(messages.map(message => message.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(messages[0].content, 'base\n\nprogress\n\nstyle\n\nresearch\n\ntools');
  assert.deepEqual(messages.slice(-2), transcript);
  for (const llm of codingAgent().nodes.filter(item => item.handler === 'llm')) {
    assert.doesNotMatch(JSON.stringify(llm.settings), /ChronusQL|language\.search|figura\.create_panel|update SQL/i);
  }
});

test('a node may inherit, opt out, or reference only valid saved skill IDs', () => {
  const graph = codingAgent();
  const reason = graph.nodes.find(node => node.id === 'reason');
  delete reason.settings.instructionSkillIds;
  for (const ids of [undefined, [], ['safe-project-edits']]) {
    reason.settings.skillIds = ids;
    assert.deepEqual(validatePrimitiveAgent(graph), []);
  }
  reason.settings.skillIds = ['missing'];
  assert.ok(validatePrimitiveAgent(graph).some(error => /saved resources/.test(error)));
});

test('the approach exposes only exits supported by its bindings and cannot replace evidence with a chat update', () => {
  const graph = codingAgent();
  const node = graph.nodes.find(item => item.id === 'approach');
  const before = { input: { saved: {} } };
  const after = { input: { saved: { codingInspection: {} } } };
  const result = { question: 'Which target?', reason: 'The choice changes deployment.' };
  const ask = { arguments: { exit: 'ask_user', result, evidenceReferences: ['observation'] } };
  assert.deepEqual(nativeFinishTool(graph, node, before).function.parameters.properties.exit.enum, ['inspect_workspace']);
  assert.deepEqual(availableNativeExits(graph, node, after).map(edge => edge.id), ['ask_user', 'approach_ready']);
  assert.throws(() => validateNativeFinish(ask, graph, node, [], before), /allowed values/);
  assert.throws(() => validateNativeFinish(ask, graph, node, [{ requestId: 'observation', name: 'agent.report_status', success: true }], after), /authoritative evidence/);
  assert.equal(validateNativeFinish(ask, graph, node, [{ requestId: 'observation', name: 'workspace.list', success: true, result: { targetPlatform: 'win32' } }], after).id, 'ask_user');
});

test('an authoritative edit receipt advances only the exact active change without needing a model replay', () => {
  const changes = [{ id: 'first', title: 'Add source', status: 'active' }, { id: 'second', title: 'Add test', status: 'pending' }];
  assert.equal(recordAppliedCodeChange(changes, 'second', 'edit-1'), null);
  const applied = recordAppliedCodeChange(changes, 'first', 'edit-1');
  assert.deepEqual(applied.map(change => change.status), ['completed', 'active']);
  assert.equal(applied[0].evidenceReference, 'edit-1');
  assert.equal(recordAppliedCodeChange(applied, 'first', 'edit-1'), null);
  assert.doesNotThrow(() => validateCodeChangeSnapshot(applied, applied, [
    { name: 'workspace.edit', requestId: 'edit-1', success: true, appliedCodeChanges: applied },
  ]));
});

test('a non-model node can publish a bound chat status with its Historia attempt identity', async () => {
  const checkpoint = new Database(':memory:');
  __setAssistantDbForTests(new Database(':memory:'));
  try {
    const definition = starterPrimitiveAgent('Status smoke');
    delete definition.executionWorkflow;
    const receive = definition.nodes.find(node => node.id === 'receive');
    const respond = definition.nodes.find(node => node.id === 'respond');
    receive.settings.statusMessages = { start: { value: 'The workflow received the request.' } };
    respond.settings.input = { fields: { answerMarkdown: { path: 'entry.request' } } };
    definition.nodes = [receive, respond];
    definition.edges = [{ id: 'continue', name: 'Finish', source: receive.id, target: respond.id }];
    saveAssistantWorkflow('status-smoke', definition, 0);
    selectAssistantWorkflow('default', 'status-smoke');
    const runtime = new AssistantLangGraphRuntime({ toolHost: new ConsiliumToolHost({}), checkpointer: new SqliteSaver(checkpoint) });
    const conversation = createConversation({ workspaceId: 'default', surface: 'ai' });
    const result = await runtime.submit({ conversationId: conversation.id, content: 'Verification complete.', surface: 'ai' });
    const statuses = result.messages.filter(msg => msg.payload?.messageKind === 'node-status');
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].content, 'The workflow received the request.');
    assert.equal(statuses[0].payload.nodeId, 'receive');
    assert.ok(statuses[0].payload.nodeExecutionId);
    assert.ok(result.messages.some(msg => msg.payload?.finalAnswer && msg.content === 'Verification complete.'));
  } finally { checkpoint.close(); closeAssistantStore(); }
});

test('one completion action accepts fresh Linux or matching Windows evidence without requiring a prose summary', () => {
  const workflow = codingAgent();
  addTerminalCodingTools(workflow);
  assert.deepEqual(validatePrimitiveAgent(workflow), []);
  const verify = workflow.nodes.find(node => node.id === 'verify');
  const tool = (requestId, name, result) => ({ requestId, name, success: true, result });
  const edit = tool('edit', 'workspace.edit', { path: 'GitPrompt.ps1' });
  const wait = tool('wait', 'terminal.wait_for', { session_id: 'win', source: 'screen', matched_text: '[repo, main] [up0, down0, =0]>' });
  const screen = tool('screen', 'terminal.get_screen', { session_id: 'win', current_line: wait.result.matched_text });
  const close = tool('close', 'terminal.close', { session_id: 'win', state: 'closed', discarded: false });
  const linux = tool('linux', 'workspace.run', { verified: true });
  const finish = (observations, evidenceReferences) => validateNativeFinish({ arguments: { exit: 'answer', result: { answerMarkdown: 'Verified.' }, evidenceReferences } }, workflow, verify, observations);
  assert.equal(finish([edit, wait, screen, close], ['wait', 'screen', 'close']).id, 'answer');
  assert.equal(finish([edit, linux], ['linux']).id, 'answer');
  assert.equal(finish([edit, wait, screen, close], [{ requestId: 'wait', name: 'terminal.wait_for' }, 'screen', 'close']).id, 'answer');
  assert.throws(() => finish([edit, wait, screen, close], [{ requestId: 'wait', toolCallId: 'invented' }, 'screen', 'close']), /does not match/);
  assert.throws(() => finish([edit, wait, screen, { ...close, result: { ...close.result, discarded: true } }], ['wait', 'screen', 'close']), /discarded/);
  assert.throws(() => finish([edit, wait, screen, close], ['screen', 'close']), /Windows terminal verification.*terminal.wait_for/);
  assert.throws(() => finish([edit, wait, { ...screen, result: { ...screen.result, current_line: 'PS>' } }, close], ['wait', 'screen', 'close']), /current_line/);
  assert.throws(() => finish([edit, wait, screen, { ...close, result: { ...close.result, session_id: 'other' } }], ['wait', 'screen', 'close']), /session_id/);
  assert.throws(() => finish([linux, edit], ['linux']), /Linux behavior tests/);
  assert.throws(() => finish([wait, screen, close, edit], ['wait', 'screen', 'close']), /Windows terminal verification.*terminal.wait_for/);
});

test('split nested Ollama template errors are classified without leaking provider diagnostics', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.write('{"error":{"message":"Jinja Exception: ');
    setTimeout(() => res.end('System message must be at the beginning. private path"}}'), 10);
  });
  try {
    const response = await localModelGateway('http://langvision.local/api/ai/chat', { body: JSON.stringify({ baseAddress: url, model: 'fixture', messages: [] }) });
    const failure = await response.json();
    assert.equal(failure.code, 'model_template');
    assert.doesNotMatch(failure.error, /private path/);
  } finally { await close(server); }
});

test('the configured Ollama limit caps only local context and never raises a smaller request', () => {
  const env = { LANGVISION_LOCAL_OLLAMA_CONTEXT: '8192' };
  const options = { num_ctx: 16384, temperature: 0 };
  assert.deepEqual(boundedOllamaOptions('http://localhost:11434', options, env), { num_ctx: 8192, temperature: 0 });
  assert.equal(boundedOllamaOptions('http://127.0.0.1:11434', { num_ctx: 4096 }, env).num_ctx, 4096);
  assert.equal(boundedOllamaOptions('http://remote.example', options, env), options);
  assert.equal(boundedOllamaOptions('http://localhost', options, { LANGVISION_LOCAL_OLLAMA_CONTEXT: '0' }), options);
});

test('model response timing is controlled by the configured deadline', async () => {
  const { server, url } = await listen((_request, response) => {
    setTimeout(() => {
      if (!response.destroyed) response.end(JSON.stringify({ message: { content: 'slow answer' } }));
    }, 125);
  });
  const nodeId = 'slow';
  const invoke = timeoutMs => invokeGraphModel({ fetchImpl: localModelGateway, serviceBaseUrl: url,
    workflow: { nodes: [{ id: nodeId }] }, nodeId,
    profile: { model: 'fixture', timeoutMs }, body: { baseAddress: url, model: 'fixture', messages: [] } });
  try {
    await assert.rejects(invoke(30), { primitiveProviderFailure: true, message: /exceeded.*request timeout/ });
    const result = await (await invoke(2000)).json();
    assert.equal(result.message.content, 'slow answer');
  } finally { await close(server); }
});

test('a terminal provider transport error fails the turn instead of reentering its model node', async () => {
  __setAssistantDbForTests(new Database(':memory:'));
  const checkpoint = new Database(':memory:');
  try {
    const graph = starterPrimitiveAgent('Transport failure');
    graph.profileId = saveAiProfile({ displayName: 'Transport fixture', baseUrl: 'http://fixture', model: 'fixture' }).id;
    saveAssistantWorkflow('transport', graph, 0);
    selectAssistantWorkflow('transport-test', 'transport');
    const { id } = createConversation({ workspaceId: 'transport-test', surface: 'ai' });
    let requests = 0;
    const options = { contextBroker: {}, serviceBaseUrl: 'http://fixture', fetchImpl: async () => {
      requests++;
      return Response.json({ code: 'model_transport', error: 'Provider socket closed.' }, { status: 502 });
    } };
    const runtime = new AssistantLangGraphRuntime({ ...options, toolHost: new ConsiliumToolHost(options), checkpointer: new SqliteSaver(checkpoint) });
    const result = await runtime.submit({ conversationId: id, content: 'Submit once.', surface: 'ai', context: {} });
    assert.equal(result.state, 'failed');
    assert.match(result.messages.at(-1).content, /Provider socket closed/);
    assert.equal(requests, 1);
  } finally { checkpoint.close(); closeAssistantStore(); }
});

test('local startup migrates the legacy default but preserves explicitly selected custom agents', () => {
  __setAssistantDbForTests(new Database(':memory:'));
  try {
    selectAssistantWorkflow('default', activeAssistantWorkflow().id);
    provisionLocalCodingAgent({ LANGVISION_CODER_MODEL: 'fixture-coder' });
    const active = activeAssistantWorkflow();
    assert.equal(active.id, 'langvision-coding-agent');
    assert.equal(getAiProfile(active.definition.profileId).displayName, 'Default');
    assert.equal(getAiProfile(active.definition.profileId).thinkingMode, 'medium');
    assert.equal(getAiProfile(active.definition.nodes.find(node => node.id === 'reason').settings.profileId).model, 'fixture-coder');
    assert.throws(() => saveAiProfile({ displayName: ' default ' }), /reserved/);
    assert.throws(() => deleteAiProfile(active.definition.profileId), /Default/i);
    assert.equal(active.definition.nodes.find(node => node.id === 'plan_changes').settings.profileId, active.definition.profileId);
    assert.ok(active.definition.resources.skills.some(skill => skill.id === 'safe-project-edits'));
    assert.ok(active.definition.resources.skills.some(skill => skill.title === 'Authoring guidance'));
    saveAssistantWorkflow('custom', starterPrimitiveAgent('Custom'), 0);
    selectAssistantWorkflow('default', 'custom');
    provisionLocalCodingAgent({});
    assert.equal(activeAssistantWorkflow().id, 'custom');
    assert.equal(getAiProfile('langvision-default-code').model, 'fixture-coder');
  } finally { closeAssistantStore(); }
});

test('the code change snapshot advances one edit at a time with matching evidence', () => {
  const first = { id: 'source', title: 'Update source', status: 'active' };
  const second = { id: 'tests', title: 'Add tests', status: 'pending' };
  const original = [first, second];
  const completed = { ...first, status: 'completed', evidenceReference: 'edit-1' };
  const next = [completed, { ...second, status: 'active' }];
  const observations = [{ name: CODE_CHANGES_TOOL, success: true }, { name: 'workspace.edit', requestId: 'edit-1', success: true }];
  assert.doesNotThrow(() => validateCodeChangeSnapshot(original));
  assert.doesNotThrow(() => validateCodeChangeSnapshot(next, original, observations));
  assert.throws(() => validateCodeChangeSnapshot(next, original), /successful workspace.edit/);
  assert.throws(() => validateCodeChangeSnapshot([{ ...second, status: 'completed', evidenceReference: 'edit-1' }], original, observations), /only the active change/);
  assert.throws(() => validateCodeChangeSnapshot([second, first]), /first remaining change/);
  assert.throws(() => validateCodeChangeSnapshot([next[1]], next), /Keep completed changes/);
});

test('the terminal migration upgrades the default Coding Agent once without modifying historical revisions', () => {
  __setAssistantDbForTests(new Database(':memory:'));
  try {
    provisionLocalCodingAgent({});
    const original = activeAssistantWorkflow();
    assert.ok(!original.definition.edges.some(edge => edge.id === 'terminal_answer'));
    provisionLocalCodingAgent({}, { terminal: true });
    const updated = activeAssistantWorkflow();
    assert.equal(updated.id, original.id);
    assert.ok(updated.version > original.version);
    assert.ok(updated.definition.edges.some(edge => edge.id === 'interactive_terminal'));
    assert.ok(updated.definition.edges.some(edge => edge.id === 'terminal_answer'));
    assert.equal(updated.definition.edges.find(edge => edge.id === 'answer' && edge.source === 'verify').evidenceAlternatives.length, 2);
    assert.ok(updated.definition.nodes.find(node => node.id === 'verify_tools').settings.toolNames.includes('terminal.get_screen'));
    assert.equal(updated.definition.nodes.find(node => node.id === 'tools').settings.toolNames.filter(name => name.startsWith('terminal.')).length, 8);
    assert.ok(!original.definition.nodes.find(node => node.id === 'tools').settings.toolNames.includes('terminal.open'));
    provisionLocalCodingAgent({}, { terminal: true });
    assert.equal(activeAssistantWorkflow().version, updated.version);
  } finally { closeAssistantStore(); }
});

test('the agent can reorder its checklist and remove an out-of-scope task in one update', async () => {
  __setAssistantDbForTests(new Database(':memory:'));
  const checkpoint = new Database(':memory:');
  try {
    const profile = saveAiProfile({ displayName: 'Checklist fixture', baseUrl: 'http://fixture', model: 'fixture' });
    const definition = starterPrimitiveAgent('Checklist fixture', { tools: [{ name: 'agent.report_progress' }] });
    definition.profileId = profile.id;
    saveAssistantWorkflow('checklist-fixture', definition, 0);
    selectAssistantWorkflow('checklist-test', 'checklist-fixture');
    const conversation = createConversation({ workspaceId: 'checklist-test', surface: 'ai' });
    const first = { id: 'first', title: 'First', status: 'pending' };
    const second = { id: 'second', title: 'Second', status: 'pending' };
    const extra = { id: 'extra', title: 'Unrequested lint pass', status: 'pending' };
    let step = 0;
    const options = { contextBroker: {}, serviceBaseUrl: 'http://fixture', fetchImpl: async () => {
      const arguments_ = step === 0 ? { summary: 'Plan', tasks: [first, second, extra] }
        : { summary: 'Adjusted plan', tasks: [{ ...second, status: 'active' }, first], planChangeReason: 'Lint is out of scope.', currentTaskId: 'extra' };
      const call = step < 2 ? { name: 'agent.report_progress', arguments: arguments_ } : {
        name: 'finish_step', arguments: { exit: 'answer', result: { answerMarkdown: 'Finished.' }, evidenceReferences: [], summary: 'Finished' }
      };
      if (++step > 3) throw new Error('Stop fixture after two plans.');
      return Response.json({ message: { tool_calls: [{ id: 'checklist-' + step, function: call }] } });
    } };
    const runtime = new AssistantLangGraphRuntime({ ...options, toolHost: new ConsiliumToolHost(options), checkpointer: new SqliteSaver(checkpoint) });
    const result = await runtime.submit({ conversationId: conversation.id, content: 'Update my checklist.', surface: 'ai', context: {} });
    const turn = result.turns.at(-1);
    assert.deepEqual(turn.tasks.map(task => [task.title, task.status]), [['Second', 'active'], ['First', 'pending'], ['Unrequested lint pass', 'removed']]);
    assert.equal(turn.currentTaskId, turn.tasks[0].id);
  } finally { checkpoint.close(); closeAssistantStore(); }
});

async function listen(handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const objectSchema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] };

test('GPT-OSS uses the same safe Ollama wire alias in tool definitions, calls and observations', async () => {
  let sent;
  const logical = 'agent.report_progress';
  const { server, url } = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    sent = JSON.parse(Buffer.concat(chunks));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: { thinking: 'trace', tool_calls: [{ id: 'next', function: { name: sent.tools[0].function.name, arguments: { summary: 'Found it' } } }] } }));
  });
  try {
    const response = await localModelGateway('http://langvision.local/api/ai/chat', { body: JSON.stringify({ baseAddress: url, model: 'gpt-oss-120b-16k:latest',
      tools: [{ type: 'function', function: { name: logical, parameters: objectSchema } }],
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'prior', function: { name: logical, arguments: {} } }] },
        { role: 'tool', tool_call_id: 'prior', tool_name: logical, content: '{"success":true}' },
      ],
    }) });
    const alias = sent.tools[0].function.name;
    assert.match(alias, /^agent_report_progress_[a-f0-9]+$/);
    assert.equal(sent.messages[0].tool_calls[0].function.name, alias);
    assert.equal(sent.messages[1].tool_name, alias);
    assert.deepEqual((await response.json()).message, { thinking: 'trace', tool_calls: [{ id: 'next', function: { name: logical, arguments: { summary: 'Found it' } } }] });
  } finally { await close(server); }
});

test('local Ollama CUDA errors remain distinguishable from LangVision timeouts', async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'runner: CUDA error; private path' }));
  });
  try {
    const response = await localModelGateway('http://langvision.local/api/ai/chat', { body: JSON.stringify({ baseAddress: url, model: 'fixture', messages: [] }) });
    assert.equal(response.status, 500);
    const { error } = await response.json();
    assert.match(error, /CUDA runner failure/);
    assert.doesNotMatch(error, /private path/);
  } finally { await close(server); }
});

test('an exact approval survives checkpoint reopening and denial cannot execute a tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lv-approval-'));
  const checkpoints = join(root, 'checkpoints.sqlite');
  let checkpoint, writes = 0;
  __setAssistantDbForTests(new Database(':memory:'));
  const capability = { name: 'test.fixture_write', version: '1', risk: 'write', description: 'Record a fixture value.',
    schema: objectSchema, execute: async args => { writes++; return { saved: args.value }; } };
  ASSISTANT_CAPABILITIES.push(capability);
  try {
    const profile = saveAiProfile({ displayName: 'Fixture', baseUrl: 'http://fixture', model: 'fixture' });
    const definition = starterPrimitiveAgent('Approval fixture', { tools: [capability] });
    definition.profileId = profile.id;
    saveAssistantWorkflow('approval-fixture', definition, 0);
    selectAssistantWorkflow('approval-workspace', 'approval-fixture');
    const fetchImpl = async (_url, options) => {
      const last = JSON.parse(options.body).messages.at(-1);
      const observation = last.role === 'tool' ? JSON.parse(last.content) : null;
      const tool = observation ? { id: 'finish', function: { name: 'finish_step', arguments: {
        exit: observation.success ? 'answer' : 'unavailable', result: { answerMarkdown: observation.success ? 'Saved once.' : 'Denied.' },
        evidenceReferences: observation.success ? [observation.requestId] : [], summary: 'Used the exact approval outcome.',
      } } } : { id: 'write', function: { name: capability.name, arguments: { value: 'fixture' } } };
      return Response.json({ message: { tool_calls: [tool] } });
    };
    const reopen = () => {
      checkpoint?.close();
      checkpoint = new Database(checkpoints);
      const options = { contextBroker: {}, fetchImpl, serviceBaseUrl: 'http://fixture' };
      return new AssistantLangGraphRuntime({ ...options, toolHost: new ConsiliumToolHost(options), checkpointer: new SqliteSaver(checkpoint) });
    };
    for (const choice of ['approve', 'deny']) {
      const conversation = createConversation({ workspaceId: 'approval-workspace', surface: 'ai' });
      const pending = await reopen().submit({ conversationId: conversation.id, content: 'Save the fixture.', surface: 'ai', context: {} });
      assert.equal(pending.state, 'awaiting-clarification');
      const executionId = pending.messages.find(message => message.role === 'user').id;
      assert.equal(assistantDebugDatabase().prepare('SELECT started_ms FROM ai_active_budgets WHERE execution_id=?').get(executionId).started_ms, null);
      assert.equal(writes, choice === 'approve' ? 0 : 1);
      const result = await reopen().clarify(pending.clarification.id, choice);
      assert.equal(result.state, choice === 'approve' ? 'idle' : 'needs-attention');
      assert.equal(result.messages.filter(message => message.payload?.finalAnswer).length, 1);
      assert.equal(writes, 1);
    }
  } finally {
    checkpoint?.close();
    closeAssistantStore();
    ASSISTANT_CAPABILITIES.splice(ASSISTANT_CAPABILITIES.indexOf(capability), 1);
    await rm(root, { recursive: true, force: true });
  }
});

test('cancel aborts a waiting provider immediately and clears its live activity', async () => {
  __setAssistantDbForTests(new Database(':memory:'));
  const checkpoint = new Database(':memory:');
  try {
    const profile = saveAiProfile({ displayName: 'Slow fixture', baseUrl: 'http://fixture', model: 'slow-fixture' });
    const definition = starterPrimitiveAgent('Slow fixture');
    definition.profileId = profile.id;
    saveAssistantWorkflow('slow-fixture', definition, 0);
    selectAssistantWorkflow('slow-workspace', 'slow-fixture');
    const conversation = createConversation({ workspaceId: 'slow-workspace', surface: 'ai' });
    const options = { contextBroker: {}, serviceBaseUrl: 'http://fixture', fetchImpl: async (_url, { signal }) => {
      if (!signal.aborted) await once(signal, 'abort');
      signal.throwIfAborted();
    } };
    const runtime = new AssistantLangGraphRuntime({ ...options, toolHost: new ConsiliumToolHost(options), checkpointer: new SqliteSaver(checkpoint) });
    const emitter = runtime.emitter(conversation.id);
    const activity = new Promise(resolve => {
      const listener = event => {
        if (event.type !== 'model-activity' || !event.activity) return;
        emitter.off('event', listener);
        resolve(event.activity);
      };
      emitter.on('event', listener);
    });
    const turn = runtime.submit({ conversationId: conversation.id, content: 'Wait for the model.', surface: 'ai', context: {} });
    assert.equal((await activity).model, 'slow-fixture');
    assert.equal(runtime.activity(conversation.id).node, 'Investigate and respond');
    assert.equal(runtime.cancel(conversation.id), true);
    assert.equal((await turn).state, 'interrupted');
    assert.equal(runtime.activity(conversation.id), null);
  } finally { checkpoint.close(); closeAssistantStore(); }
});

test('MCP discovery and standalone package round-trip do not activate imported endpoints', async () => {
  let calls = 0;
  const { server, url } = await listen(async (req, res) => {
    const mcp = new Server({ name: 'unrelated echo', version: '1' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [
      { name: 'echo', inputSchema: objectSchema }, { name: 'not-allowed', inputSchema: objectSchema },
    ] }));
    mcp.setRequestHandler(CallToolRequestSchema, ({ params }) => {
      calls++;
      return { content: [], structuredContent: { value: params.arguments.value } };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  try {
    __setAssistantDbForTests(new Database(':memory:'));
    saveMcpConnection({ id: 'unrelated', url, enabled: true, tools: ['echo'] });
    assert.deepEqual((await refreshMcpConnection('unrelated')).enabled, ['unrelated.echo']);
    assert.equal(capabilityByName('unrelated.not-allowed'), undefined);
    assert.equal(capabilityByName('unrelated.echo').risk, 'write', 'External tool annotations do not confer permission.');
    const definition = starterPrimitiveAgent('Portable fixture', { tools: [{ name: 'unrelated.echo' }],
      skills: [{ id: 'example', title: 'Example', description: 'Fixture', version: 1, body: 'Inline portable skill.' }] });
    saveAssistantWorkflow('portable', definition, 0);
    const bundle = exportAgentPackage('portable');
    assert.equal(bundle.definition.resources.skills[0].body, 'Inline portable skill.');
    assert.equal(bundle.mcp.length, 1);
    assert.ok(!JSON.stringify(bundle).includes('tokenEnv'));
    assert.equal(calls, 0, 'Discovery and export did not invoke a tool.');
    assert.deepEqual(await capabilityByName('unrelated.echo').execute({ value: 'fixture' }, {}), { value: 'fixture' });
    assert.equal(calls, 1);
    closeAssistantStore();

    __setAssistantDbForTests(new Database(':memory:'));
    const activeBefore = activeAssistantWorkflow('default').id;
    const imported = importAgentPackage(JSON.parse(JSON.stringify(bundle)));
    assert.notEqual(imported.id, 'portable');
    assert.equal(activeAssistantWorkflow('default').id, activeBefore);
    const draft = listAssistantWorkflowDrafts().find(item => item.id === imported.id);
    assert.deepEqual(draft.definition.resources.skills, definition.resources.skills);
    assert.equal(draft.definition.executionWorkflow.name, definition.executionWorkflow.name);
    assert.ok(draft.definition.nodes.find(node => node.id === 'reason').settings.toolNames.includes(imported.mcp[0] + '.echo'));
    assert.equal(mcpConnections()[0].enabled, false);
    assert.equal(calls, 1, 'Import did not contact the external endpoint.');
    await assert.rejects(refreshMcpConnection(imported.mcp[0]), /Enable/);
    assert.throws(() => importAgentPackage({ ...bundle, mcp: [{ ...bundle.mcp[0], apiKey: 'synthetic-secret' }] }), /credentials/);
    assert.throws(() => importAgentPackage({ ...bundle, definition: { ...bundle.definition, edges: [] } }));
    assert.equal(listAssistantWorkflowDrafts().length, 1, 'Invalid import left no partial draft.');
  } finally { closeAssistantStore(); await close(server); }
});

test('OpenAI-compatible gateway preserves native tool identities and reasoning separately', async () => {
  const { server, url } = await listen(async (req, res) => {
    const body = JSON.parse(await Array.fromAsync(req).then(parts => Buffer.concat(parts)));
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer fixture-only');
    assert.notEqual(body.tools[0].function.name, 'tools.with.dots');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: 'fixture', usage: { prompt_tokens: 2 }, choices: [{ message: {
      content: '', reasoning_content: 'provider-returned fixture', tool_calls: [{ id: 'call-1', type: 'function',
        function: { name: body.tools[0].function.name, arguments: '{"value":"hello"}' } }],
    } }] }));
  });
  try {
    const response = await localModelGateway('http://local/api/ai/chat', { body: JSON.stringify({
      baseAddress: url + '/v1', model: 'fixture', connection: { authMode: 'bearer', apiKey: 'fixture-only' },
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'tools.with.dots', parameters: objectSchema } }],
    }) });
    const value = await response.json();
    assert.equal(response.status, 200);
    assert.equal(value.message.tool_calls[0].id, 'call-1');
    assert.equal(value.message.tool_calls[0].function.name, 'tools.with.dots');
    assert.equal(value.message.thinking, 'provider-returned fixture');
  } finally { await close(server); }
});

test('standalone MCP client can read and commit only an independently approved Chronusphaera action', {
  skip: !process.env.LANGVISION_CHRONUS_FIXTURE,
}, async () => {
  const endpoint = new URL(process.env.LANGVISION_CHRONUS_FIXTURE);
  assert.equal(endpoint.origin, 'http://127.0.0.1:17877', 'This test is restricted to the disposable fixture port.');
  __setAssistantDbForTests(new Database(':memory:'));
  process.env.LANGVISION_SECRET_TEST_MCP = 'fixture-cross-service-client';
  const tools = ['speculum.inspect_widgets', 'speculum.add_widget', 'chronusphaera.operation_status', 'chronusphaera.operation_commit'];
  try {
    saveMcpConnection({ id: 'chronus', url: new URL('/mcp', endpoint).href, enabled: true, tokenEnv: 'LANGVISION_SECRET_TEST_MCP', tools });
    assert.equal((await refreshMcpConnection('chronus')).enabled.length, tools.length);
    const invoke = (name, args = {}) => capabilityByName('chronus.' + name).execute(args, {});
    const prior = await invoke('speculum.inspect_widgets');
    assert.equal(prior.scope, 'scope:workspace:standalone-fixture');
    const prepared = await invoke('speculum.add_widget', { requestKey: 'integration-approve', widgetType: 'inspector', reason: 'Review the fixture event.' });
    const payload = { operationId: prepared.operationId };
    assert.equal((await invoke('chronusphaera.operation_commit', payload)).status, 'pending');
    const decide = (operation, decision) => fetch(new URL('/api/mcp-operator/operations/' + operation.operationId + '/decision', endpoint), {
      method: 'POST', headers: { Authorization: 'Bearer fixture-cross-service-operator', 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, revision: operation.revision }),
    });
    assert.equal((await decide(prepared, 'approved')).status, 200);
    const outcome = await invoke('chronusphaera.operation_commit', payload);
    assert.equal(outcome.status, 'committed');
    assert.deepEqual(await invoke('chronusphaera.operation_status', payload), outcome);
    assert.deepEqual(await invoke('chronusphaera.operation_commit', payload), outcome);
    const denied = await invoke('speculum.add_widget', { requestKey: 'integration-deny', widgetType: 'nodeInspector', reason: 'Do not apply this fixture.' });
    assert.equal((await decide(denied, 'denied')).status, 200);
    assert.equal((await invoke('chronusphaera.operation_commit', { operationId: denied.operationId })).status, 'denied');
    const layout = await (await fetch(new URL('/api/layout/chronoscope-default?scope=scope%3Aworkspace%3Astandalone-fixture', endpoint))).json();
    assert.equal(layout.widgets.filter(widget => widget.id === 'inspector').length, 1);
    assert.equal(layout.widgets.some(widget => widget.id === 'nodeInspector'), false);
  } finally { delete process.env.LANGVISION_SECRET_TEST_MCP; closeAssistantStore(); }
});
