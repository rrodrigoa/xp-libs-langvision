import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const fileLimit = 256 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const excluded = /^(?:\.git|\.ssh|\.aws|\.env(?:\..*)?|\.langvision-.*|node_modules|.*\.(?:pem|key|pfx|p12))$/i;
const denied = () => new Error('Grant access to a dedicated workspace in the Coding Workspace tab first.');
const string = { type: 'string', minLength: 1, maxLength: 512 };
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });

export async function checkPowerShellSource(source, signal) {
  const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // The generated parser program is constant; script text is data, never executed.
  const inputParser = Buffer.from("[Console]::OutputEncoding=[Text.Encoding]::UTF8; $e=$null; $t=$null; $s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())); [void][System.Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e); [Console]::Write((ConvertTo-Json -Compress -InputObject @($e | ForEach-Object { @{ line=$_.Extent.StartLineNumber; column=$_.Extent.StartColumnNumber; message=$_.Message } })))", 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = execFile(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', inputParser], {
      windowsHide: true, timeout: 8000, maxBuffer: 65536, signal, encoding: 'utf8',
    }, (error, stdout) => {
      if (error) { reject(Object.assign(new Error('The Windows PowerShell parser could not run. No file was written.'), { code: 'POWERSHELL_PARSER_UNAVAILABLE' })); return; }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(source, 'utf8').toString('base64') + '\n');
  });
}

export function createCodingWorkspace({ image = process.env.LANGVISION_CODING_IMAGE ?? 'python:3.12-slim', runner = runContainer } = {}) {
  let grant, expiry;
  function state() {
    if (!grant || Date.now() >= grant.expiresAt) throw denied();
    const stat = fs.lstatSync(grant.root);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.ino !== grant.ino || stat.dev !== grant.dev ||
        fs.realpathSync.native(grant.root) !== grant.root) throw new Error('The granted folder was replaced. Grant it again.');
    return grant;
  }
  function resolve(relative, { missing = false } = {}) {
    const current = state();
    if (typeof relative !== 'string' || !relative.length || relative.length > 512) throw new Error('Use a workspace-relative path.');
    const parts = relative.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || excluded.test(part) || /[\\:<>"|?*\x00-\x1f]/.test(part) ||
      /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))) throw new Error('Path is outside the allowed workspace or is reserved.');
    let result = current.root;
    for (const [index, part] of parts.entries()) {
      result = path.join(result, part);
      const stat = fs.lstatSync(result, { throwIfNoEntry: false });
      if (!stat && missing && index === parts.length - 1) return { absolute: result, stat };
      if (!stat || stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) ||
          (stat.isFile() && stat.nlink > 1)) throw new Error('Missing or unsafe workspace path.');
    }
    return { absolute: result, stat: fs.lstatSync(result) };
  }
  function read(relative) {
    const { absolute, stat } = resolve(relative);
    if (!stat.isFile() || stat.size > fileLimit) throw new Error('Expected a text file no larger than 256 KiB.');
    const contents = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(absolute));
    if (contents.includes('\0')) throw new Error('Binary files are not supported.');
    return { path: relative, contents };
  }
  function list(relative) {
    if (relative === '.') relative = undefined;
    const base = relative ? resolve(relative).absolute : state().root;
    const result = [];
    let visited = 0;
    function walk(dir, prefix, depth) {
      if (depth > 12) throw new Error('Workspace exceeds the maximum directory depth.');
      const entries = fs.opendirSync(dir);
      try {
        for (let item; (item = entries.readSync());) {
          if (++visited > 1000) throw new Error('Use a smaller workspace or select a subdirectory.');
          if (excluded.test(item.name) || item.isSymbolicLink() || !(item.isDirectory() || item.isFile())) continue;
          const name = prefix + item.name;
          try { resolve(name); } catch { continue; }
          if (item.isDirectory()) walk(path.join(dir, item.name), name + '/', depth + 1);
          else result.push(name);
        }
      } finally { entries.closeSync(); }
    }
    walk(base, relative ? relative + '/' : '', 0);
    return result.sort();
  }
  function inspectEdit(args) {
    const current = state();
    if (!current.write) throw new Error('The operator granted read-only access.');
    const source = resolve(args.path, { missing: true });
    const old = source.stat?.isFile() ? read(args.path).contents : null;
    if (args.operation === 'write') {
      if (typeof args.contents !== 'string' || Buffer.byteLength(args.contents) > fileLimit || args.contents.includes('\0') || source.stat?.isDirectory()) throw new Error('Provide a UTF-8 file of at most 256 KiB.');
    } else if (args.operation === 'mkdir') {
      if (source.stat) throw new Error('Directory already exists.');
    } else if (args.operation === 'rename' || args.operation === 'delete') {
      if (!source.stat || (source.stat.isDirectory() && fs.readdirSync(source.absolute).length)) throw new Error('Select a file or an empty directory.');
      if (args.operation === 'rename' && resolve(args.destination, { missing: true }).stat) throw new Error('Rename destination already exists.');
    } else throw new Error('Unsupported workspace edit.');
    return JSON.stringify({ grant: current.id, source: source.stat ? { dev: source.stat.dev, ino: source.stat.ino, directory: source.stat.isDirectory(), hash: old === null ? null : digest(old) } : null });
  }
  function edit(args, _context, call) {
    const revision = inspectEdit(args);
    if (!call?.approvedAt || call.expectedRevision !== revision) throw new Error('A current approval of this exact edit is required.');
    const source = resolve(args.path, { missing: true }).absolute;
    if (args.operation === 'mkdir') fs.mkdirSync(source);
    if (args.operation === 'rename') fs.renameSync(source, resolve(args.destination, { missing: true }).absolute);
    if (args.operation === 'delete') {
      const backup = path.join(path.dirname(source), '.langvision-recovery-' + randomUUID());
      fs.renameSync(source, backup);
      return { operation: args.operation, path: args.path, recoveryName: path.basename(backup) };
    }
    if (args.operation === 'write') {
      const temporary = path.join(path.dirname(source), '.langvision-write-' + randomUUID());
      try {
        fs.writeFileSync(temporary, args.contents, { flag: 'wx' });
        fs.renameSync(temporary, source);
      } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
    return { operation: args.operation, path: args.path, ...(args.destination ? { destination: args.destination } : {}), ...(args.operation === 'write' ? { sha256: digest(args.contents) } : {}) };
  }
  function snapshot() {
    const files = [];
    let bytes = 0;
    for (const name of list()) {
      if (name.split('/').some(part => part.startsWith('.langvision-'))) continue;
      const file = read(name);
      bytes += Buffer.byteLength(file.contents);
      if (files.length >= 100 || bytes > 1024 * 1024) throw new Error('Command snapshot exceeds 100 files or 1 MiB.');
      files.push(file);
    }
    return files;
  }
  const tools = [
    { name: 'workspace.list', description: 'List files and identify the host platform where the operator will use the result. The test runner itself is Linux.', risk: 'read', schema: schema({ directory: { type: 'string', maxLength: 512, description: 'Empty or omitted for the granted root.' } }, []), execute: args => ({ files: list(args.directory), targetPlatform: process.platform, runnerPlatform: 'linux', ...(state().terminal ? { terminalProjectRoot: state().root } : {}) }) },
    { name: 'workspace.read', description: 'Read one UTF-8 source file in the granted workspace.', risk: 'read', schema: schema({ path: string }), execute: args => read(args.path) },
    { name: 'workspace.search', description: 'Find literal text in approved workspace source files.', risk: 'read', schema: schema({ text: string }), execute: args => {
      const matches = [];
      for (const file of snapshot()) for (const [index, line] of file.contents.split('\n').entries()) {
        if (line.includes(args.text)) matches.push({ path: file.path, line: index + 1, text: line.slice(0, 512) });
        if (matches.length === 50) return { matches, limited: true };
      }
      return { matches };
    } },
    { name: 'workspace.edit', description: 'Propose an exact edit in the approved workspace. For write, provide complete UTF-8 contents. For rename, provide destination. Delete is recoverable. Parent directories must exist.',
      risk: 'write', schema: schema({ operation: { enum: ['write', 'mkdir', 'rename', 'delete'] }, path: string, destination: string, contents: { type: 'string', maxLength: fileLimit } }, ['operation', 'path']),
      async preflight(args, context) {
        if (process.platform !== 'win32' || args.operation !== 'write' || !/\.ps1$/i.test(args.path)) return;
        inspectEdit(args);
        const diagnostics = await checkPowerShellSource(args.contents, context.signal);
        if (diagnostics.length) throw Object.assign(new Error('PowerShell syntax check failed before approval. ' +
          diagnostics.slice(0, 5).map(item => `Line ${item.line}, column ${item.column}: ${item.message}`).join(' ')), { code: 'POWERSHELL_SYNTAX' });
      },
      preview: args => ({ summary: args.operation + ' ' + args.path, before: JSON.parse(inspectEdit(args)).source?.hash ? read(args.path).contents : null, after: args.contents ?? null, destination: args.destination ?? null }),
      revision: inspectEdit, execute: edit },
    { name: 'workspace.run', description: 'Run a non-interactive command in a disposable Linux snapshot rooted at /work. Host drive paths cannot be accessed. PowerShell is not installed in the default image; use the approved Windows terminal for PowerShell on Windows.',
      risk: 'run-control', schema: schema({ shell: { enum: ['bash', 'python', 'powershell'] }, command: { ...string, maxLength: 8192 } }),
      preview: args => ({ summary: 'Run in isolated workspace copy', ...args }),
      preflight(args) {
        if (/(?:\b[A-Za-z]:[\\/]|(?:^|\s)\/[a-z](?:\/|\\)Source\b)/i.test(args.command) ||
            (image === 'python:3.12-slim' && (args.shell === 'powershell' || /\bpwsh(?:\.exe)?\s+-/i.test(args.command)))) {
          throw Object.assign(new Error('The Linux workspace runner cannot access a Windows host drive or run host PowerShell. Use the approved Windows terminal, or use relative snapshot paths for Linux tests.'), { code: 'RUNNER_PLATFORM_MISMATCH' });
        }
      },
      revision: () => JSON.stringify({ grant: state().id, snapshot: digest(JSON.stringify(snapshot())) }),
      execute: (args, context, call) => {
        const current = state();
        const files = snapshot();
        if (!call?.approvedAt || call.expectedRevision !== JSON.stringify({ grant: current.id, snapshot: digest(JSON.stringify(files)) })) throw new Error('A current approval of this command and workspace snapshot is required.');
        const signal = context.signal ? AbortSignal.any([context.signal, current.controller.signal]) : current.controller.signal;
        return Promise.resolve(runner({ ...args, files, image, signal })).then(result => ({
          ...result, verified: result.exitCode === 0 && !result.error,
        }));
      } },
  ];
  for (const tool of tools) {
    tool.version = 1;
    if (tool.risk === 'read') tool.revision = () => state().id;
  }
  return {
    tools,
    grant(root, write, terminal = false) {
      if (typeof root !== 'string' || !path.isAbsolute(root) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(root))) throw new Error('Enter an existing local absolute folder path.');
      const canonical = fs.realpathSync.native(root);
      const stat = fs.lstatSync(canonical);
      if (!stat.isDirectory() || canonical === path.parse(canonical).root ||
          canonical.toLowerCase() === fs.realpathSync.native(homedir()).toLowerCase() ||
          canonical.split(path.sep).some(part => excluded.test(part))) throw new Error('Choose a dedicated project folder, not a home, drive root, or sensitive directory.');
      this.revoke();
      grant = { root: canonical, write: write === true, terminal: terminal === true && process.platform === 'win32', expiresAt: Date.now() + 60 * 60 * 1000, id: randomUUID(), dev: stat.dev, ino: stat.ino, controller: new AbortController() };
      expiry = setTimeout(() => this.revoke(), 60 * 60 * 1000);
      expiry.unref();
      return this.status();
    },
    revoke() { clearTimeout(expiry); grant?.controller.abort(); grant = undefined; },
    terminalGrant() {
      const current = state();
      if (!current.terminal) throw denied();
      return { root: current.root, id: current.id, signal: current.controller.signal };
    },
    status() {
      if (!grant || Date.now() >= grant.expiresAt) return { granted: false };
      return { granted: true, root: grant.root, write: grant.write, terminal: grant.terminal, expiresAt: grant.expiresAt };
    }
  };
}

const bootstrap = `
import json, os, pathlib, subprocess, sys
job = json.load(sys.stdin)
for item in job["files"]:
    p = pathlib.Path(item["path"])
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(item["contents"], encoding="utf-8")
shells = {"bash": ["bash", "-c"], "python": ["python", "-c"], "powershell": ["pwsh", "-NoProfile", "-NonInteractive", "-Command"]}
sys.exit(subprocess.call(shells[job["shell"]] + [job["command"]], stdin=subprocess.DEVNULL))
`;

export async function runContainer({ shell, command, files, image, signal, timeoutMs = 20000 }) {
  signal?.throwIfAborted();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9./_:@-]*$/.test(image)) throw new Error('Invalid runner image.');
  const name = 'langvision-run-' + randomUUID();
  const args = ['run', '--pull=never', '--rm', '-i', '--name', name, '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=256m', '--cpus=1',
    '--user=65534:65534', '--tmpfs', '/work:rw,nosuid,nodev,noexec,mode=1777,size=32m', '--workdir', '/work',
    '--env', 'HOME=/work', '--entrypoint', 'python', image, '-c', bootstrap];
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stopped = null, cleanupTimer;
    function stop(reason) {
      if (stopped) return;
      stopped = reason;
      const cleanup = spawn('docker', ['rm', '-f', name], { windowsHide: true, stdio: 'ignore' });
      cleanup.on('error', () => child.kill());
      cleanup.on('close', () => { clearTimeout(cleanupTimer); child.kill(); });
      cleanupTimer = setTimeout(() => { cleanup.kill(); child.kill(); }, 4000);
    }
    const abort = () => stop('Command canceled.');
    const timer = setTimeout(() => stop('Command timed out.'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    function clear() { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    child.stdout.setEncoding('utf8').on('data', value => { if (stdout.length + value.length > 65536) stop('Command output exceeded the limit.'); else stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { if (stderr.length + value.length > 65536) stop('Command output exceeded the limit.'); else stderr += value; });
    child.stdin.on('error', () => {});
    child.on('error', error => { clear(); reject(new Error('Docker runner unavailable: ' + error.message)); });
    child.on('close', exitCode => {
      clear();
      resolve({ exitCode, stdout, stderr, ...(stopped ? { error: stopped } : {}) });
    });
    child.stdin.end(JSON.stringify({ shell, command, files }));
  });
}
