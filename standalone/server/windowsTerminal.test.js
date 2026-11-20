import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { delay, fixture, runPromptScenario } from './windowsTerminalFixture.js';
import { createWindowsTerminal, encodeKeys, outputLog, outputSanitizer, resolveTerminalFolder, windowsTerminalDrivers } from './windowsTerminal.js';

test('terminal path policy rejects traversal, junctions, device paths and siblings', () => {
  const fs = { lstatSync: name => ({ isDirectory: () => true, isSymbolicLink: () => name.endsWith('link') }), realpathSync: { native: name => name } };
  const root = 'C:\\test\\project';
  assert.equal(resolveTerminalFolder(root, 'c:/TEST/project/src/', fs), root + '\\src');
  for (const unsafe of ['C:\\test\\project2', 'D:\\elsewhere', root + '\\link']) assert.throws(() => resolveTerminalFolder(root, unsafe, fs), { code: 'PERMISSION_DENIED' });
  for (const invalid of ['\\\\?\\C:\\test', root + '\\..\\project', root + '\\file:stream', root + '\\name.']) assert.throws(() => resolveTerminalFolder(root, invalid, fs), { code: 'INVALID_ARGUMENT' });
});

test('key encoding and incremental sanitized UTF-8 offsets', () => {
  assert.equal(encodeKeys(['ENTER', 'CTRL_C', 'ESC', 'UP', 'DOWN', 'RIGHT', 'LEFT', 'BACKSPACE']), '\r\x03\x1b\x1b[A\x1b[B\x1b[C\x1b[D\x7f');
  for (const invalid of [null, [], ['constructor'], Array(33).fill('ENTER')]) assert.throws(() => encodeKeys(invalid), { code: 'INVALID_ARGUMENT' });
  const scrub = outputSanitizer();
  assert.equal(scrub('text\x1b]clipboard='), '');
  assert.equal(scrub('secret\x1b\\\x1b[31m password=half'), '[redacted credential]');
  assert.equal(scrub('remaining\r\nnext\x1b[0m\r\n'), '\r\nnext\r\n');
  const log = outputLog(8);
  log.append('abcd');
  log.append('😀abc');
  assert.deepEqual(log.read(0, 4), { text: 'd', next_offset: 4, truncated: true, lost_before_offset: 3 });
  assert.equal(log.read(4, 4).text, '😀');
  assert.equal(log.read(8, 4).next_offset, 11);
  assert.equal(log.tail(4), 'abc');
  assert.throws(() => log.read(5, 8), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => log.read(12, 8), { code: 'INVALID_ARGUMENT' });
});

test('queued parsed output, active alternate buffer, wait, ownership, limits and cleanup', async () => {
  const emitter = new EventEmitter(), writes = [], lifecycle = [];
  const xterm = await import('@xterm/headless');
  const Terminal = xterm.Terminal ?? xterm.default.Terminal;
  const attach = name => callback => { emitter.on(name, callback); return { dispose: () => emitter.off(name, callback) }; };
  const driver = { Terminal, locateShell: () => ({ name: 'pwsh', executable: 'fake' }), spawn: () => ({
    onData: attach('data'), onExit: attach('exit'), write: value => writes.push(value), resize: () => {}, kill: () => {},
  }) };
  const { terminal, call, raw, identity, revoke, options } = fixture('C:\\fixture', {
    drivers: async () => driver, resolveFolder: (_root, requested) => requested, idleMs: 300, onLifecycle: (_identity, event) => lifecycle.push(event),
  });
  try {
    assert.equal((await raw('open', options, { approvedAt: null })).error.code, 'PERMISSION_DENIED');
    assert.equal((await raw('open', { ...options, load_profile: true })).error.code, 'INVALID_ARGUMENT');
    const { session_id } = await call('open', options);
    const other = { ...identity, userMessageId: 'another-execution' };
    const args = { session_id };
    assert.equal((await raw('get_screen', args, {}, other)).error.code, 'SESSION_NOT_FOUND');
    assert.equal((await raw('send_text', { ...args, text: 'first\nsecond' })).error.code, 'INVALID_ARGUMENT');
    assert.equal((await raw('send_text', { ...args, text: 'x'.repeat(8193) })).error.code, 'INVALID_ARGUMENT');
    assert.equal((await raw('wait_for', { ...args, source: 'screen', regex: '(' })).error.code, 'INVALID_ARGUMENT');
    emitter.emit('data', '\x1b[31mleft\x1b[0m\r\x1b[2Kprompt> ');
    const first = await call('get_screen', args);
    assert.equal(first.lines[0], 'prompt> ');
    assert.equal(first.cursor.col, 8);
    const wait = call('wait_for', { ...args, source: 'screen', after_revision: first.revision, regex: 'alternate' });
    emitter.emit('data', '\x1b[?1049halternate');
    assert.equal((await wait).matched, true);
    assert.equal((await call('get_screen', args)).alternate_buffer, true);
    emitter.emit('data', '\x1b[?1049l');
    await call('send_text', { ...args, text: 'type', submit: false });
    await call('send_keys', { ...args, keys: ['ENTER'] });
    assert.deepEqual(writes, ['type', '\r']);
    assert.equal((await call('resize', { ...args, cols: 80, rows: 24 })).rows, 24);
    assert.equal((await call('get_screen', { ...args, max_lines: 1 })).truncated, true);
    assert.equal((await call('wait_for', { ...args, source: 'output', regex: 'never', timeout_ms: 5 })).timed_out, true);
    const closedWait = call('wait_for', { ...args, source: 'screen' });
    emitter.emit('exit', { exitCode: 5 });
    assert.equal((await closedWait).exit_code, 5);
    assert.equal((await call('close', args)).exit_code, 5);
    assert.equal((await raw('send_text', { ...args, text: 'late' })).error.code, 'SESSION_CLOSED');
    const flooded = await call('open', options);
    emitter.emit('data', 'x'.repeat(1024 * 1024 + 1));
    assert.equal((await call('close', flooded)).state, 'closed');
    const open = await call('open', options);
    await delay(350);
    assert.equal((await raw('get_screen', open)).error.code, 'SESSION_CLOSED');
    await call('open', options);
    revoke.abort();
    assert.equal((await raw('open', options)).error.code, 'PERMISSION_DENIED');
    assert.ok(lifecycle.some(event => event.reason === 'output-flood'));
    assert.ok(lifecycle.some(event => event.reason === 'idle-timeout'));
  } finally { await terminal.shutdown(); }
});

test('missing Git produces a concrete diagnostic before repository creation', async () => {
  await assert.rejects(runPromptScenario(async (name, args) => {
    if (name === 'open') return { session_id: 'fake' };
    if (name === 'resize') return { cols: 100 };
    if (name === 'send_text') assert.equal(args.text, 'git --version');
    return { matched: false, revision_before: 0 };
  }, 'C:\\fake'), /Git is unavailable/);
});

for (const shell of ['powershell', 'pwsh']) test(`real ConPTY Git prompt in ${shell}`, {
  skip: process.platform !== 'win32' || !process.env.LANGVISION_TEST_CONPTY, timeout: 90_000,
}, async t => {
  const driver = await windowsTerminalDrivers();
  if (driver.locateShell(shell, process.env).name !== shell) { t.skip('PowerShell 7 not in a supported installation directory'); return; }
  const dir = await mkdtemp(path.join(tmpdir(), 'langvision-terminal-'));
  const before = spawnSync('git', ['config', '--global', '--list'], { encoding: 'utf8' }).stdout;
  await mkdir(path.join(dir, 'other'));
  const { terminal, call, raw } = fixture(dir);
  try {
    const second = await call('open', { project_root: dir, cwd: path.join(dir, 'other'), shell });
    const result = await runPromptScenario(call, dir, shell);
    assert.match(await readFile(path.join(dir, 'terminal-poc', 'git-prompt.ps1'), 'utf8'), /function prompt/);
    const isolated = await call('get_screen', second);
    assert.ok(isolated.lines.every(line => !line.includes('[main]')));
    await call('send_text', { session_id: second.session_id, text: "Write-Output ('SLEEP_' + 'START'); Start-Sleep -Seconds 20" });
    assert.equal((await call('wait_for', { session_id: second.session_id, source: 'screen', regex: '(?m)^SLEEP_START *$' })).matched, true);
    const beforeInterrupt = await call('get_screen', second);
    await call('send_keys', { session_id: second.session_id, keys: ['CTRL_C'] });
    const timeout = Date.now() + 5000;
    let current = beforeInterrupt;
    while (Date.now() < timeout) {
      const waited = await call('wait_for', { session_id: second.session_id, source: 'screen', after_revision: current.revision, timeout_ms: Math.max(1, timeout - Date.now()) });
      if (!waited.matched) break;
      current = await call('get_screen', second);
      if (/^PS .*other>\s*$/.test(current.lines[current.cursor.row] ?? '')) break;
    }
    assert.match(current.lines[current.cursor.row] ?? '', /^PS .*other>\s*$/);
    await call('send_text', { session_id: second.session_id, text: "Write-Output ('CTRL_' + 'OK')" });
    assert.equal((await call('wait_for', { session_id: second.session_id, source: 'screen', after_revision: current.revision, regex: '(?m)^CTRL_OK *$' })).matched, true);
    assert.equal((await raw('send_text', { session_id: result.sessionId, text: 'late' })).error.code, 'SESSION_CLOSED');
    assert.equal((await call('close', { session_id: second.session_id })).state, 'closed');
    assert.equal(spawnSync('git', ['config', '--global', '--list'], { encoding: 'utf8' }).stdout, before);
  } finally { await terminal.shutdown(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
