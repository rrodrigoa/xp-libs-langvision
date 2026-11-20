import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { createWindowsTerminal } from './windowsTerminal.js';

export const delay = setTimeout;
export function fixture(root, overrides = {}) {
  const revoke = new AbortController();
  const identity = { workspaceId: 'test', conversationId: 'conversation', userMessageId: 'message' };
  const terminal = createWindowsTerminal({ authorize: () => {
    if (revoke.signal.aborted) throw Error('Revoked');
    return { root, id: 'grant', signal: revoke.signal };
  }, ...overrides });
  const raw = (name, args, approval = {}, who = identity) => terminal.tools.find(tool => tool.name === `terminal.${name}`)
    .execute(args, { identity: who }, { approvedAt: new Date().toISOString(), expectedRevision: 'grant', ...approval });
  const call = async (name, args) => {
    const reply = await raw(name, args);
    assert.equal(reply.ok, true, `${name}: ${JSON.stringify(reply)}`);
    return reply;
  };
  return { terminal, raw, call, identity, revoke, options: { project_root: root, shell: 'pwsh' } };
}

export async function runPromptScenario(call, root, shell = 'pwsh') {
  const { session_id } = await call('open', { project_root: root, shell, load_profile: false, cols: 80, rows: 24 });
  const session = { session_id };
  try {
    assert.equal((await call('resize', { ...session, cols: 100, rows: 30 })).cols, 100);
    const wait = (regex, after_revision, source = 'screen') => call('wait_for', { ...session, source, regex, after_revision, timeout_ms: 8000 });
    const send = (text, submit = true) => call('send_text', { ...session, text, submit });
    const line = async () => {
      const screen = await call('get_screen', session);
      assert.equal(screen.cols, 100);
      assert.equal(screen.rows, 30);
      return screen.lines[screen.cursor.row]?.trimEnd();
    };
    const currentPrompt = async (pattern, after, wrapped = false) => {
      const expires = Date.now() + 8000;
      let cursor = after;
      while (Date.now() < expires) {
        const screen = await call('get_screen', session);
        const displayed = (wrapped ? screen.lines.slice(Math.max(0, screen.cursor.row - 2), screen.cursor.row + 1).join('') : screen.lines[screen.cursor.row] ?? '').trimEnd();
        if (screen.revision > after && pattern.test(displayed)) return displayed;
        cursor = Math.max(cursor, screen.revision);
        await call('wait_for', { ...session, source: 'screen', after_revision: cursor, timeout_ms: Math.max(1, expires - Date.now()) });
      }
      assert.fail(`The active prompt did not match ${pattern}: ${await line()}`);
    };
    const initial = await send('git --version');
    const version = await wait('git version [0-9]', initial.revision_before, 'output');
    if (!version.matched) throw new Error('Git is unavailable in the terminal. Install Git for Windows and restart LangVision.');
    const location = await send('Get-Location');
    const escapedRoot = [...root].map(char => '\\.^$|?*+()[]{}'.includes(char) ? '\\' + char : char).join('');
    assert.ok((await wait('(?im)^' + escapedRoot + '[ ]*$', location.revision_before)).matched);
    const earlier = await call('read_output', session);
    assert.match(earlier.text, /git version/);
    for (const command of [
      'New-Item -ItemType Directory -Force -Path .\\terminal-poc | Out-Null',
      'Set-Location .\\terminal-poc',
      'git init -b main',
      'Set-Content -LiteralPath .\\git-prompt.ps1 -Value \'function prompt { $branch = git symbolic-ref --quiet --short HEAD 2>$null; $path = (Get-Location).Path; if ($LASTEXITCODE -eq 0 -and $branch) { "LV $path [$branch]> " } else { "LV $path> " } }\'',
    ]) {
      await send(command);
    }
    const activated = await send('. .\\git-prompt.ps1');
    const inRepo = '(?m)^LV [^\\r\\n]*terminal-poc \\[main\\]> *$';
    assert.ok((await wait(inRepo, activated.revision_before)).matched, await line());
    const repoPrompt = /^LV .*terminal-poc \[main\]>$/;
    await currentPrompt(repoPrompt, activated.revision_before);
    const typing = await send("Write-Output 'KEY_INPUT_OK'", false);
    await currentPrompt(/Write-Output 'KEY_INPUT_OK'$/, typing.revision_before, true);
    const typed = await call('get_screen', session);
    assert.ok(!typed.lines.some(value => /^KEY_INPUT_OK *$/.test(value)));
    await call('send_keys', { ...session, keys: ['ENTER'] });
    assert.ok((await wait('(?m)^KEY_INPUT_OK *$', typed.revision)).matched);
    const left = await send('Set-Location ..');
    assert.ok((await wait('(?m)^LV [^\\[\\r\\n]*> *$', left.revision_before)).matched);
    assert.doesNotMatch(await currentPrompt(/^LV [^\[]*>$/, left.revision_before), /\[main\]/);
    const returned = await send('Set-Location .\\terminal-poc');
    assert.ok((await wait(inRepo, returned.revision_before)).matched);
    await currentPrompt(repoPrompt, returned.revision_before);
    const output = await call('read_output', { ...session, after_offset: earlier.next_offset });
    assert.equal(output.lost_before_offset, 0);
    assert.ok(output.next_offset > earlier.next_offset);
    return { sessionId: session_id };
  } finally { await call('close', session); }
}
