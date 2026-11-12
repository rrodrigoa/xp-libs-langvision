import { starterPrimitiveAgent } from './primitiveAgentStarter.js';
import { primitiveWorkflows } from './primitiveAgentModel.js';

// Migration may recognize the shipped v1 topology, never infer custom orchestration.
const protocolText = text => text?.replace(/Available registered tool contracts: [\s\S]*?\nKnowledge/, 'Available registered tool contracts: <registry>\nKnowledge').replace(/Available contracts: [\s\S]*$/, 'Available contracts: <registry>');
const settings = node => ({ ...node.settings, ...(typeof node.settings.systemPrompt === 'string' ? { systemPrompt: protocolText(node.settings.systemPrompt) } : {}) });
export function migratePrimitiveNative(source, tools) {
  if (source?.schemaVersion !== 5) throw new Error('Migrate the existing primitive definition, not another agent type.');
  if (source.nodes.some(node => node.operationVersion === 2)) throw new Error('This definition already contains native operations; edit its existing nodes directly.');
  const previouslyAvailable = new Set(primitiveWorkflows(source).flatMap(([, graph]) => graph.nodes.flatMap(node => node.settings.toolNames ?? [])));
  const baseline = starterPrimitiveAgent(source.name, { tools: tools.filter(tool => previouslyAvailable.has(tool.name)), skills: source.resources?.skills ?? [], operationVersion: 1 });
  const conflicts = [];
  for (const [key, graph] of primitiveWorkflows(source)) {
    const expected = key === 'assistant' ? baseline : baseline[key];
    if (!expected || JSON.stringify(graph.edges) !== JSON.stringify(expected.edges)) conflicts.push(`${key}: custom links require an explicit native-graph edit.`);
    for (const node of graph.nodes) {
      const prior = expected?.nodes.find(item => item.id === node.id && item.handler === node.handler);
      if (!prior || JSON.stringify(settings(node)) !== JSON.stringify(settings(prior))) conflicts.push(`${key}/${node.id}: preserve and adapt custom instructions, bindings or behavior before replacing this stage.`);
    }
    if (graph.nodes.length !== expected?.nodes.length) conflicts.push(`${key}: custom node set cannot be collapsed automatically.`);
  }
  const report = { protocolVersion: 2, compatible: conflicts.length === 0, conflicts, automaticActivation: false,
    retained: ['Same agent ID', 'Pinned historical revisions', 'Skills and references', 'Model profiles', 'Custom labels and descriptions on retained boundaries'],
    changes: ['One reasoning call per attempt', 'Explicit native Tool/back-edge', 'Exact Human approval without a model Boolean router', 'Saved exits generate finish_step', 'No mandatory extraction/review loop'] };
  if (conflicts.length) return { report, definition: null };
  const definition = starterPrimitiveAgent(source.name, { tools: tools.filter(tool => previouslyAvailable.has(tool.name)), skills: source.resources?.skills ?? [], operationVersion: 2 });
  definition.resources = structuredClone(source.resources ?? { skills: [] });
  definition.profileId = source.profileId ?? null;
  for (const [key, graph] of primitiveWorkflows(definition)) {
    const old = key === 'assistant' ? source : source[key];
    if (!old) continue;
    graph.name = old.name;
    if (Object.hasOwn(old, 'profileId')) graph.profileId = old.profileId;
    graph.maxSteps = old.maxSteps;
    for (const node of graph.nodes) {
      const retained = old.nodes.find(item => item.id === node.id && item.handler === node.handler);
      if (retained) { node.label = retained.label; node.description = retained.description; node.position = structuredClone(retained.position); }
    }
  }
  definition.migration = { ...report, sourceDefinition: structuredClone(source) };
  return { report, definition };
}
