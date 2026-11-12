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
import { __setAssistantDbForTests, activeAssistantWorkflow, closeAssistantStore, createConversation, listAssistantWorkflowDrafts, saveAssistantWorkflow, saveAiProfile, selectAssistantWorkflow } from './assistantStore.js';
import { starterPrimitiveAgent } from '../shared/primitiveAgentStarter.js';
import { ASSISTANT_CAPABILITIES, capabilityByName, mcpConnections, refreshMcpConnection, saveMcpConnection } from './assistantCapabilities.js';
import { AssistantLangGraphRuntime } from './assistantGraph.js';
import { ConsiliumToolHost } from './assistantAgent.js';
import { exportAgentPackage, importAgentPackage } from './agentPackage.js';
import { localModelGateway } from './modelGateway.js';

async function listen(handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const objectSchema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] };

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
