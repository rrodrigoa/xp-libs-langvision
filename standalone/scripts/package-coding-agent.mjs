import { writeFile } from 'node:fs/promises';
import { codingAgent } from '../shared/codingAgent.js';
import { validatePrimitiveAgent } from '../shared/primitiveAgentModel.js';
import { encodeAgentZip } from '../server/agentZip.js';

const search = process.env.LANGVISION_PACKAGE_RESEARCH_URL;
const mcp = search ? [{ id: 'web-mcp', url: search, tools: ['search', 'fetch'] }] : [];
const definition = search ? codingAgent({ research: ['web-mcp.search', 'web-mcp.fetch'] }) : codingAgent();
const diagnostics = validatePrimitiveAgent(definition);
if (diagnostics.length) throw new Error(diagnostics.join('\n'));
const archive = await encodeAgentZip({ format: 'langvision/agent-package-v1', definition, modelProfiles: [], mcp });
await writeFile(new URL('../../examples/coding-agent/coding-agent.langvision.zip', import.meta.url), archive);
