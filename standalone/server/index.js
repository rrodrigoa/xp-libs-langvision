import { createHash, timingSafeEqual } from 'node:crypto';
import { statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAssistantRuntime } from './assistantGraph.js';
import { ConsiliumToolHost } from './assistantAgent.js';
import { createAssistantRouter } from './routes/assistant.js';
import { createAssistantDesignRouter } from './routes/assistantDesign.js';
import { interruptActiveConversations, provisionLocalCodingAgent, recordWorkspaceAuditEvent } from './assistantStore.js';
import { localModelGateway } from './modelGateway.js';
import { ASSISTANT_CAPABILITIES, mcpConnections, refreshMcpConnection, saveMcpConnection } from './assistantCapabilities.js';
import { exportAgentPackage, importAgentPackage } from './agentPackage.js';
import { encodeAgentZip, decodeAgentZip, PACKAGE_LIMIT } from './agentZip.js';
import { createCodingWorkspace } from './codingWorkspace.js';
import { researchCapabilities, researchMcp } from './researchMcp.js';
import { createWindowsTerminal, windowsTerminalDrivers } from './windowsTerminal.js';

const root = fileURLToPath(new URL('..', import.meta.url));
// Ensure the data directory exists for the SQLite workspace database.
try { mkdirSync(path.join(root, 'data'), { recursive: true }); } catch {}
const dist = path.join(root, 'dist');
if (!statSync(path.join(dist, 'index.html'), { throwIfNoEntry: false })?.isFile()) {
  console.error('LangVision UI is not built. Run npm run setup from the repository root, or npm ci and npm run build from standalone/.');
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8780);
const host = process.env.LANGVISION_BIND ?? '127.0.0.1';
const password = process.env.LANGVISION_OPERATOR_PASSWORD;
const externalOrigin = process.env.LANGVISION_PUBLIC_ORIGIN;
const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
if ((!loopback || externalOrigin) && (!password || password.length < 24 || !externalOrigin ||
    new URL(externalOrigin).protocol !== 'https:' || new URL(externalOrigin).origin !== externalOrigin)) {
  throw new Error('Remote access requires an HTTPS public origin and a private operator password of at least 24 characters.');
}
process.env.CHRONOSQL_WORKSPACE_DB = process.env.LANGVISION_DB ?? path.resolve(root, 'data/langvision.sqlite');
process.env.CHRONOSQL_AI_DEBUG_CAPTURE = process.env.LANGVISION_DEBUG_CAPTURE ?? 'raw';
const app = express();
app.disable('x-powered-by');
const hash = value => createHash('sha256').update(value).digest();
const verify = password ? hash('Basic ' + Buffer.from('operator:' + password).toString('base64')) : null;
const hosts = new Set(['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port, ...(externalOrigin ? [new URL(externalOrigin).host] : [])]);
app.use((req, res, next) => {
  const origin = req.get('origin');
  const requestHost = req.get('host') ?? '';
  if (!hosts.has(requestHost) || (origin && origin !== externalOrigin && origin !== 'http://' + requestHost)) return res.sendStatus(403);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      (req.get('sec-fetch-site') === 'cross-site' || !(req.is('application/json') ||
        (req.method === 'POST' && req.path === '/api/agent-packages' && req.is('application/zip'))))) return res.sendStatus(403);
  if (verify && !timingSafeEqual(hash(req.get('authorization') ?? ''), verify)) return res.set('WWW-Authenticate', 'Basic realm="LangVision", charset="UTF-8"').sendStatus(401);
  res.set('X-Content-Type-Options', 'nosniff');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
// Parse JSON bodies for standard agent package imports and other API calls.
app.use(express.json({ limit: '4mb', strict: true }));
const serviceBaseUrl = 'http://langvision.local';
const contextBroker = {};
const fetchImpl = localModelGateway;
const coding = createCodingWorkspace();
const terminalDrivers = process.platform === 'win32' && loopback && !externalOrigin
  ? await windowsTerminalDrivers().catch(error => { console.warn('Windows terminal unavailable:', error.message); return null; }) : null;
const terminal = terminalDrivers ? createWindowsTerminal({
  drivers: async () => terminalDrivers,
  authorize: () => coding.terminalGrant(),
  onLifecycle: (identity, event) => recordWorkspaceAuditEvent({
    workspaceId: identity.workspaceId, kind: 'agent-terminal-session', title: 'Windows terminal', summary: event.reason ?? event.shell,
    status: event.state, surface: identity.surface, signature: `${event.session_id}:${event.state}`,
    metadata: { ...event, conversationId: identity.conversationId, userMessageId: identity.userMessageId },
  }),
}) : null;
const research = loopback && !externalOrigin ? researchCapabilities(process.env.LANGVISION_SEARCH_URL, { browser: process.env.LANGVISION_WEB_BROWSER === '1' }) : [];
if (loopback && !externalOrigin) {
  ASSISTANT_CAPABILITIES.push(...coding.tools, ...research, ...(terminal?.tools ?? []));
  provisionLocalCodingAgent(process.env, { terminal: Boolean(terminal) });
}
const toolHost = new ConsiliumToolHost({ contextBroker, fetchImpl, serviceBaseUrl });
const agent = createAssistantRuntime({ toolHost, contextBroker, fetchImpl, serviceBaseUrl, mode: 'langgraph', terminal, research });
interruptActiveConversations();
for (const connection of mcpConnections().filter(item => item.enabled)) {
  try { await refreshMcpConnection(connection.id); } catch { console.warn('Unavailable MCP connection:', connection.id); }
}
const wrap = fn => async (req, res) => {
  try { await fn(req, res); } catch (error) { res.status(error.status ?? 422).json({ error: error.message }); }
};
app.get('/api/ready', (_req, res) => res.json({ ready: true }));
if (loopback && !externalOrigin) {
  const codingStatus = () => ({ ...coding.status(), terminalAvailable: Boolean(terminal) });
  app.get('/api/coding-workspace', (_req, res) => res.json(codingStatus()));
  app.get('/api/coding-workspace/tools', (_req, res) => res.json([...coding.tools, ...research, ...(terminal?.tools ?? [])].map(({ name, description, risk, schema }) => ({ name, description, risk, schema }))));
  app.put('/api/coding-workspace', wrap(async (req, res) => { coding.grant(req.body.path, req.body.write, Boolean(terminal) && req.body.terminal === true); res.json(codingStatus()); }));
  app.post('/api/coding-workspace/revoke', (_req, res) => { coding.revoke(); res.json(codingStatus()); });
  if (process.env.LANGVISION_SEARCH_URL) app.post('/mcp/research', wrap(researchMcp(process.env.LANGVISION_SEARCH_URL)));
}
app.get('/api/mcp-connections', (_req, res) => res.json(mcpConnections()));
app.put('/api/mcp-connections', wrap(async (req, res) => res.json(saveMcpConnection(req.body))));
app.post('/api/mcp-connections/:id/discover', wrap(async (req, res) => res.json(await refreshMcpConnection(req.params.id))));
app.get('/api/agent-packages/:id', wrap(async (req, res) => {
  const value = exportAgentPackage(req.params.id);
  if (req.query.format === 'json') return res.attachment('agent.langvision.json').json(value);
  res.attachment('agent.langvision.zip').send(await encodeAgentZip(value));
}));
app.post('/api/agent-packages', express.raw({ type: 'application/zip', limit: PACKAGE_LIMIT, inflate: false }), wrap(async (req, res) => {
  const value = req.is('application/zip') ? await decodeAgentZip(req.body) : req.body;
  res.status(201).json(importAgentPackage(value));
}));
app.use('/api/assistant', createAssistantRouter({ agent, fetchImpl, serviceBaseUrl }));
app.use('/api/assistant', createAssistantDesignRouter({ agent, contextBroker, fetchImpl, serviceBaseUrl }));
app.use(express.static(dist));
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  res.status(error.status ?? 500).json({ error: error.status && error.status < 500 ? error.message : 'LangVision request failed.' });
});
app.listen(port, host, () => console.log('LangVision listening on ' + host + ':' + port));
if (terminal || research.shutdown) for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  const deadline = setTimeout(() => process.exit(1), 3000).unref();
  void Promise.allSettled([terminal?.shutdown(), research.shutdown?.()]).finally(() => { clearTimeout(deadline); process.exit(0); });
});
