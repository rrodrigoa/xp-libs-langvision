import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import JSZip from 'jszip';
import { encodeAgentZip, decodeAgentZip } from './agentZip.js';
import { createCodingWorkspace, runContainer } from './codingWorkspace.js';
import { codingAgent } from '../shared/codingAgent.js';
import { validatePrimitiveAgent } from '../shared/primitiveAgentModel.js';
import { publicAddress, researchMcp } from './researchMcp.js';
import { nativeModelMessages, validateNativeFinish } from '../shared/primitiveNativeProtocol.js';
import Database from 'better-sqlite3';
import { activeBudget, modelTimeoutMs } from './assistantDeadlines.js';

test('local deadlines are configurable and approval wait does not consume the pinned budget', () => {
  assert.equal(modelTimeoutMs({}, {}), 900_000);
  assert.equal(modelTimeoutMs({}, { LANGVISION_OLLAMA_TIMEOUT_MINUTES: '22' }), 1_320_000);
  assert.equal(modelTimeoutMs({ timeoutMs: 1000 }, {}), 1000);
  assert.equal(modelTimeoutMs({ provider: 'openai-compatible' }, {}), 120_000);
  const db = new Database(':memory:');
  try {
    let time = 1000;
    const first = activeBudget(db, 'turn', 100, new AbortController(), () => time);
    time += 60;
    first();
    time += 60_000;
    const resume = new AbortController();
    const finish = activeBudget(db, 'turn', 200, resume, () => time);
    assert.equal(resume.signal.aborted, false);
    time += 40;
    finish();
    const exhausted = new AbortController();
    activeBudget(db, 'turn', 200, exhausted, () => time)();
    assert.equal(exhausted.signal.reason.code, 'agent_active_timeout');
  } finally { db.close(); }
});

test('web research refuses private and special-use IPv4 and IPv6 destinations', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', '::ffff:127.0.0.1', 'fd00::1', 'not-an-ip']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});

test('research exposes native MCP tools, returns source evidence and blocks local fetches', async () => {
  const app = express();
  app.use(express.json());
  app.get('/search', (req, res) => res.json({ results: [{ title: req.query.q, url: 'https://example.com/docs', content: 'Reference material' }] }));
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  app.post('/mcp', researchMcp(base + '/search'));
  const client = new Client({ name: 'LangVision test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['search', 'fetch']);
    const found = await client.callTool({ name: 'search', arguments: { query: 'official references' } });
    assert.equal(found.structuredContent.sources[0].title, 'official references');
    assert.equal(found.structuredContent.untrusted, true);
    const denied = await client.callTool({ name: 'fetch', arguments: { url: 'http://127.0.0.1/' } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /blocked/);
  } finally {
    await client.close();
    const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed;
  }
});

test('coding graph survives a deterministic ZIP round trip', async () => {
  const definition = codingAgent();
  assert.deepEqual(validatePrimitiveAgent(definition), []);
  const implement = definition.nodes.find(node => node.id === 'reason');
  const verify = definition.nodes.find(node => node.id === 'verify');
  assert.ok(!implement.settings.toolNames.includes('workspace.run'));
  assert.ok(verify.settings.toolNames.includes('workspace.run'));
  assert.equal(definition.edges.find(edge => edge.id === 'answer').source, verify.id);
  const pkg = JSON.parse(JSON.stringify({ format: 'langvision/agent-package-v1', definition, mcp: [], modelProfiles: [] }));
  const archive = await encodeAgentZip(pkg);
  assert.deepEqual(await encodeAgentZip(pkg), archive);
  assert.deepEqual(await decodeAgentZip(archive), pkg);
  const zip = await JSZip.loadAsync(archive);
  zip.file('agent.json', '{}');
  await assert.rejects(decodeAgentZip(await zip.generateAsync({ type: 'nodebuffer' })), /digest/);
  zip.file('unexpected.txt', 'extra');
  await assert.rejects(decodeAgentZip(await zip.generateAsync({ type: 'nodebuffer' })), /exactly/);
  zip.remove('unexpected.txt');
  zip.file('agent.json', 'x'.repeat(5 * 1024 * 1024));
  await assert.rejects(decodeAgentZip(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })), /limit/);
});

test('implementation gets the saved task IDs instead of starting a new plan', () => {
  const definition = codingAgent();
  const node = definition.nodes.find(item => item.id === 'reason');
  const tasks = [{ id: 'deliver', title: 'Deliver the artifact', status: 'pending' }];
  const latestObservation = { name: 'workspace.list', requestId: 'listing', success: true, result: { files: [] } };
  const messages = nativeModelMessages({ workflow: definition, node, input: { targetPlatform: 'win32' }, progress: { tasks }, latestObservation });
  const input = JSON.parse(messages.at(-1).content);
  assert.deepEqual(input.currentChecklist, tasks);
  assert.deepEqual(input.latestSuccessfulToolResult, latestObservation);
});

test('inspection accepts either recorded tool identity but rejects invented platform facts', () => {
  const workflow = codingAgent();
  const node = workflow.nodes.find(item => item.id === 'inspect');
  const observations = [{ name: 'workspace.list', requestId: 'native', toolCallId: 'persisted', success: true, result: { targetPlatform: 'win32', files: [] } }];
  const call = { arguments: { exit: 'implement', result: { targetPlatform: 'win32', files: [] }, evidenceReferences: ['persisted'], summary: 'Inspected' } };
  assert.equal(validateNativeFinish(call, workflow, node, observations).id, 'implement');
  call.arguments.result.targetPlatform = 'linux';
  assert.throws(() => validateNativeFinish(call, workflow, node, observations), /evidence checks failed/);
});

test('workspace denies ungranted access and stale writes, then supports approved lifecycle', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'langvision-test-'));
  try {
    const root = path.join(base, 'workspace'), sibling = path.join(base, 'workspace-other');
    await mkdir(root); await mkdir(sibling);
    await writeFile(path.join(sibling, 'secret.txt'), 'private');
    await symlink(sibling, path.join(root, 'escape'), 'junction');
    const workspace = createCodingWorkspace({ runner: async input => ({ exitCode: 0, files: input.files }) });
    const tool = name => workspace.tools.find(item => item.name === 'workspace.' + name);
    const edit = tool('edit'), run = tool('run');
    const file = { operation: 'write', path: 'app.py', contents: 'print(42)' };
    const approve = (item, args) => ({ approvedAt: new Date().toISOString(), expectedRevision: item.revision(args) });
    assert.throws(() => tool('list').execute({}), /Grant access/);
    workspace.grant(root, false);
    assert.deepEqual(tool('list').execute({ directory: '.' }).files, []);
    assert.throws(() => edit.revision(file), /read-only/);
    assert.throws(() => tool('read').execute({ path: 'escape/secret.txt' }), /unsafe/);
    assert.throws(() => tool('read').execute({ path: '../workspace-other/secret.txt' }), /outside/);
    workspace.grant(root, true);
    assert.throws(() => edit.execute(file, {}), /approval/);
    const stale = approve(edit, file);
    await writeFile(path.join(root, 'app.py'), 'outside edit');
    assert.throws(() => edit.execute(file, {}, stale), /approval/);
    edit.execute(file, {}, approve(edit, file));
    assert.equal(await readFile(path.join(root, 'app.py'), 'utf8'), file.contents);
    const cmd = { shell: 'bash', command: 'python app.py' };
    assert.equal((await run.execute(cmd, {}, approve(run, cmd))).files[0].contents, file.contents);
    const rename = { operation: 'rename', path: 'app.py', destination: 'main.py' };
    edit.execute(rename, {}, approve(edit, rename));
    const remove = { operation: 'delete', path: 'main.py' };
    const deleted = edit.execute(remove, {}, approve(edit, remove));
    assert.equal(await readFile(path.join(root, deleted.recoveryName), 'utf8'), file.contents);
    assert.deepEqual(tool('list').execute({}).files, []);
    const approved = approve(edit, file);
    workspace.revoke();
    assert.throws(() => edit.execute(file, {}, approved), /Grant access/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('Docker runs Python as non-root with no host mounts', { skip: !process.env.LANGVISION_DOCKER_TEST }, async () => {
  const result = await runContainer({ shell: 'bash', command: 'python main.py', image: 'python:3.12-slim',
    files: [{ path: 'main.py', contents: 'import os; assert os.getuid() != 0; assert not os.path.exists("/var/run/docker.sock"); print("isolated")' }] });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /isolated/);
  const timeout = await runContainer({ shell: 'bash', command: 'sleep 60', image: 'python:3.12-slim', files: [], timeoutMs: 1500 });
  assert.match(timeout.error, /timed out/);
});
