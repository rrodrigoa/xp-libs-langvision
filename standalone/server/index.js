import { createHash, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAssistantRuntime } from './assistantGraph.js';
import { ConsiliumToolHost } from './assistantAgent.js';
import { createAssistantRouter } from './routes/assistant.js';
import { createAssistantDesignRouter } from './routes/assistantDesign.js';
import { interruptActiveConversations } from './assistantStore.js';
import { localModelGateway } from './modelGateway.js';
import { mcpConnections, refreshMcpConnection, saveMcpConnection } from './assistantCapabilities.js';
import { exportAgentPackage, importAgentPackage } from './agentPackage.js';

const root = fileURLToPath(new URL('..', import.meta.url));
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
      (req.get('sec-fetch-site') === 'cross-site' || !req.is('application/json'))) return res.sendStatus(403);
  if (verify && !timingSafeEqual(hash(req.get('authorization') ?? ''), verify)) return res.set('WWW-Authenticate', 'Basic realm="LangVision", charset="UTF-8"').sendStatus(401);
  res.set('X-Content-Type-Options', 'nosniff');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '4mb', strict: true }));
const serviceBaseUrl = 'http://langvision.local';
const contextBroker = {};
const fetchImpl = localModelGateway;
const toolHost = new ConsiliumToolHost({ contextBroker, fetchImpl, serviceBaseUrl });
const agent = createAssistantRuntime({ toolHost, contextBroker, fetchImpl, serviceBaseUrl, mode: 'langgraph' });
interruptActiveConversations();
for (const connection of mcpConnections().filter(item => item.enabled)) {
  try { await refreshMcpConnection(connection.id); } catch { console.warn('Unavailable MCP connection:', connection.id); }
}
const wrap = fn => async (req, res) => {
  try { await fn(req, res); } catch (error) { res.status(error.status ?? 422).json({ error: error.message }); }
};
app.get('/api/ready', (_req, res) => res.json({ ready: true }));
app.get('/api/mcp-connections', (_req, res) => res.json(mcpConnections()));
app.put('/api/mcp-connections', wrap(async (req, res) => res.json(saveMcpConnection(req.body))));
app.post('/api/mcp-connections/:id/discover', wrap(async (req, res) => res.json(await refreshMcpConnection(req.params.id))));
app.get('/api/agent-packages/:id', wrap(async (req, res) => {
  const value = exportAgentPackage(req.params.id);
  res.attachment('agent.langvision.json').json(value);
}));
app.post('/api/agent-packages', wrap(async (req, res) => res.status(201).json(importAgentPackage(req.body))));
app.use('/api/assistant', createAssistantRouter({ agent, fetchImpl, serviceBaseUrl }));
app.use('/api/assistant', createAssistantDesignRouter({ agent, contextBroker, fetchImpl, serviceBaseUrl }));
app.use(express.static(dist));
app.listen(port, host, () => console.log('LangVision listening on ' + host + ':' + port));
