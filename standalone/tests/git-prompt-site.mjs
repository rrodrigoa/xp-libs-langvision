import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { windowsTerminalDrivers } from '../server/windowsTerminal.js';

assert.equal(process.platform, 'win32', 'This scenario requires Windows ConPTY.');
const root = await mkdtemp(path.join(tmpdir(), 'lv-site-'));
const workspace = path.join(root, 'Coder');
const upstream = path.join(root, 'upstream');
const repo = path.join(workspace, 'xp-evolution');
const scriptName = 'GitPrompt.ps1';
const script = await readFile(new URL('../../examples/coding-agent/GitPrompt.ps1', import.meta.url));
const port = Number(process.env.LANGVISION_CODING_SMOKE_PORT ?? 18786);
assert.ok(port >= 18000 && port <= 18999);
const baseURL = 'http://127.0.0.1:' + port;
let server, model, browser, modelError, page;
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { windowsHide: true, stdio: 'pipe', encoding: 'utf8' }).trim();
const liveModel = process.env.LANGVISION_GIT_PROMPT_MODEL;
const planningModel = process.env.LANGVISION_GIT_PROMPT_PLANNER || liveModel;
const expected = '[xp-evolution, main] [\u21910, \u21930, =0]>';
const runPrompt = `Write a PowerShell initialization script that shows [repo name, branch name] [ahead, behind, dirty] in a Git folder. Show ↑ and ↓ with numeric counts even when zero, =0 when clean or dirty:N for changed paths. Use exactly two bracket pairs with commas between fields, for example ${expected} for the clean test clone. Save GitPrompt.ps1 outside the clone in ${workspace}. Verify the saved script in a PowerShell session in ${repo}: dot-source it, read the actual displayed prompt, and close the session. Print the observed example with install and use instructions. Do not modify the clone, Git settings or PowerShell profiles.`;
let ordinal = 0, verifyStep = 0;
let listingEvidence;
const clarifyFixture = process.env.LANGVISION_TEST_CLARIFICATION === '1';
const task = { id: 'prompt', title: 'Write and verify Git prompt', status: 'active' };
const change = { id: 'script', title: 'Add GitPrompt.ps1', status: 'active' };
const response = (name, args) => ({ message: { role: 'assistant', content: '', tool_calls: [{ id: 'site-' + ++ordinal, function: { name, arguments: args } }] } });
const finish = (exit, result = {}, evidenceReferences = []) => response('finish_step', { exit, result, evidenceReferences, summary: exit });

function respond(body) {
  assert.equal(body.messages.filter(msg => msg.role === 'system').length, 1);
  const { exits, input, context } = JSON.parse(body.messages[1].content);
  const has = id => exits.some(exit => exit.id === id);
  const observations = body.messages.filter(msg => msg.role === 'tool').map(msg => JSON.parse(msg.content));
  const last = name => observations.findLast(item => item.name === name && item.success);
  if (has('begin_work')) return last('agent.report_progress') ? finish('begin_work') : response('agent.report_progress', { summary: 'Plan Git prompt', tasks: [task] });
  if (has('inspect_workspace') || has('approach_ready')) {
    if (!input.saved.codingInspection) return finish('inspect_workspace');
    if (clarifyFixture && !context?.planningReply) return finish('ask_user', { question: 'Which verification target should I use?', reason: 'PowerShell versions differ.', options: ['PowerShell 7', 'Windows PowerShell'], recommendation: 'PowerShell 7' }, [listingEvidence]);
    if (!last('agent.report_status')) return response('agent.report_status', { message: 'The workspace is ready; I will verify the script using the rendered prompt.' });
    return finish('approach_ready', { plan: 'Write the script, test with PowerShell, and verify the rendered prompt.' }, [listingEvidence]);
  }
  if (has('workspace_unavailable')) {
    const listing = last('workspace.list');
    if (listing) listingEvidence = listing.requestId;
    return listing ? finish('implement', { targetPlatform: listing.result.targetPlatform, files: listing.result.files }, [listing.requestId]) : response('workspace.list', {});
  }
  if (has('begin_changes')) {
    const reported = last('agent.report_changes');
    return reported ? finish('begin_changes', input, [reported.requestId]) : response('agent.report_changes', { changes: [change] });
  }
  if (has('ready_to_verify')) {
    const edit = last('workspace.edit');
    if (!edit) {
      if (!last('skills.search')) {
        assert.doesNotMatch(body.messages[0].content, /Make small reversible edits and preview their exact contents/);
        return response('skills.search', { query: 'safe project edits' });
      }
      if (!last('skills.read')) {
        const available = last('skills.search').result;
        assert.ok(available.some(skill => skill.id === 'safe-project-edits' && !skill.body));
        return response('skills.read', { id: 'safe-project-edits' });
      }
      assert.match(last('skills.read').result.body, /Make small reversible edits/);
      const attempted = observations.find(item => item.name === 'terminal.open');
      if (!attempted) return response('terminal.open', { project_root: workspace, shell: 'pwsh' });
      assert.equal(attempted.failure?.code, 'FILE_EDIT_REQUIRED');
      const rejected = observations.find(item => item.name === 'workspace.edit' && !item.success);
      if (!rejected) return response('workspace.edit', { operation: 'write', path: scriptName, contents: 'git log --oneline @{u}..HEAD' });
      assert.equal(rejected.failure?.code, 'POWERSHELL_SYNTAX');
      return response('workspace.edit', { operation: 'write', path: scriptName, contents: script.toString('utf8') });
    }
    assert.equal(edit.appliedCodeChanges[0].evidenceReference, edit.requestId);
    assert.equal(edit.appliedCodeChanges[0].status, 'completed');
    return finish('ready_to_verify', { paths: [scriptName] }, [edit.requestId]);
  }
  assert.ok(exits.find(exit => exit.id === 'answer')?.evidenceAlternatives?.some(path => path.label === 'Windows terminal verification'), JSON.stringify(exits));
  const session = last('terminal.open')?.result.session_id;
  const scope = { session_id: session };
  switch (verifyStep++) {
    case 0: return response('workspace.list', {});
    case 1: return response('terminal.open', { project_root: last('workspace.list').result.terminalProjectRoot, cwd: workspace, shell: 'pwsh', load_profile: false });
    case 2: return response('terminal.send_text', { ...scope, text: ". .\\GitPrompt.ps1; Set-Location .\\xp-evolution" });
    case 3: return response('terminal.wait_for', { ...scope, source: 'screen', regex: '(?m)^\\[xp-evolution, main\\] \\[.*=0\\]> *$', after_revision: last('terminal.send_text').result.revision_before });
    case 4:
      assert.equal(last('terminal.wait_for').result.matched, true);
      return response('terminal.close', scope);
    case 5: {
      assert.ok(body.messages.some(msg => msg.content?.includes('Before closing this verification terminal')));
      return response('terminal.get_screen', scope);
    }
    case 6: {
      const screen = last('terminal.get_screen').result;
      assert.equal(screen.lines[screen.cursor.row].trimEnd(), expected);
      return response('terminal.close', scope);
    }
    case 7: return response('agent.report_progress', { summary: 'Verified the rendered Git prompt', tasks: [{ ...task, status: 'completed', evidenceReferences: [last('terminal.get_screen').requestId] }] });
    case 8: return finish('answer', { answerMarkdown: `Observed ${expected}\n\nInstall: dot-source GitPrompt.ps1 to use it in this PowerShell session.` }, [last('terminal.wait_for').requestId, last('terminal.get_screen').requestId, last('terminal.close').requestId]);
    default: throw Error('Unexpected extra implementation call: ' + JSON.stringify(body.messages.slice(-3)).slice(-1800));
  }
}

try {
  await mkdir(workspace);
  await mkdir(upstream);
  git(upstream, 'init', '-b', 'main');
  await writeFile(path.join(upstream, 'README.md'), 'Fixture\n');
  git(upstream, 'add', 'README.md');
  git(upstream, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Seed');
  git(workspace, 'clone', '-b', 'main', upstream, repo);
  if (!liveModel) {
    model = createServer(async (req, res) => {
      try {
        if (req.url !== '/api/chat') { res.writeHead(404).end(); return; }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(respond(JSON.parse(Buffer.concat(chunks)))));
      } catch (error) { modelError ??= error; res.writeHead(500).end('{}'); }
    }).listen(0, '127.0.0.1');
    await once(model, 'listening');
  }
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('../', import.meta.url), stdio: 'inherit',
    env: { ...process.env, PORT: String(port), LANGVISION_BIND: '127.0.0.1', LANGVISION_PUBLIC_ORIGIN: '', LANGVISION_OPERATOR_PASSWORD: '',
      LANGVISION_DB: path.join(root, 'site.sqlite'), LANGVISION_LOCAL_OLLAMA_CONTEXT: '8192',
      LANGVISION_OLLAMA_URL: model ? 'http://127.0.0.1:' + model.address().port : process.env.LANGVISION_TEST_OLLAMA_URL ?? 'http://127.0.0.1:11434',
      LANGVISION_PLANNER_MODEL: planningModel || 'site-planner', LANGVISION_CODER_MODEL: liveModel || 'site-coder',
      LANGVISION_PLANNER_THINKING: planningModel?.includes('gpt-oss') ? 'medium' : 'off' },
  });
  for (let i = 0; ; i++) {
    if (server.exitCode !== null || i >= 80) throw Error('Site did not start');
    if (await fetch(baseURL + '/api/ready').then(res => res.ok, () => false)) break;
    await delay(250);
  }
  browser = await chromium.launch({ channel: 'msedge' });
  page = await browser.newPage({ baseURL, viewport: { width: 1600, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  let activeReads = 0, parallelReads = 0;
  if (clarifyFixture) await page.route(/\/api\/assistant\/conversations\/conversation-[^/?]+(?:\?[^#]*)?$/, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    parallelReads = Math.max(parallelReads, ++activeReads);
    try {
      const snapshot = await route.fetch();
      await delay(350);
      await route.fulfill({ response: snapshot });
    } catch { await route.abort().catch(() => {}); }
    finally { activeReads--; }
  });
  const limit = liveModel ? 15 * 60_000 : 30_000;
  await page.goto('/');
  const reason = page.getByTestId('ai-agent-node-reason');
  await reason.getByRole('button', { name: 'Edit Implement source' }).click();
  const editor = page.locator('.lv-node-dialog');
  await editor.getByLabel('Skill scope').selectOption('selected');
  await editor.getByText(/Safe project edits · v/).click();
  await editor.getByLabel('Allow Safe project edits').check();
  assert.equal(await editor.getByLabel('SQL authoring and task-focus instructions').count(), 0);
  if (!liveModel) {
    await editor.getByRole('button', { name: 'Create skill', exact: true }).click();
    const added = editor.locator('details').filter({ has: page.getByText('New skill · v1', { exact: true }) });
    await added.getByText('New skill · v1').click();
    await added.getByLabel('Discovery description').fill('Only for the portal test.');
    await added.getByLabel('Instructions', { exact: true }).fill('Do not change user files during this fixture.');
    await added.getByLabel('Name', { exact: true }).fill('Disposable test skill');
    await editor.getByText('Disposable test skill · v1', { exact: true }).locator('..').getByRole('button', { name: 'Delete skill', exact: true }).click();
  }
  await editor.getByTestId('ai-primitive-cancel').click();
  await page.getByRole('button', { name: 'Coding Workspace', exact: true }).click();
  await page.getByLabel('Local folder').fill(workspace);
  await page.getByLabel('Allow the agent to request file edits').check();
  await page.getByLabel('Allow agent-controlled PowerShell').check();
  await page.getByRole('button', { name: 'Grant access' }).click();
  await page.getByText('Agent-controlled PowerShell is enabled for this grant.').waitFor();
  await page.getByTestId('assistant-message-input').fill(runPrompt);
  console.log(`Submitting portal request on ${port} (planning ${planningModel || 'fixture'}, coding ${liveModel || 'fixture'}).`);
  await page.getByRole('button', { name: 'Send to assistant' }).click();
  const approval = page.getByTestId('assistant-approval-explanation');
  const getConversation = async () => {
    const { conversations } = await (await page.request.get('/api/assistant/conversations')).json();
    return (await page.request.get('/api/assistant/conversations/' + conversations[0].id)).json();
  };
  const approvedIds = new Set();
  async function approveVisible(expectedTool) {
    const pending = (await getConversation()).clarification;
    if (!pending || approvedIds.has(pending.id)) return false;
    const notice = page.locator(`[data-clarification-id="${pending.id}"]`);
    if (!await notice.isVisible()) return false;
    assert.equal(pending.presentation?.kind, 'approval', 'A fully specified request should not need clarification.');
    const actions = pending.presentation.actions;
    assert.equal(actions.length, 1, 'Only approve a single scoped fixture action.');
    const action = actions[0];
    if (expectedTool) assert.equal(action.name, expectedTool);
    if (action.name === 'workspace.edit') {
      assert.equal(action.preview.summary.toLowerCase(), 'write gitprompt.ps1');
      assert.equal(action.preview.destination, null);
    } else {
      assert.equal(action.name, 'terminal.open');
      assert.equal(path.resolve(action.preview.project_root), workspace);
      assert.ok(!action.preview.cwd || [workspace, repo].includes(path.resolve(action.preview.cwd)));
      assert.notEqual(action.preview.load_profile, true);
      assert.match(await approval.innerText(), /not sandboxed/);
    }
    const approve = notice.getByRole('button', { name: 'Approve actions', exact: true });
    if (!await approve.isEnabled()) return false;
    await approve.click();
    approvedIds.add(pending.id);
    console.log(`Approved ${action.name} in the portal.`);
    return true;
  }
  if (clarifyFixture && !liveModel) {
    await page.getByText('Which verification target should I use?', { exact: true }).waitFor();
    await page.reload();
    await page.getByText('PowerShell versions differ.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'PowerShell 7', exact: true }).click();
    await page.getByText('The workspace is ready; I will verify the script using the rendered prompt.', { exact: true }).waitFor();
  }
  const waitApproval = async name => {
    const deadline = Date.now() + limit;
    while (Date.now() < deadline) {
      if (await approveVisible(name)) return;
      const current = await getConversation();
      if (['failed', 'needs-attention', 'interrupted'].includes(current.state)) throw new Error('Agent stopped before requesting ' + name);
      await delay(700);
    }
    throw new Error('No visible approval for ' + name);
  };
  try { await waitApproval('workspace.edit'); }
  catch (error) { throw modelError ?? new Error('Missing file approval: ' + (await page.locator('.assistant-panel').innerText()).slice(-2500), { cause: error }); }
  try { await waitApproval('terminal.open'); }
  catch (error) { throw modelError ?? new Error('Missing terminal approval: ' + (await page.locator('.assistant-panel').innerText()).slice(-3000), { cause: error }); }
  const answerDeadline = Date.now() + limit;
  while (!await page.getByTestId('assistant-final-answer').isVisible()) {
    await approveVisible();
    const { conversations } = await (await page.request.get('/api/assistant/conversations')).json();
    if (conversations[0]?.state === 'failed' || Date.now() > answerDeadline) throw new Error('No final answer: ' + (await page.locator('.assistant-panel').innerText()).slice(-3500));
    await delay(700);
  }
  if (modelError) throw modelError;
  const final = page.getByTestId('assistant-final-answer');
  assert.equal(await final.count(), 1);
  const chat = await final.innerText();
  assert.ok(chat.includes(expected), 'The final answer must report the actually observed prompt: ' + chat.slice(-2400));
  assert.match(chat, /dot.source|install|usage|use.*profile/i);
  const saved = await readFile(path.join(workspace, scriptName), 'utf8');
  assert.match(saved, /function\s+(?:global:)?prompt/i);
  assert.equal(git(repo, 'status', '--porcelain=v1'), '');
  assert.equal(git(repo, 'branch', '--show-current'), 'main');
  const dirt = path.join(repo, 'lv-dirty-probe.txt');
  const dirtyProbe = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); . '${path.join(workspace, scriptName).replaceAll("'", "''")}'; prompt`;
  await writeFile(dirt, 'Temporary untracked file for the generated script test.', { flag: 'wx' });
  try {
    const detail = await getConversation();
    const shell = detail.messages.filter(msg => msg.payload?.toolName === 'terminal.open').map(msg => JSON.parse(msg.payload.modelContent).shell).at(-1);
    const { executable } = (await windowsTerminalDrivers()).locateShell(shell === 'powershell' ? 'powershell' : 'pwsh', process.env);
    const rendered = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(dirtyProbe, 'utf16le').toString('base64')], { cwd: repo, encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.match(rendered, /\[xp-evolution, main\] \[\u21910, \u21930, dirty:1\]>/i);
  } finally { await unlink(dirt); }
  assert.equal(git(repo, 'status', '--porcelain=v1'), '');
  if (clarifyFixture) await page.getByRole('button', { name: 'Inspect update', exact: true }).click();
  else {
    await page.getByRole('button', { name: 'Historia', exact: true }).click();
    await page.getByRole('button', { name: /Write a PowerShell initialization script/ }).first().click();
  }
  const runId = await page.getByRole('textbox', { name: 'Run ID' }).inputValue();
  const trace = page.getByTestId('ai-execution-trace');
  await trace.waitFor();
  const lifecycle = trace.getByText('Terminal lifecycle', { exact: true });
  const closed = trace.getByText(/closed \/ requested/);
  for (let i = 0; i < 8 && !await closed.isVisible(); i++) {
    if (await lifecycle.isVisible() && !await lifecycle.evaluate(summary => summary.parentElement.open)) await lifecycle.click();
    if (await closed.isVisible()) break;
    const more = trace.getByTestId('ai-trace-next');
    if (!await more.isVisible()) break;
    const previous = await trace.getByTestId('ai-execution-attempts').locator('li').count();
    await more.click();
    await page.waitForFunction(count => document.querySelectorAll('[data-testid="ai-execution-attempts"] li').length > count, previous);
  }
  await closed.waitFor();
  const conversations = await (await page.request.get('/api/assistant/conversations')).json();
  const detail = await (await page.request.get('/api/assistant/conversations/' + conversations.conversations[0].id)).json();
  const evidence = detail.messages.filter(msg => msg.payload?.toolName === 'terminal.get_screen').map(msg => JSON.parse(msg.payload.modelContent));
  assert.ok(evidence.some(screen => screen.lines?.[screen.cursor?.row]?.trimEnd() === expected));
  assert.ok(detail.messages.some(msg => msg.payload?.finalAnswer));
  if (clarifyFixture) {
    assert.equal(parallelReads, 1, 'SSE events must not run overlapping conversation refreshes.');
    assert.equal(detail.messages.filter(msg => msg.payload?.messageKind === 'node-status').length, 1);
    assert.equal(detail.messages.find(msg => msg.payload?.messageKind === 'node-status')?.payload.nodeId, 'approach');
  }
  assert.deepEqual(pageErrors, []);
  console.log(`Site run ${runId}: saved file, approved terminal, rendered prompt, clean clone, and Historia verified (${liveModel || 'deterministic model fixture'}).`);
} catch (error) {
  if (page) {
    try {
      const { conversations } = await (await page.request.get('/api/assistant/conversations', { timeout: 3000 })).json();
      const detail = await (await page.request.get('/api/assistant/conversations/' + conversations[0].id, { timeout: 3000 })).json();
      console.error('Portal run', detail.messages.find(msg => msg.role === 'user')?.id, detail.state,
        detail.clarification?.prompt ?? '', detail.toolCalls.slice(-5).map(call => [call.name, call.status]));
    } catch { /* Keep the original failure if the test server is gone. */ }
  }
  throw error;
} finally {
  await browser?.close();
  model?.closeAllConnections();
  model?.close();
  if (server && server.exitCode === null) { const stopped = once(server, 'exit'); server.kill(); await stopped; }
  if (process.env.LANGVISION_KEEP_SITE_EVIDENCE === '1') console.log('Disposable workspace and Historia SQLite:', root);
  else await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
