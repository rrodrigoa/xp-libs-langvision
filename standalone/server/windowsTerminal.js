import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { RE2JS } from 're2js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const keys = { ENTER: '\r', CTRL_C: '\x03', ESC: '\x1b', UP: '\x1b[A', DOWN: '\x1b[B', RIGHT: '\x1b[C', LEFT: '\x1b[D', BACKSPACE: '\x7f' };
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const id = { type: 'string', minLength: 1, maxLength: 100 };
const credentialPattern = /(?:\b(?:password|passwd|api[_-]?key|token|secret)\s*[=:]|\bbearer\s+).*$/i;
const number = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const dims = { cols: number(20, 240), rows: number(5, 100) };
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const validDimensions = (cols, rows) => {
  if (!integer(cols, 20, 240) || !integer(rows, 5, 100)) throw fail('INVALID_ARGUMENT', 'Use 20–240 columns and 5–100 rows.');
};

export function encodeKeys(sequence) {
  if (!Array.isArray(sequence) || !sequence.length || sequence.length > 32 || sequence.some(key => !Object.hasOwn(keys, key))) {
    throw fail('INVALID_ARGUMENT', 'Supply 1–32 supported terminal keys.');
  }
  return sequence.map(key => keys[key]).join('');
}

// Stream control stripping for diagnostics; xterm receives the original data.
export function outputSanitizer() {
  let state = 'text', control = '', secret = false, pending = [];
  return data => {
    let result = '';
    for (const char of data) {
      if (state === 'string') {
        if (char === '\x07' || char === '\u009c' || (control === '\x1b' && char === '\\')) state = 'text';
        control = char;
      } else if (state === 'csi') {
        if (/[@-~]/.test(char)) state = 'text';
      } else if (state === 'escape') {
        state = char === '[' ? 'csi' : /^[\]PX^_]$/.test(char) ? 'string' : 'text';
        control = '';
      } else if (char === '\x1b') state = 'escape';
      else if (char === '\u009b') state = 'csi';
      else if (/^[\u0090\u0098\u009d-\u009f]$/.test(char)) { state = 'string'; control = ''; }
      else if (char === '\r' || char === '\n' || char === '\t' || !/[\x00-\x1f\x7f-\x9f]/.test(char)) {
        if (secret) {
          if (/[\r\n]/.test(char)) { secret = false; result += char; }
          continue;
        }
        pending.push(char);
        if (/(?:password|passwd|api[_-]?key|token|secret)\s*[=:]\s*$|\bbearer\s+$/i.test(pending.join(''))) {
          result += '[redacted credential]'; pending = []; secret = true;
        } else if (/[\r\n]/.test(char)) { result += pending.join(''); pending = []; }
        else if (pending.length > 48) result += pending.shift();
      }
    }
    return result;
  };
}

export function outputLog(capacity = 256 * 1024) {
  let retained = Buffer.alloc(0), offset = 0;
  const continuation = byte => (byte & 0xc0) === 0x80;
  return {
    append(text) {
      const next = Buffer.concat([retained, Buffer.from(text)]);
      let drop = Math.max(0, next.length - capacity);
      while (drop < next.length && continuation(next[drop])) drop++;
      offset += drop;
      retained = Buffer.from(next.subarray(drop));
    },
    get end() { return offset + retained.length; },
    tail(max) {
      let start = Math.max(0, retained.length - max);
      while (start < retained.length && continuation(retained[start])) start++;
      return retained.toString('utf8', start);
    },
    read(after, max) {
      const endOffset = offset + retained.length;
      if (!integer(after, 0, endOffset) || !integer(max, 4, 16384)) throw fail('INVALID_ARGUMENT', 'Use a returned output offset and a byte limit from 4 to 16384.');
      const start = Math.max(0, after - offset);
      if (start < retained.length && continuation(retained[start])) throw fail('INVALID_ARGUMENT', 'Output offset splits a UTF-8 character.');
      let end = Math.min(start + max, retained.length);
      while (end < retained.length && continuation(retained[end])) end--;
      return { text: retained.toString('utf8', start, end), next_offset: offset + end, truncated: after < offset || end < retained.length, lost_before_offset: offset };
    },
  };
}

export function snapshot(term, revision, includeScrollback, maxLines) {
  const buffer = term.buffer.active;
  const bottom = Math.min(buffer.length, buffer.viewportY + term.rows);
  const first = includeScrollback ? 0 : buffer.viewportY;
  const start = Math.max(first, bottom - maxLines);
  const lines = Array.from({ length: bottom - start }, (_, n) => {
    const line = buffer.getLine(start + n)?.translateToString(true) ?? '';
    return line.replace(credentialPattern, '[redacted credential]');
  });
  return { revision, lines, cursor: { row: buffer.baseY + buffer.cursorY - buffer.viewportY, col: buffer.cursorX },
    cols: term.cols, rows: term.rows, alternate_buffer: buffer.type === 'alternate', truncated: start > first };
}

export function resolveTerminalFolder(root, candidate = root, files = fs) {
  const drivePath = /^[a-z]:[\\/]/i;
  if (typeof candidate !== 'string' || !drivePath.test(candidate) ||
      candidate.slice(3).split(/[\\/]/).some(segment => /^(?:\.|\.\.)$|[. ]$|[:<>|"*?\x00-\x1f]/.test(segment))) {
    throw fail('INVALID_ARGUMENT', 'Use an absolute local Windows folder path without traversal.');
  }
  const win = path.win32;
  const normalized = win.normalize(candidate).replace(/\\$/, '');
  const relative = win.relative(root, normalized);
  if (relative === '..' || relative.startsWith('..\\') || win.isAbsolute(relative)) throw fail('PERMISSION_DENIED', 'Folder is outside the terminal grant.');
  try {
    let current = root;
    for (const part of relative.split('\\').filter(Boolean)) {
      current = win.join(current, part);
      const stat = files.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error();
    }
    if (files.realpathSync.native(current).toLowerCase() !== current.toLowerCase()) throw Error();
    return current;
  } catch { throw fail('PERMISSION_DENIED', 'Folder is missing, unsafe, or resolves through a junction or symlink.'); }
}

function approvedEnvironment() {
  const allowed = /^(?:systemroot|windir|comspec|path|pathext|temp|tmp|userprofile|homedrive|homepath|appdata|localappdata|programfiles(?:\(x86\))?|programw6432|programdata|username|computername|number_of_processors|processor_architecture)$/i;
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.test(name)));
}

function locateShell(shell, env) {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  const programFiles = env.ProgramW6432 ?? env.ProgramFiles ?? 'C:\\Program Files';
  const override = process.env.LANGVISION_PWSH_PATH;
  const standard = path.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
  const pwsh = override && path.isAbsolute(override) && path.basename(override).toLowerCase() === 'pwsh.exe' ? override : standard;
  const windows = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const configuredPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const candidates = [...new Set([pwsh, standard, ...configuredPath.split(';').filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, 'pwsh.exe'))])];
  for (const [name, executable] of shell === 'powershell' ? [['powershell', windows]] : [...candidates.map(executable => ['pwsh', executable]), ['powershell', windows]]) {
    if (fs.existsSync(executable)) return { name, executable };
  }
  throw fail('PTY_FAILURE', 'PowerShell is not installed in a supported system installation directory.');
}

export async function windowsTerminalDrivers() {
  const [pty, xterm] = await Promise.all([import('node-pty'), import('@xterm/headless')]);
  return { spawn: pty.spawn, Terminal: xterm.Terminal ?? xterm.default.Terminal, locateShell };
}

export function createWindowsTerminal({ authorize, drivers = windowsTerminalDrivers, resolveFolder = resolveTerminalFolder,
  idleMs = 15 * 60_000, tombstoneMs = 60_000, onLifecycle = () => {} }) {
  const sessions = new Map();
  const owner = context => {
    const { workspaceId, conversationId, userMessageId } = context?.identity ?? {};
    if (!workspaceId || !conversationId || !userMessageId) throw fail('PERMISSION_DENIED', 'An authorized agent execution is required.');
    return JSON.stringify([workspaceId, conversationId, userMessageId]);
  };
  const grantFor = context => {
    owner(context);
    try { return authorize(); } catch { throw fail('PERMISSION_DENIED', 'Enable agent-controlled PowerShell in the Coding Workspace grant.'); }
  };
  function get(args, context, closed = false) {
    const grant = grantFor(context);
    const session = sessions.get(args.session_id);
    if (!session || session.owner !== owner(context) || session.grant.id !== grant.id) throw fail('SESSION_NOT_FOUND', 'No terminal session belongs to this execution and grant.');
    if (session.state !== 'running' && !closed) throw fail('SESSION_CLOSED', 'The terminal session is closed.');
    touch(session);
    return session;
  }
  function touch(session) {
    clearTimeout(session.idle);
    if (session.state === 'running') session.idle = setTimeout(() => void close(session, 'idle-timeout'), idleMs).unref();
  }
  function serialize(session, work, signal) {
    if (session.operations >= 64) throw fail('PTY_FAILURE', 'Too many queued terminal operations.');
    session.operations++;
    const next = session.queue.then(() => {
      signal?.throwIfAborted();
      if (session.state !== 'running') throw fail('SESSION_CLOSED', 'The terminal session is closed.');
      return work();
    }).finally(() => { session.operations--; });
    session.queue = next.catch(() => {});
    return next;
  }
  function close(session, reason, exitCode) {
    if (session.state !== 'running') return session.finished;
    session.state = 'closed';
    session.exitCode = exitCode ?? null;
    clearTimeout(session.idle);
    session.grant.signal.removeEventListener('abort', session.revoke);
    session.data?.dispose();
    // Close the ConPTY handle; CTRL_C alone is only keyboard input.
    if (reason !== 'shell-exit') { try { session.pty.kill(); } catch {} }
    session.finished = session.queue.then(() => {
      session.exit?.dispose();
      session.term.dispose();
      onLifecycle(session.identity, { session_id: session.id, state: reason === 'output-flood' ? 'failed' : 'closed', reason, exit_code: session.exitCode });
      setTimeout(() => sessions.delete(session.id), tombstoneMs).unref();
    });
    session.events.emit('change');
    return session.finished;
  }
  function openSettings(args, context) {
    const grant = grantFor(context);
    if (args.load_profile === true || !['pwsh', 'powershell'].includes(args.shell)) throw fail('INVALID_ARGUMENT', 'Choose pwsh or powershell without profile loading.');
    const root = resolveFolder(grant.root, args.project_root);
    if (root.toLowerCase() !== grant.root.toLowerCase()) throw fail('PERMISSION_DENIED', 'project_root must match the granted project.');
    const cwd = resolveFolder(root, args.cwd ?? root);
    const cols = args.cols ?? 100, rows = args.rows ?? 30;
    validDimensions(cols, rows);
    return { grant, root, cwd, cols, rows };
  }
  async function open(args, context, call) {
    const settings = openSettings(args, context);
    if (!call?.approvedAt || call.expectedRevision !== settings.grant.id) throw fail('PERMISSION_DENIED', 'The current terminal session request must be approved.');
    const { spawn, Terminal, locateShell: locate } = await drivers();
    context.signal?.throwIfAborted();
    if (openSettings(args, context).grant.id !== settings.grant.id) throw fail('PERMISSION_DENIED', 'The grant changed while opening.');
    const running = [...sessions.values()].filter(session => session.state === 'running');
    if (running.length >= 8 || running.filter(session => session.owner === owner(context)).length >= 2 || sessions.size >= 128) {
      throw fail('SESSION_LIMIT', 'This execution already has open terminals, or the service limit was reached. Reuse an existing session ID or close an unused session before opening another. Do not switch to the Linux runner for a Windows command.');
    }
    const { grant, cwd, cols, rows } = settings;
    const env = approvedEnvironment();
    const shell = locate(args.shell, env);
    const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
    let pty;
    try { pty = spawn(shell.executable, ['-NoLogo', '-NoProfile'], { cwd, cols, rows, env, name: 'xterm-256color', useConpty: true }); }
    catch (error) { term.dispose(); throw fail('PTY_FAILURE', `Could not open ConPTY: ${error.message}`); }
    const session = { id: randomUUID(), owner: owner(context), identity: context.identity, grant, term, pty, state: 'running',
      queue: Promise.resolve(), operations: 0, pendingBytes: 0, revision: 0, log: outputLog(), events: new EventEmitter(), waits: 0 };
    session.visible = snapshot(term, 0, false, rows);
    const sanitize = outputSanitizer(), decoder = new StringDecoder();
    session.revoke = () => void close(session, 'grant-revoked');
    sessions.set(session.id, session);
    grant.signal.addEventListener('abort', session.revoke, { once: true });
    session.data = pty.onData(chunk => {
      if (session.state !== 'running') return;
      const size = Buffer.byteLength(chunk);
      session.pendingBytes += size;
      if (session.pendingBytes > 1024 * 1024 || session.operations >= 64) { void close(session, 'output-flood'); return; }
      // Keep accepted output ahead of exit notifications and queued reads.
      session.operations++;
      let parsed = '';
      session.queue = session.queue.then(() => new Promise(resolve => {
        parsed = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        term.write(parsed, resolve);
      })).then(() => {
        session.pendingBytes -= size;
        session.log.append(sanitize(parsed));
        session.revision++;
        session.visible = snapshot(term, session.revision, false, term.rows);
        session.events.emit('change');
      }).catch(() => queueMicrotask(() => void close(session, 'parser-failure'))).finally(() => { session.operations--; });
    });
    session.exit = pty.onExit(({ exitCode }) => {
      if (session.state === 'closed') session.exitCode = exitCode;
      else void close(session, 'shell-exit', exitCode);
    });
    touch(session);
    onLifecycle(session.identity, { session_id: session.id, state: 'running', shell: shell.name, cwd });
    return { session_id: session.id, shell: shell.name, cwd, cols, rows, state: 'running' };
  }
  async function wait(args, context) {
    const session = get(args, context, true);
    const { source, regex, after_revision: after, timeout_ms: timeout = 10000 } = args;
    if (!['screen', 'output'].includes(source) || !integer(timeout, 1, 30000) ||
        (after !== undefined && !integer(after, 0, Number.MAX_SAFE_INTEGER)) ||
        (regex !== undefined && (typeof regex !== 'string' || !regex || regex.length > 256))) throw fail('INVALID_ARGUMENT', 'Invalid terminal wait options.');
    let pattern;
    try { if (regex) pattern = RE2JS.compile(regex); } catch { throw fail('INVALID_ARGUMENT', 'Invalid or unsupported terminal wait regex.'); }
    if (session.waits >= 8) throw fail('PTY_FAILURE', 'Too many concurrent terminal waits.');
    const initial = session.revision;
    return new Promise((resolve, reject) => {
      const signal = context.signal;
      let done = false;
      const settle = (timedOut = false) => {
        if (done) return;
        if (signal?.aborted) { cleanup(); reject(signal.reason); return; }
        const running = session.state === 'running';
        const excerpt = (running ? source === 'screen' ? session.visible.lines.join('\n')
          : session.log.tail(16384) : '').slice(-16384);
        const matcher = pattern?.matcher(excerpt);
        const matched = running && (pattern ? (after === undefined || session.revision > after) && matcher.find() : session.revision > (after ?? initial));
        if (!matched && running && !timedOut) return;
        cleanup();
        resolve({ session_id: session.id, source, ...(matched && matcher ? { matched_text: matcher.group().trim() } : {}), matched, timed_out: !matched && running && timedOut, revision: session.revision,
          excerpt: matched && matcher ? excerpt.slice(Math.max(0, matcher.start() - 200), Math.min(excerpt.length, matcher.end() + 200)) : excerpt.slice(-2048),
          state: session.state, ...(!running ? { exit_code: session.exitCode } : {}) });
      };
      const changed = () => settle();
      const timer = setTimeout(() => settle(true), timeout);
      function cleanup() {
        done = true; clearTimeout(timer); session.events.off('change', changed); signal?.removeEventListener('abort', changed); session.waits--;
      }
      session.waits++;
      session.events.on('change', changed);
      signal?.addEventListener('abort', changed, { once: true });
      settle();
    });
  }
  const sessionSchema = (properties = {}, required = []) => schema({ session_id: id, ...properties }, ['session_id', ...required]);
  const tool = (name, description, schema_, action, risk = 'read', revision) => ({
    name: `terminal.${name}`, description, schema: schema_, risk, revision, version: 1,
    async execute(args, context, call) {
      try { return { ok: true, ...await action(args, context, call) }; }
      catch (error) {
        if (context?.signal?.aborted) throw context.signal.reason;
        return { ok: false, error: { code: ['INVALID_ARGUMENT', 'PERMISSION_DENIED', 'SESSION_NOT_FOUND', 'SESSION_CLOSED', 'SESSION_LIMIT', 'PTY_FAILURE'].includes(error.code) ? error.code : 'PTY_FAILURE', message: error.message } };
      }
    },
  });
  const send = (session, input, signal) => serialize(session, () => {
    const revision_before = session.revision;
    session.pty.write(input);
    return { accepted: true, revision_before };
  }, signal);
  return {
    tools: [
      { ...tool('open', 'Request one approval for an unrestricted, persistent Windows PowerShell session. Use the root granted in Coding Workspace.', schema({ project_root: { type: 'string', maxLength: 1024 }, cwd: { type: 'string', maxLength: 1024 }, shell: { enum: ['pwsh', 'powershell'] }, ...dims, load_profile: { const: false } }, ['project_root', 'shell']), open, 'run-control', (a, c) => openSettings(a, c).grant.id),
        preview: a => ({ summary: 'Allow arbitrary text and keys in this PowerShell session under your Windows account. This is not sandboxed.', ...a }) },
      tool('send_text', 'Type a single line in the approved shell. Acceptance does not mean the command succeeded.', sessionSchema({ text: { type: 'string', minLength: 1, maxLength: 8192 }, submit: { type: 'boolean' } }, ['text']), (a, c) => {
        if (typeof a.text !== 'string' || !a.text.length || Buffer.byteLength(a.text) > 8192 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(a.text)) throw fail('INVALID_ARGUMENT', 'Type a single line without control keys, up to 8192 bytes.');
        return send(get(a, c), a.text + (a.submit === false ? '' : '\r'), c.signal);
      }, 'navigate'),
      tool('send_keys', 'Send interactive keys to the approved shell.', sessionSchema({ keys: { type: 'array', items: { enum: Object.keys(keys) }, minItems: 1, maxItems: 32 } }, ['keys']), (a, c) => send(get(a, c), encodeKeys(a.keys), c.signal), 'navigate'),
      tool('get_screen', 'Observe the real rendered terminal screen. Cursor coordinates are zero-based in the viewport.', sessionSchema({ include_scrollback: { type: 'boolean' }, max_lines: number(1, 200) }), (a, c) => {
        const s = get(a, c);
        const limit = a.max_lines ?? Math.max(50, s.term.rows);
        if (!integer(limit, 1, 200)) throw fail('INVALID_ARGUMENT', 'Use max_lines from 1 to 200.');
        return serialize(s, () => ({ session_id: s.id, ...snapshot(s.term, s.revision, a.include_scrollback, limit),
          current_line: s.visible.lines[s.visible.cursor.row]?.trim() ?? '' }));
      }),
      tool('read_output', 'Read bounded sanitized diagnostic output using monotonic UTF-8 offsets.', sessionSchema({ after_offset: number(0, Number.MAX_SAFE_INTEGER), max_bytes: number(4, 16384) }), async (a, c) => {
        const s = get(a, c, true);
        await s.queue;
        return s.log.read(a.after_offset ?? 0, a.max_bytes ?? 16384);
      }),
      tool('wait_for', 'Wait for a rendered screen or diagnostic output match, revision change, deadline, or shell exit.', sessionSchema({ source: { enum: ['screen', 'output'] }, regex: { type: 'string', minLength: 1, maxLength: 256 }, after_revision: number(0, Number.MAX_SAFE_INTEGER), timeout_ms: number(1, 30000) }, ['source']), wait),
      tool('resize', 'Resize the approved shell and its screen emulator together.', sessionSchema(dims, ['cols', 'rows']), (a, c) => {
        validDimensions(a.cols, a.rows);
        const s = get(a, c);
        return serialize(s, () => {
          s.pty.resize(a.cols, a.rows); s.term.resize(a.cols, a.rows); s.revision++;
          s.visible = snapshot(s.term, s.revision, false, s.term.rows);
          s.events.emit('change');
          return { cols: a.cols, rows: a.rows };
        }, c.signal);
      }, 'navigate'),
      tool('close', 'Close the approved terminal. Use discard:true to abandon a failed verification session; that close does not count as verification evidence. Safe to repeat.', sessionSchema({ discard: { type: 'boolean' } }), async (a, c) => {
        const s = get(a, c, true);
        if (s.state === 'running') s.discarded = a.discard === true;
        await close(s, s.discarded ? 'discarded' : 'requested');
        return { session_id: s.id, state: 'closed', exit_code: s.exitCode, discarded: s.discarded === true };
      }, 'navigate'),
    ],
    closeExecution: (id_, reason = 'execution-finished') => Promise.all([...sessions.values()].filter(s => s.identity.userMessageId === id_).map(s => close(s, reason))),
    shutdown: () => Promise.all([...sessions.values()].map(s => close(s, 'service-shutdown'))),
  };
}
