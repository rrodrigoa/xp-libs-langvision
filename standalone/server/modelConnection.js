import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// Back up the protected key beside ChronusDB as well as the database. An external key may be mounted.
function key(dbPath) {
  const filename = process.env.CHRONUS_MODEL_SECRET_KEY_FILE ?? `${dbPath}.model-key`;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  try { fs.writeFileSync(filename, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const value = fs.readFileSync(filename);
  if (value.length !== 32) throw new Error('Model secret key file must contain exactly 32 bytes.');
  return value;
}
export function encryptModelSecret(value, dbPath) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(dbPath), iv);
  return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
export function decryptModelSecret(value, dbPath) {
  const bytes = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', key(dbPath), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
}
export function validateModelConnection(profile) {
  const provider = profile.provider ?? 'ollama';
  if (!['ollama', 'openai-compatible'].includes(provider)) throw new Error('Select Ollama or OpenAI-compatible.');
  const baseUrlSource = profile.baseUrlSource ?? 'value';
  const authMode = profile.authMode ?? 'none', apiKeySource = profile.apiKeySource ?? 'value';
  for (const [source, variable] of [[baseUrlSource, profile.baseUrlEnvironmentVariable], [apiKeySource, profile.apiKeyEnvironmentVariable]]) {
    if (!['value', 'environment'].includes(source)) throw new Error('Invalid connection value source.');
    if (source === 'environment' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable ?? '')) throw new Error('Enter an environment variable name, not its value.');
  }
  if (baseUrlSource === 'environment' && provider !== 'openai-compatible') throw new Error('Environment endpoint binding is available for OpenAI-compatible connections.');
  if (!['none', 'bearer', 'api-key'].includes(authMode)) throw new Error('Invalid authentication mode.');
  if (!['max_tokens', 'max_completion_tokens'].includes(profile.tokenLimitParameter ?? 'max_tokens')) throw new Error('Invalid output-token parameter.');
  if (!['', 'none', 'low', 'medium', 'high'].includes(profile.reasoningEffort ?? '')) throw new Error('Invalid reasoning effort.');
  return { provider, baseUrlSource, baseUrlEnvironmentVariable: profile.baseUrlEnvironmentVariable ?? '', authMode,
    apiKeySource, apiKeyEnvironmentVariable: profile.apiKeyEnvironmentVariable ?? '',
    tokenLimitParameter: profile.tokenLimitParameter ?? 'max_tokens', sendSampling: profile.sendSampling ?? true,
    reasoningEffort: profile.reasoningEffort ?? '' };
}
