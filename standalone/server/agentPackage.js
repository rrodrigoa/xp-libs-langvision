import { randomUUID } from 'node:crypto';
import { assistantDebugDatabase, listAiProfiles, listAssistantWorkflows, listAssistantWorkflowDrafts, saveAssistantWorkflowDraft } from './assistantStore.js';
import { mcpConnections, normalizeMcpConnection, persistMcpConnection } from './assistantCapabilities.js';
import { primitiveWorkflows, validatePrimitiveAgent } from '../shared/primitiveAgentModel.js';

const format = 'langvision/agent-package-v1';
const profileFields = ['id', 'displayName', 'provider', 'model', 'numCtx', 'temperature', 'seed',
  'think', 'thinkingMode', 'baseUrl', 'timeoutMs', 'maxConcurrency', 'keepAlive', 'expectedDigest',
  'authMode', 'reasoningEffort', 'tokenLimitParameter', 'sendSampling'];
const privateKey = /^(?:authorization|api.?key|access.?token|secret|password|credential(?:Reference|Value)?|tokenEnv|private.?key)$/i;
function assertPortable(value, depth = 0) {
  if (depth > 60) throw new Error('Package nesting exceeds the limit.');
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || privateKey.test(key)) throw new Error('Packages cannot contain credentials or unsafe fields.');
    assertPortable(child, depth + 1);
  }
}
function remapToolNames(value, map, field = '') {
  if (typeof value === 'string' && ['toolNames', 'toolName', 'afterTool', 'whenObserved'].includes(field)) {
    for (const [from, to] of map) if (value.startsWith(from + '.')) return to + value.slice(from.length);
  }
  if (Array.isArray(value)) return value.map(item => remapToolNames(item, map, field));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapToolNames(item, map, key)]));
  return value;
}
function inspectDefinition(definition) {
  assertPortable(definition);
  const diagnostics = validatePrimitiveAgent(definition);
  if (diagnostics.length) throw new Error(diagnostics.join(' '));
}
export function exportAgentPackage(id) {
  const saved = listAssistantWorkflowDrafts().find(item => item.id === id) ?? listAssistantWorkflows().find(item => item.id === id);
  if (!saved) throw new Error('Agent not found.');
  const definition = structuredClone(saved.definition);
  inspectDefinition(definition);
  const models = new Set(primitiveWorkflows(definition).flatMap(([, graph]) => [graph.profileId, ...graph.nodes.map(node => node.settings?.profileId)]).filter(Boolean));
  const tools = new Set(primitiveWorkflows(definition).flatMap(([, graph]) => graph.nodes.flatMap(node => node.settings?.toolNames ?? [])));
  const modelProfiles = listAiProfiles().filter(profile => models.has(profile.id)).map(profile => {
    const endpoint = profile.baseUrlSource !== 'environment' && profile.baseUrl ? new URL(profile.baseUrl) : null;
    const baseUrl = endpoint && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash ? endpoint.href : null;
    return { ...Object.fromEntries(profileFields.filter(field => profile[field] !== undefined).map(field => [field, profile[field]])), baseUrl };
  });
  for (const template of definition.resources?.importedModelProfiles ?? []) {
    if (models.has(template.id) && !modelProfiles.some(profile => profile.id === template.id)) modelProfiles.push(template);
  }
  if (definition.resources) delete definition.resources.importedModelProfiles;
  const mcp = mcpConnections().filter(connection => [...tools].some(tool => tool.startsWith(connection.id + '.')))
    .map(({ id, url, tools }) => ({ id, url, tools }));
  const result = { format, definition, modelProfiles, mcp };
  assertPortable(result);
  return result;
}
export function importAgentPackage(value) {
  assertPortable(value);
  if (!value || value.format !== format || Object.keys(value).some(key => !['format', 'definition', 'modelProfiles', 'mcp'].includes(key)) ||
      !Array.isArray(value.mcp) || value.mcp.length > 50 || !Array.isArray(value.modelProfiles) || value.modelProfiles.length > 100) {
    throw new Error('Expected a supported LangVision package.');
  }
  inspectDefinition(value.definition);
  const endpoints = value.mcp.map(item => normalizeMcpConnection(item, true));
  if (new Set(endpoints.map(item => item.id)).size !== endpoints.length) throw new Error('Duplicate MCP connection ID.');
  const aliases = new Map(endpoints.map(item => [item.id, 'import-' + randomUUID().slice(0, 12)]));
  const definition = remapToolNames(value.definition, aliases);
  const profileBindings = new Map();
  for (const item of value.modelProfiles) {
    if (!item || typeof item.id !== 'string' || typeof item.model !== 'string' || profileBindings.has(item.id) ||
        Object.keys(item).some(key => !profileFields.includes(key))) {
      throw new Error('Invalid model profile template.');
    }
    if (item.baseUrl) {
      const url = new URL(item.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid model endpoint template.');
    }
    profileBindings.set(item.id, item);
  }
  const remappedProfiles = new Map();
  const templates = [];
  const profileId = id => {
    if (!id) return id;
    if (!remappedProfiles.has(id)) {
      const local = 'import-profile-' + randomUUID();
      templates.push({ ...(profileBindings.get(id) ?? { model: 'Unspecified' }), id: local });
      remappedProfiles.set(id, local);
    }
    return remappedProfiles.get(id);
  };
  for (const [, graph] of primitiveWorkflows(definition)) {
    if (graph.profileId) graph.profileId = profileId(graph.profileId);
    for (const node of graph.nodes) if (node.settings?.profileId) node.settings.profileId = profileId(node.settings.profileId);
  }
  definition.resources = { ...definition.resources, importedModelProfiles: templates };
  const id = 'agent-' + randomUUID();
  const database = assistantDebugDatabase();
  return database.transaction(() => {
    const connections = endpoints.map(item => ({ ...item, id: aliases.get(item.id), revision: 1 }));
    connections.forEach(persistMcpConnection);
    const draft = saveAssistantWorkflowDraft(id, definition);
    return { id: draft.id, modelProfiles: templates, mcp: connections.map(item => item.id) };
  })();
}
