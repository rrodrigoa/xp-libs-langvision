import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

try {
  const require = createRequire(import.meta.url);
  require.resolve('express');
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  if (!existsSync(new URL('../dist/index.html', import.meta.url))) throw new Error('The browser UI has not been built.');
} catch (error) {
  console.error(`LangVision cannot start: ${error.message}`);
  console.error('From the repository root, stop any older LangVision instance, run npm run setup, then run npm start.');
  process.exitCode = 1;
}
