import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dependencies = fileURLToPath(new URL('../node_modules/', import.meta.url));
if (process.platform === 'win32') {
  // npm ci removes dependencies before installing; a mapped native DLL would leave a partial tree.
  const scan = `
    $root = $env:LANGVISION_SETUP_DEPENDENCIES
    Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
      $processId = $_.Id
      $_.Modules | Where-Object {
        $_.ModuleName -eq 'better_sqlite3.node' -and
        $_.FileName.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
      } | ForEach-Object { $processId }
    } | Sort-Object -Unique
  `;
  let owners;
  try {
    owners = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', scan], {
      env: { ...process.env, LANGVISION_SETUP_DEPENDENCIES: dependencies }, encoding: 'utf8', windowsHide: true,
    }).trim();
  } catch {
    console.error('Could not check for locked LangVision dependencies. Close any running LangVision service, then retry npm run setup.');
    process.exit(1);
  }
  if (owners) {
    console.error(`LangVision setup has not changed dependencies. SQLite is loaded by Node process(es): ${owners.split(/\s+/).join(', ')}.`);
    console.error('Stop this worktree\'s LangVision service with Ctrl+C, then run npm run setup again. See README.md for an orphaned server.');
    process.exit(1);
  }
}

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run setup from the repository root.');
for (const args of [['ci'], ['run', 'build']]) {
  const result = spawnSync(process.execPath, [npm, '--prefix', 'standalone', ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error('Setup did not finish. Resolve the error above and rerun npm run setup before starting the service.');
    process.exit(result.status ?? 1);
  }
}
