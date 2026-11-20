import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createWindowsTerminal } from './windowsTerminal.js';
import { runPromptScenario } from './windowsTerminalFixture.js';
import { createCodingWorkspace } from './codingWorkspace.js';
import { AssistantLangGraphRuntime } from './assistantGraph.js';
import { ConsiliumToolHost } from './assistantAgent.js';
import { ASSISTANT_CAPABILITIES } from './assistantCapabilities.js';
import { __setAssistantDbForTests, closeAssistantStore, createConversation, getConversation, saveAiProfile, saveAssistantWorkflow, selectAssistantWorkflow } from './assistantStore.js';
import { starterPrimitiveAgent } from '../shared/primitiveAgentStarter.js';
import { localModelGateway } from './modelGateway.js';
import { fileURLToPath } from 'node:url';

test('the delivered Git prompt renders in the operator-provided repository without editing it', {
  skip: process.platform !== 'win32' || !process.env.LANGVISION_GIT_PROMPT_REPO, timeout: 30_000,
}, async () => {
  const repo = path.resolve(process.env.LANGVISION_GIT_PROMPT_REPO);
  const root = path.dirname(repo);
  const coding = createCodingWorkspace();
  coding.grant(root, false, true);
  const terminal = createWindowsTerminal({ authorize: coding.terminalGrant });
  const context = { identity: { workspaceId: 'test', conversationId: 'prompt', userMessageId: 'prompt' } };
  const call = async (name, args) => {
    const result = await terminal.tools.find(tool => tool.name === 'terminal.' + name).execute(args, context,
      { approvedAt: 'fixture', expectedRevision: coding.terminalGrant().id });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  const repoName = path.basename(repo);
  const script = fileURLToPath(new URL('../../examples/coding-agent/GitPrompt.ps1', import.meta.url)).replaceAll("'", "''");
  try {
    const { session_id } = await call('open', { project_root: root, cwd: repo, shell: 'pwsh' });
    const scope = { session_id };
    const sent = await call('send_text', { ...scope, text: ". '" + script + "'" });
    const expected = '(?m)^\\[' + repoName.replace(/[^a-z0-9_-]/ig, '\\$&') + ', [^\\]]+\\] \\[.*\\]> *$';
    assert.equal((await call('wait_for', { ...scope, source: 'screen', regex: expected, after_revision: sent.revision_before })).matched, true);
    const screen = await call('get_screen', scope);
    assert.match(screen.lines[screen.cursor.row], new RegExp(expected.slice(4)));
    console.log('Observed terminal prompt:', screen.lines[screen.cursor.row]);
    await call('close', scope);
  } finally { await terminal.shutdown(); coding.revoke(); }
});

test('LangGraph dispatches all terminal tools through one approval and returns actual screen evidence', {
  skip: process.platform !== 'win32' || !process.env.LANGVISION_TEST_CONPTY, timeout: 90_000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lv-agent-'));
  const coding = createCodingWorkspace();
  coding.grant(root, false, true);
  const terminal = createWindowsTerminal({ authorize: coding.terminalGrant });
  const checkpoint = new Database(':memory:');
  __setAssistantDbForTests(new Database(':memory:'));
  const previousSize = ASSISTANT_CAPABILITIES.length;
  ASSISTANT_CAPABILITIES.push(...terminal.tools);
  try {
    const definition = starterPrimitiveAgent('Terminal acceptance', { tools: terminal.tools });
    definition.profileId = saveAiProfile({ displayName: 'Terminal protocol fixture', model: 'fixture', baseUrl: 'http://fixture' }).id;
    definition.nodes.find(node => node.id === 'reason').settings.maxModelCalls = 75;
    definition.maxSteps = 180;
    saveAssistantWorkflow('terminal-fixture', definition, 0);
    selectAssistantWorkflow('terminal-test', 'terminal-fixture');
    const { id } = createConversation({ workspaceId: 'terminal-test', surface: 'ai' });
    let wake, pendingResult, completed, fault, serial = 0;
    const names = new Set();
    const queue = [];
    const push = call => { queue.push(call); wake?.(); };
    const script = runPromptScenario((name, args) => new Promise((resolve, reject) => {
      names.add(name);
      push({ name: `terminal.${name}`, arguments: args, resolve, reject });
    }), root).then(result => { completed = result; wake?.(); }, error => { fault = error; wake?.(); });
    const options = { terminal, contextBroker: {}, serviceBaseUrl: 'http://fixture', fetchImpl: async (_url, init) => {
      const input = JSON.parse(init.body);
      if (pendingResult) {
        const tool = input.messages.findLast(message => message.role === 'tool');
        const outcome = JSON.parse(tool.content);
        if (outcome.success) pendingResult.resolve(outcome.result);
        else pendingResult.reject(new Error(outcome.error));
        pendingResult = null;
      }
      while (!queue.length && !completed && !fault) await new Promise(resolve => { wake = resolve; });
      if (fault) throw fault;
      pendingResult = queue.shift();
      const call = pendingResult ?? { name: 'finish_step', arguments: { exit: 'answer', result: { answerMarkdown: 'Verified the PowerShell prompt on the terminal screen.' }, evidenceReferences: [], summary: 'Terminal verified' } };
      return Response.json({ message: { tool_calls: [{ id: `terminal-${++serial}`, function: { name: call.name, arguments: call.arguments } }] } });
    } };
    const runtime = new AssistantLangGraphRuntime({ ...options, toolHost: new ConsiliumToolHost(options), checkpointer: new SqliteSaver(checkpoint) });
    const pending = await runtime.submit({ conversationId: id, content: 'Create, activate, and verify a Git-aware PowerShell prompt in the authorized workspace.', surface: 'ai', context: {} });
    assert.equal(pending.clarification?.presentation?.actions?.[0]?.name, 'terminal.open');
    assert.match(pending.clarification.presentation.actions[0].preview.summary, /not sandboxed/);
    const result = await runtime.clarify(pending.clarification.id, 'approve');
    assert.equal(result.clarification, null);
    assert.ok(result.messages.some(message => message.payload?.finalAnswer), JSON.stringify(getConversation(id).messages.at(-1)));
    await script;
    assert.equal(names.size, 8);
    assert.match(await readFile(path.join(root, 'terminal-poc', 'git-prompt.ps1'), 'utf8'), /function prompt/);
  } finally {
    await terminal.shutdown();
    coding.revoke();
    ASSISTANT_CAPABILITIES.splice(previousSize);
    checkpoint.close();
    closeAssistantStore();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const liveModel = process.env.LANGVISION_TERMINAL_MODEL;
test('live Ollama chooses terminal tools and verifies the rendered Git prompt', {
  skip: process.platform !== 'win32' || !liveModel, timeout: 25 * 60_000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lv-model-'));
  const coding = createCodingWorkspace();
  coding.grant(root, false, true);
  const terminal = createWindowsTerminal({ authorize: coding.terminalGrant });
  const checkpoint = new Database(':memory:');
  __setAssistantDbForTests(new Database(':memory:'));
  const previousSize = ASSISTANT_CAPABILITIES.length;
  ASSISTANT_CAPABILITIES.push(...terminal.tools);
  try {
    const definition = starterPrimitiveAgent('Terminal smoke', { tools: terminal.tools });
    definition.profileId = saveAiProfile({ displayName: 'Terminal smoke model', model: liveModel, baseUrl: 'http://127.0.0.1:11434' }).id;
    const reason = definition.nodes.find(node => node.id === 'reason');
    reason.settings.maxModelCalls = 72;
    reason.settings.systemPrompt += ' This is an explicitly authorized disposable workspace. Your first action is a native terminal.open request using the exact project_root from the user request, shell pwsh, and load_profile false. The host collects the human approval before starting the shell. Do not ask for a separate approval or answer before trying this capability. Use terminal tools only. Immediately after resize, send git --version, wait with terminal.wait_for for a version line, send Get-Location, wait for the directory, and call terminal.read_output, keeping its next_offset. Use the current cursor row from terminal.get_screen to check prompt state and use terminal.send_keys for Enter. Read incremental output before terminal.close, and cite all eight successful tools at completion. Never close if an evidence step is still missing.';
    const answer = definition.edges.find(edge => edge.id === 'answer');
    answer.evidencePolicy = 'required';
    answer.evidenceChecks = terminal.tools.map(tool => ({ toolName: tool.name, checks: [{ path: 'observation.result.ok', operator: 'equals', value: true }] }));
    definition.maxSteps = 175;
    saveAssistantWorkflow('live-terminal', definition, 0);
    selectAssistantWorkflow('terminal-test', 'live-terminal');
    const { id } = createConversation({ workspaceId: 'terminal-test', surface: 'ai' });
    const options = { terminal, contextBroker: {}, serviceBaseUrl: 'http://langvision.local', fetchImpl: localModelGateway };
    const runtime = new AssistantLangGraphRuntime({ ...options, toolHost: new ConsiliumToolHost(options), checkpointer: new SqliteSaver(checkpoint) });
    try {
      const pending = await runtime.submit({ conversationId: id, surface: 'ai', context: {}, content:
        `Within my authorized project folder ${root}, create a terminal-poc Git repository and a git-prompt.ps1 file that makes PowerShell display its working directory and Git branch. Activate it in the session and verify the screen actually shows [main], then verify the branch disappears outside the repo and returns when you re-enter. Do not modify profiles or global Git settings. Use all eight terminal tools: open without profile, resize to 100x30, run git --version and Get-Location, read diagnostic output, enter commands individually, wait and inspect the actual cursor row, type a command without submitting, use Enter, then close. Use git init -b main and account for an unborn branch.` });
      assert.equal(pending.clarification?.presentation?.actions?.[0]?.name, 'terminal.open', JSON.stringify(pending.messages.at(-1)));
      const actions = pending.clarification.presentation.actions;
      assert.equal(actions.length, 1, 'Only the session opening may be approved by the fixture.');
      const result = await runtime.clarify(pending.clarification.id, 'approve');
      assert.equal(result.clarification, null);
      assert.ok(result.messages.some(message => message.payload?.finalAnswer), JSON.stringify(result.messages.at(-1)));
      const evidence = result.messages.flatMap(message => {
        try { return [{ name: message.payload.toolName, value: JSON.parse(message.payload.modelContent) }]; } catch { return []; }
      }).filter(item => item.value.ok);
      assert.deepEqual(new Set(evidence.map(item => item.name)), new Set(terminal.tools.map(tool => tool.name)), JSON.stringify(result.messages.at(-1)?.content));
      assert.match(await readFile(path.join(root, 'terminal-poc', 'git-prompt.ps1'), 'utf8'), /function\s+prompt/i);
      const prompts = evidence.filter(item => item.name === 'terminal.get_screen').map(({ value }) => (value.lines[value.cursor.row] ?? '').trim());
      const inside = prompts.findIndex(line => /terminal-poc \[main\]>$/i.test(line));
      const outside = prompts.findIndex((line, n) => n > inside && line.includes(root) && !line.includes('[main]') && !line.includes('terminal-poc'));
      assert.ok(inside >= 0 && outside > inside && prompts.slice(outside + 1).some(line => /terminal-poc \[main\]>$/i.test(line)), JSON.stringify(prompts));
    } finally { runtime.cancel(id); }
  } finally {
    await terminal.shutdown();
    coding.revoke();
    ASSISTANT_CAPABILITIES.splice(previousSize);
    checkpoint.close();
    closeAssistantStore();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
