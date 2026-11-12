import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { assistantDebugDatabase } from './assistantStore.js';
import { validateAgentSchema } from '../shared/agentJsonSchema.js';

export const ASSISTANT_CAPABILITIES = [];
export const capabilityByName = name => ASSISTANT_CAPABILITIES.find(item => item.name === name);
export const validateCapabilityArguments = (capability, args) => validateAgentSchema(capability.schema, args);
const keyPattern = /^[a-z][a-z0-9_-]{0,39}$/;
const safeName = /^[a-zA-Z0-9_.-]{1,100}$/;
const bearerBinding = /^LANGVISION_SECRET_[A-Z0-9_]+$/;
const unauthorized = () => Object.assign(new Error('Enable and refresh this MCP connection before running its tools.'), { status: 409 });

function table() {
  const db = assistantDebugDatabase();
  db.exec('CREATE TABLE IF NOT EXISTS standalone_mcp (id TEXT PRIMARY KEY, definition TEXT NOT NULL)');
  return db;
}
export function mcpConnections() {
  return table().prepare('SELECT definition FROM standalone_mcp ORDER BY id').all().map(row => JSON.parse(row.definition));
}
export function normalizeMcpConnection(value, portable = false) {
  if (!value || !keyPattern.test(value.id ?? '')) throw new Error('Use a lowercase MCP connection ID.');
  const endpoint = new URL(value.url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw new Error('Use an HTTP(S) MCP URL without inline credentials or query parameters.');
  }
  if (value.tokenEnv && !bearerBinding.test(value.tokenEnv)) throw new Error('MCP credentials must use a LANGVISION_SECRET_ environment variable.');
  if (!Array.isArray(value.tools) || value.tools.length > 200 || value.tools.some(tool => !safeName.test(tool))) throw new Error('Provide an explicit MCP tool allowlist.');
  return { id: value.id, url: endpoint.href, tokenEnv: portable ? '' : value.tokenEnv ?? '',
    enabled: !portable && value.enabled === true, tools: [...new Set(value.tools)], revision: portable ? undefined : (value.revision ?? 0) + 1 };
}
function register(definition) {
  for (let index = ASSISTANT_CAPABILITIES.length - 1; index >= 0; index--) {
    if (ASSISTANT_CAPABILITIES[index].connectionId === definition.id) ASSISTANT_CAPABILITIES.splice(index, 1);
  }
}
export function persistMcpConnection(definition) {
  table().prepare('INSERT INTO standalone_mcp VALUES (?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition')
    .run(definition.id, JSON.stringify(definition));
}
export function saveMcpConnection(value) {
  const existing = mcpConnections().find(item => item.id === value?.id);
  const definition = normalizeMcpConnection({ ...value, revision: existing?.revision ?? 0 });
  persistMcpConnection(definition);
  register(definition);
  return definition;
}
async function withClient(definition, callback) {
  if (!definition.enabled) throw unauthorized();
  const token = definition.tokenEnv ? process.env[definition.tokenEnv] : '';
  if (definition.tokenEnv && !token) throw new Error('The configured MCP credential is not available.');
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  const client = new Client({ name: 'LangVision', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(definition.url), {
    requestInit: { headers, redirect: 'error' },
  });
  try {
    await client.connect(transport);
    return await callback(client);
  } finally { await client.close(); }
}
export async function refreshMcpConnection(id) {
  const definition = mcpConnections().find(item => item.id === id);
  if (!definition) throw unauthorized();
  const discovered = await withClient(definition, client => client.listTools(undefined, { timeout: 15000 }));
  if (mcpConnections().find(item => item.id === id)?.revision !== definition.revision) throw unauthorized();
  register(definition);
  for (const tool of discovered.tools) {
    if (!safeName.test(tool.name) || !definition.tools.includes(tool.name)) continue;
    const current = () => {
      const saved = mcpConnections().find(item => item.id === id);
      if (!saved?.enabled || saved.revision !== definition.revision) throw unauthorized();
      return saved;
    };
    ASSISTANT_CAPABILITIES.push({
      name: id + '.' + tool.name, connectionId: id,
      description: String(tool.description ?? tool.name).slice(0, 4000), schema: tool.inputSchema,
      risk: 'write', preview: () => ({ summary: 'Call ' + tool.name + ' on ' + id + '.' }),
      revision: () => current().revision,
      execute: async (args, execution) => {
        const result = await withClient(current(), client => client.callTool({ name: tool.name, arguments: args }, undefined, {
          timeout: 30000, signal: execution.signal,
        }));
        if (result.isError) throw new Error('MCP tool reported failure. Inspect the operation status before attempting another write.');
        return result.structuredContent ?? result.content;
      },
    });
  }
  return { available: discovered.tools.map(item => item.name).filter(name => safeName.test(name)), enabled: ASSISTANT_CAPABILITIES.filter(item => item.connectionId === id).map(item => item.name) };
}
