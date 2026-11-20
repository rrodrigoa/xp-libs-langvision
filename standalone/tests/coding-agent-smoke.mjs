import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { starterPrimitiveAgent } from '../shared/primitiveAgentStarter.js';

const dir = await mkdtemp(path.join(tmpdir(), 'langvision-coding-demo-'));
const workspace = path.join(dir, 'workspace');
await mkdir(workspace);
const port = Number(process.env.LANGVISION_CODING_SMOKE_PORT ?? 18783);
assert.ok(Number.isInteger(port) && port >= 18000 && port <= 18999, 'Use a disposable smoke-test port.');
const baseURL = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: new URL('../', import.meta.url), stdio: 'inherit',
  env: { ...process.env, PORT: String(port), LANGVISION_BIND: '127.0.0.1', LANGVISION_PUBLIC_ORIGIN: '',
    LANGVISION_OPERATOR_PASSWORD: '', LANGVISION_DB: path.join(dir, 'demo.sqlite') }
});
const stopped = once(server, 'exit');
let browser;
let fakeModel;
try {
  for (let i = 0; ; i++) {
    if (server.exitCode !== null || i >= 60) throw new Error('Disposable LangVision server did not start.');
    if (await fetch(baseURL + '/api/ready').then(response => response.ok, () => false)) break;
    await delay(250);
  }
  browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ baseURL, viewport: { width: 1700, height: 1050 } });
  const errors = [];
  const modelIds = new Set();
  page.on('pageerror', error => errors.push(error.message));
  async function request(method, url, options) {
    const response = await page.request.fetch(url, { method, timeout: 65 * 60_000, ...options });
    assert.ok(response.ok(), await response.text());
    return response.json();
  }
  await page.goto('/');
  await page.getByTestId('ai-primitive-designer').waitFor();
  const seeded = await request('GET', '/api/assistant/workflows');
  assert.equal(seeded.activeId, 'langvision-coding-agent');
  const builtIn = seeded.workflows.find(item => item.id === seeded.activeId);
  assert.equal(builtIn.definition.name, 'Coding Agent');
  assert.ok(builtIn.definition.resources.skills.some(skill => skill.id === 'behavior-verification'));
  assert.ok(seeded.tools.some(tool => tool.name === 'workspace.edit'));
  assert.ok(seeded.tools.some(tool => tool.name === 'web.fetch'));
  const builtInProfiles = await request('GET', '/api/assistant/profiles');
  assert.deepEqual((builtInProfiles.profiles ?? builtInProfiles).map(profile => profile.displayName).sort(), ['Coding', 'Default']);
  assert.equal((await page.request.delete(`/api/assistant/profiles/${builtIn.definition.profileId}`, { data: {} })).status(), 409);
  const rejected = await page.request.post('/api/agent-packages', { headers: { 'Content-Type': 'application/zip' }, data: Buffer.from('not a ZIP') });
  assert.equal(rejected.status(), 422);
  assert.equal((await page.request.post('/api/coding/run', { data: { command: 'echo must-not-run' } })).status(), 404);
  assert.equal((await page.request.post('/api/coding-workspace/revoke', { headers: { 'Content-Type': 'application/zip' }, data: Buffer.from('not JSON') })).status(), 403);
  await page.getByRole('button', { name: 'Packages', exact: true }).click();
  await page.getByLabel('Import package').setInputFiles({
    name: 'coding-agent.langvision.zip', mimeType: 'application/zip',
    buffer: await readFile(new URL('../../examples/coding-agent/coding-agent.langvision.zip', import.meta.url))
  });
  await page.getByRole('status').filter({ hasText: 'Draft imported' }).waitFor();
  const listing = await request('GET', '/api/assistant/workflows');
  const draft = listing.workflows.find(item => item.definition.name === 'Coding Agent' && item.id !== listing.activeId);
  assert.ok(draft && listing.activeId !== draft.id);
  const profile = await request('POST', '/api/assistant/profiles', { data: {
    displayName: 'Coding test model', baseUrl: 'http://127.0.0.1:11434', model: process.env.LANGVISION_SMOKE_MODEL ?? 'qwen3-coder:30b',
    numCtx: 32768, temperature: 0, seed: 42, thinkingMode: 'off',
  } });
  const planner = await request('POST', '/api/assistant/profiles', { data: {
    displayName: 'Planning test model', baseUrl: 'http://127.0.0.1:11434', model: process.env.LANGVISION_PLANNER_MODEL ?? 'gpt-oss-120b-32k:latest',
    numCtx: 32768, temperature: 0, seed: 42, thinkingMode: 'low',
  } });
  const inspector = await request('POST', '/api/assistant/profiles', { data: {
    displayName: 'Inspection model', baseUrl: 'http://127.0.0.1:11434',
    model: process.env.LANGVISION_INSPECTOR_MODEL ?? 'qwen3:8b', numCtx: 8192, temperature: 0, seed: 42, thinkingMode: 'off',
  } });
  await request('PUT', '/api/assistant/workspace/default/profile', { data: { profileId: inspector.id } });
  await page.reload();
  const card = page.getByTestId('ai-agent-node-plan');
  await card.waitFor();
  assert.match(await card.evaluate(node => getComputedStyle(node).backgroundColor), /^rgb\(/);
  await card.getByRole('button', { name: 'Edit Plan requested work' }).click();
  const discover = page.waitForRequest(req => new URL(req.url()).pathname === '/api/assistant/models');
  await page.route('**/api/assistant/models', route => route.fulfill({ json: { models: [{ name: 'discovered-fixture:latest', digest: 'fixture-digest' }] } }));
  const settings = page.locator('.lv-node-dialog');
  await settings.getByText('Manage model profiles', { exact: true }).click();
  await discover;
  await settings.getByTestId('assistant-profile-new').click();
  await settings.getByTestId('assistant-profile-name').fill('Temporary smoke connection');
  await settings.getByTestId('assistant-profile-model').selectOption('discovered-fixture:latest');
  assert.equal(await settings.getByLabel(/context (size|tokens)/i).count(), 0);
  await settings.getByTestId('assistant-profile-save').click();
  await settings.getByRole('button', { name: 'Delete connection', exact: true }).click();
  await settings.getByRole('group', { name: 'Confirm connection deletion' }).getByRole('button', { name: 'Confirm delete' }).click();
  await settings.getByRole('group', { name: 'Confirm connection deletion' }).waitFor({ state: 'hidden' });
  await page.unroute('**/api/assistant/models');
  await page.getByTestId('ai-primitive-profile').selectOption(planner.id);
  assert.ok(await page.locator('.lv-node-dialog').isVisible());
  await page.getByTestId('ai-primitive-save-node').click();
  await page.getByTestId('ai-agent-node-reason').getByRole('button', { name: 'Edit Implement source' }).click();
  await page.getByTestId('ai-primitive-profile').selectOption(profile.id);
  await page.getByTestId('ai-primitive-save-node').click();
  await page.getByTestId('ai-agent-node-verify').getByRole('button', { name: 'Edit Write and run behavior tests' }).click();
  await page.getByTestId('ai-primitive-profile').selectOption(profile.id);
  await page.getByTestId('ai-primitive-save-node').click();
  await page.getByTestId('ai-agent-save').click();
  await page.waitForFunction(async ({ id, plan, code }) => {
    const { workflows } = await (await fetch('/api/assistant/workflows')).json();
    const nodes = workflows.find(item => item.id === id)?.definition.nodes ?? [];
    return nodes.find(node => node.id === 'plan')?.settings.profileId === plan &&
      nodes.find(node => node.id === 'reason')?.settings.profileId === code &&
      nodes.find(node => node.id === 'verify')?.settings.profileId === code;
  }, { id: draft.id, plan: planner.id, code: profile.id });
  const saved = (await request('GET', '/api/assistant/workflows')).workflows.find(item => item.id === draft.id);
  await request('POST', '/api/assistant/workflows/' + draft.id + '/activate', { data: { expectedDraftVersion: saved.draftVersion } });
  await page.getByRole('button', { name: 'Coding Workspace', exact: true }).click();
  await page.getByText('workspace.edit', { exact: true }).waitFor();
  await page.getByText('web.fetch', { exact: true }).waitFor();
  if (process.platform === 'win32') {
    await page.getByText('terminal.open', { exact: true }).waitFor();
    await page.getByRole('checkbox', { name: 'Allow agent-controlled PowerShell' }).waitFor();
    assert.equal(await page.getByRole('checkbox', { name: 'Allow agent-controlled PowerShell' }).isChecked(), false);
  }
  await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
  assert.ok(await page.locator('.lv-chat-expanded').isVisible());
  await page.getByRole('button', { name: 'Restore chat width' }).click();
  const divider = page.getByRole('separator', { name: 'Resize agent chat' });
  await divider.press('Home');
  assert.equal(await divider.getAttribute('aria-valuenow'), '50');
  await page.getByLabel('Local folder').fill(workspace);
  await page.getByLabel('Allow the agent to request file edits').check();
  if (process.platform === 'win32') await page.getByRole('checkbox', { name: 'Allow agent-controlled PowerShell' }).check();
  await page.getByRole('button', { name: 'Grant access' }).click();
  await page.getByRole('status').filter({ hasText: 'Read and propose edits:' }).waitFor();
  if (process.platform === 'win32') {
    await page.getByText('Agent-controlled PowerShell is enabled for this grant.').waitFor();
    assert.equal((await request('GET', '/api/coding-workspace')).terminal, true);
  }
  if (!process.env.LANGVISION_REAL_CODING) {
    let release;
    let modelCalls = 0;
    const waiting = new Promise(resolve => { release = resolve; });
    fakeModel = createServer(async (req, res) => {
      if (req.url !== '/api/chat') { res.writeHead(404).end(); return; }
      for await (const _chunk of req) { /* Drain the request before waiting. */ }
      await waiting;
      const call = ++modelCalls === 1 ? { id: 'progress-fixture', function: {
        name: 'agent.report_progress', arguments: { summary: 'Checked the browser fixture.', tasks: [{ id: 'fixture', title: 'Check the browser fixture', status: 'blocked', reason: 'Intentional fixture for the JSON inspector.' }] }
      } } : { id: 'finish', function: {
        name: 'finish_step', arguments: { exit: 'answer', result: { answerMarkdown: 'Smoke verified.' }, evidenceReferences: [], summary: 'Smoke test' }
      } };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: { tool_calls: [call] } }));
    }).listen(0, '127.0.0.1');
    await once(fakeModel, 'listening');
    const fake = await request('POST', '/api/assistant/profiles', { data: {
      displayName: 'Slow browser fixture', model: 'slow-browser-fixture', baseUrl: 'http://127.0.0.1:' + fakeModel.address().port,
    } });
    const generic = starterPrimitiveAgent('Browser history fixture', { tools: [{ name: 'agent.report_progress' }] });
    delete generic.resources.bootstrapRequired;
    generic.profileId = fake.id;
    const fixtureAgent = await request('POST', '/api/assistant/workflows', { data: { definition: generic } });
    await request('POST', '/api/assistant/workflows/' + fixtureAgent.id + '/activate', { data: {} });
    await request('PUT', '/api/assistant/workspace/default/profile', { data: { profileId: fake.id } });
    await page.evaluate(id => localStorage.setItem('consilium-designer-default', id), fixtureAgent.id);
    await page.reload();
    await page.getByTestId('ai-agent-node-reason').waitFor();
    const conversation = (await request('GET', '/api/assistant/conversations')).conversations[0];
    assert.ok(conversation?.id);
    const submitted = request('POST', '/api/assistant/conversations/' + conversation.id + '/messages', { data: { content: 'Verify waiting for a model.', surface: 'ai' } });
    void submitted.catch(() => {});
    const runningNode = page.locator('[data-testid="ai-agent-node-reason"][data-running="true"]');
    await runningNode.waitFor();
    assert.equal(await runningNode.evaluate(node => getComputedStyle(node).animationName), 'lv-node-pulse');
    await page.getByRole('button', { name: 'Historia', exact: true }).click();
    await page.getByRole('button', { name: /Verify waiting for a model/ }).first().click();
    assert.match(await page.getByRole('textbox', { name: 'Run ID' }).inputValue(), /^message-/);
    await page.getByTestId('ai-waterfall-active-model').filter({ hasText: /Investigate and respond.*slow-browser-fixture.*elapsed/ }).waitFor();
    release();
    assert.ok((await submitted).messages.some(message => message.content === 'Smoke verified.'));
    await page.reload();
    await page.getByRole('button', { name: 'Historia', exact: true }).click();
    await page.getByRole('button', { name: /Verify waiting for a model/ }).first().click();
    await page.getByText('Objective state / JSON', { exact: true }).click();
    const objective = page.getByTestId('ai-extracted-objectives');
    const foldControl = objective.locator('.margin-view-overlays [class*="codicon-folding-"]').first();
    await foldControl.waitFor({ timeout: 8000 }).catch(async error => {
      throw new Error(`Expected objective fold controls. Inspector: ${await objective.innerText()}; errors: ${errors.join('; ')}`, { cause: error });
    });
    assert.equal(await foldControl.evaluate(node => getComputedStyle(node, '::before').content), '""');
    const initial = await foldControl.getAttribute('class');
    await foldControl.click();
    await foldControl.evaluate((node, before) => { if (node.className === before) throw new Error('Objective fold did not toggle'); }, initial);
    assert.deepEqual(errors, []);
    console.log('ZIP import, activation, opaque graph, node model selection, workspace grant, and live model status verified.');
  } else {
    const started = performance.now();
    const prompt = 'write me a python Tetris game for the console';
    console.log('Generating in disposable workspace:', workspace);
    const conversation = await request('POST', '/api/assistant/conversations', { data: { surface: 'ai' } });
    let result = await request('POST', '/api/assistant/conversations/' + conversation.id + '/messages', { data: { content: prompt, surface: 'ai' } });
    for (let n = 0; result.clarification?.status === 'pending' && n < 16; n++) {
      const pending = result.clarification;
      assert.equal(pending.presentation?.kind, 'approval', JSON.stringify(pending));
      for (const action of pending.presentation.actions) {
        assert.ok(['workspace.edit', 'workspace.run'].includes(action.name));
        assert.ok(action.preview);
        console.log('Approving isolated fixture action:', action.preview.summary, action.preview.command ?? '');
      }
      result = await request('POST', '/api/assistant/clarifications/' + pending.id + '/respond', { data: { response: 'approve' } });
    }
    const files = await import('node:fs/promises').then(fs => fs.readdir(workspace));
    console.log('Acceptance metrics:', JSON.stringify({ model: profile.model, state: result.state,
      elapsedSeconds: Math.round((performance.now() - started) / 1000), files,
      commands: (result.toolCalls ?? []).filter(call => call.name === 'workspace.run').map(call => ({
        command: call.arguments.command, exitCode: call.result?.exitCode, error: call.error ?? call.result?.error,
      })) }));
    assert.equal(result.state, 'idle', JSON.stringify(result.messages?.at(-1)));
    assert.ok(result.messages.some(message => message.payload?.finalAnswer));
    assert.ok(files.some(file => /\.py$/i.test(file) && !/^test/i.test(file)), 'Expected generated game source.');
    assert.ok(files.some(file => /test.*\.py$/i.test(file)), 'Expected generated tests.');
    assert.ok(result.toolCalls?.some(call => call.name === 'workspace.run' && call.result?.exitCode === 0 && !call.result.error &&
      /(?:Ran\s+[1-9]\d*\s+tests?|[1-9]\d*\s+passed)/i.test((call.result.stdout ?? '') + (call.result.stderr ?? ''))), 'Expected passing behavior tests, not only a syntax check.');
    await page.getByRole('button', { name: 'Historia', exact: true }).click();
    await page.getByRole('button', { name: /write me a python Tetris game for the console/i }).first().click();
    await page.getByText('Execution waterfall', { exact: false }).first().waitFor();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'demo.sqlite'), { readOnly: true });
    try {
      for (const row of db.prepare("SELECT metadata_json FROM ai_execution_spans WHERE kind='model'").all()) modelIds.add(JSON.parse(row.metadata_json).profileId);
    } finally { db.close(); }
    assert.ok(modelIds.has(planner.id) && modelIds.has(profile.id), 'Both selected profiles must appear in provider spans.');
    console.log('Verified model profiles in Historia:', planner.model, profile.model);
    console.log('Disposable generated workspace:', workspace);
    console.log(JSON.stringify(result.messages.at(-1)));
  }
} finally {
  if (fakeModel) { fakeModel.close(); fakeModel.closeAllConnections(); }
  await browser?.close();
  if (server.exitCode === null) server.kill();
  await stopped;
  if (!process.env.LANGVISION_KEEP_CODING_FIXTURE) await rm(dir, { recursive: true, force: true });
}
