import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import yauzl from 'yauzl';

export const PACKAGE_LIMIT = 4 * 1024 * 1024;
const format = 'langvision/agent-zip-v1';
const compatibleVersion = '0.1.0';
const digest = value => createHash('sha256').update(value).digest('hex');
const names = new Set(['manifest.json', 'agent.json']);
const manifestLimit = 4096;

export async function encodeAgentZip(value) {
  const agent = Buffer.from(JSON.stringify(value));
  const manifest = JSON.stringify({ format, minimumVersion: compatibleVersion, sha256: digest(agent) });
  if (agent.length + Buffer.byteLength(manifest) > PACKAGE_LIMIT) throw new Error('Expanded package exceeds 4 MiB.');
  const zip = new JSZip();
  const date = new Date('1980-01-01T00:00:00Z');
  zip.file('manifest.json', manifest, { date });
  zip.file('agent.json', agent, { date });
  const result = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  if (result.length > PACKAGE_LIMIT) throw new Error('ZIP package exceeds 4 MiB.');
  return result;
}

function readEntries(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = new Map();
      let total = 0;
      const fail = error => { zip.close(); reject(error); };
      zip.on('error', fail);
      if (zip.entryCount !== names.size) return fail(new Error('Expected exactly manifest.json and agent.json.'));
      zip.on('end', () => {
        if (entries.size !== names.size) return fail(new Error('Incomplete agent ZIP.'));
        resolve(entries);
      });
      zip.on('entry', entry => {
        const name = entry.fileName;
        const type = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (!names.has(name) || entries.has(name) || (type && type !== 0x8000) || (entry.externalFileAttributes & 0x10)) {
          return fail(new Error('Invalid or duplicate ZIP entry.'));
        }
        const limit = Math.min(PACKAGE_LIMIT - total, name === 'manifest.json' ? manifestLimit : PACKAGE_LIMIT);
        if (entry.uncompressedSize > limit) return fail(new Error('Expanded ZIP entry exceeds the limit.'));
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(error);
          const chunks = [];
          let size = 0;
          stream.on('error', fail);
          stream.on('data', chunk => {
            size += chunk.length;
            if (size > limit) { stream.destroy(new Error('Expanded ZIP entry exceeds the limit.')); return; }
            chunks.push(chunk);
          });
          stream.on('end', () => {
            total += size;
            entries.set(name, Buffer.concat(chunks, size));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

export async function decodeAgentZip(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > PACKAGE_LIMIT) throw new Error('Invalid ZIP package size.');
  const entries = await readEntries(buffer);
  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
  const agent = entries.get('agent.json');
  if (manifest?.format !== format || manifest.minimumVersion !== compatibleVersion) throw new Error('Incompatible agent ZIP manifest.');
  if (manifest.sha256 !== digest(agent)) throw new Error('Agent ZIP payload digest does not match.');
  return JSON.parse(agent.toString('utf8'));
}
