import { validateAgentSchema } from './agentJsonSchema.js';
import { executePrimitiveData, readPrimitivePath } from './primitiveAgentModel.js';

export const FINISH_STEP = 'finish_step';
export const nativeExits = (workflow, node) => workflow.edges.filter(edge => edge.source === node.id && !['error', 'tools', 'approval', 'result'].includes(edge.kind));
export function nativeFinishTool(workflow, node) {
  const exits = nativeExits(workflow, node);
  return { type: 'function', function: { name: FINISH_STEP,
    description: `Finish this step by choosing an existing graph exit. ${exits.map(edge => `${edge.id}: ${edge.name}. ${edge.description ?? ''}`).join('\n')}`,
    parameters: { type: 'object', additionalProperties: false, required: ['exit', 'result', 'evidenceReferences', 'summary'], properties: {
      exit: { type: 'string', enum: exits.map(edge => edge.id), description: 'Exact saved exit ID; you cannot create or rename exits.' },
      result: { type: 'object', description: 'Generated result for the next node. Follow the selected exit result contract.' },
      evidenceReferences: { type: 'array', items: { type: 'string' }, description: 'Actual tool-observation IDs, or explicitly allowed received input/context paths. The user question is not evidence of product facts. Failed observations establish failures, not successful actions. Never invent references.' },
      summary: { type: 'string', description: 'Concise decision summary, not private chain-of-thought.' }
    } } } };
}
export function nativeModelMessages(request) {
  const context = { input: request.input, ...(request.context === undefined ? {} : { context: request.context }),
    ...(request.inputSchema ? { inputContract: request.inputSchema } : {}),
    exits: nativeExits(request.workflow, request.node).map(edge => ({ id: edge.id, name: edge.name, description: edge.description ?? '', resultSchema: edge.resultSchema ?? request.responseSchema ?? null, evidencePolicy: edge.evidencePolicy ?? 'optional', contextEvidencePaths: edge.contextEvidencePaths ?? null, evidenceChecks: edge.evidenceChecks ?? [] })) };
  return [{ role: 'system', content: [request.purpose, request.systemPrompt, request.node?.settings?.progressInstructions, request.node?.settings?.historyInstructions, request.node?.settings?.authoringInstructions, request.protocolInstructions ?? request.node?.settings?.protocolInstructions].filter(Boolean).join('\n\n') },
    ...(request.node?.settings?.researchInstructions ? [{role:'system',content:request.node.settings.researchInstructions}] : []),
    ...(request.node?.settings?.toolContractInstructions ? [{role:'system',content:request.node.settings.toolContractInstructions}] : []), { role: 'user', content: JSON.stringify(context) }, ...(request.transcript ?? [])];
}
export function validateNativeFinish(call, workflow, node, observations, received = {}) {
  const args = call.arguments;
  const errors = validateAgentSchema(nativeFinishTool(workflow, node).function.parameters, args);
  if (errors.length) throw new Error(errors.join('; '));
  const edge = nativeExits(workflow, node).find(edge => edge.id === args.exit);
  if (!edge) throw new Error(`Unknown saved exit '${args.exit}'.`);
  const schema = edge.resultSchema ?? node.settings.responseSchema;
  if (schema) { const errors = validateAgentSchema(schema, args.result); if (errors.length) throw new Error(`Exit result: ${errors.join('; ')}`); }
  const known = new Set((observations ?? []).flatMap(item => [item.requestId, item.toolCallId].filter(Boolean)));
  for (const reference of args.evidenceReferences) if (/^(input|context)(\.|$)/.test(reference)) {
    if (Array.isArray(edge.contextEvidencePaths) && !edge.contextEvidencePaths.some(path => reference === path || reference.startsWith(path + '.'))) continue;
    try { if (readPrimitivePath(received, reference) !== undefined) known.add(reference); } catch { /* Missing context is not evidence. */ }
  }
  const missing = args.evidenceReferences.filter(id => !known.has(id));
  if (missing.length) throw new Error(`Completion references unknown evidence: ${JSON.stringify(missing)}. Actual observations: ${JSON.stringify((observations ?? []).map(item => ({ requestId: item.requestId, toolCallId: item.toolCallId, name: item.name, success: item.success })))}.`);
  if (edge.evidencePolicy === 'required' && (!args.evidenceReferences.length || !args.evidenceReferences.some(id => (observations ?? []).some(item => item.name !== 'agent.report_progress' && [item.requestId, item.toolCallId].includes(id)) || /^(input|context)(\.|$)/.test(id)))) throw new Error('This exit requires authoritative evidence, not a progress report or the user question. Inspect the relevant live state before finishing.');
  for (const contract of edge.evidenceChecks ?? []) {
    if (contract.whenObserved && !(observations ?? []).some(item => item.success && item.name === contract.whenObserved)) continue;
    const after = contract.afterTool ? (observations ?? []).findLastIndex(item => item.success && item.name === contract.afterTool) : -1;
    const observation = (observations ?? []).filter((item, index) => index > after && item.success && item.name === contract.toolName && args.evidenceReferences.includes(item.requestId)).at(-1);
    if (!observation) throw new Error(`Exit '${edge.name}' needs referenced evidence from '${contract.toolName}'.`);
    const reference = contract.referenceTool ? (observations??[]).findLast(item=>item.success&&item.name===contract.referenceTool) : undefined;
    const assertion = executePrimitiveData([{ op: 'assert', checks: contract.checks }], { observation, reference, generated: args.result });
    if (!assertion.assertions.passed) throw new Error(`Exit evidence checks failed: ${JSON.stringify(assertion.assertions.facts.filter(fact => !fact.passed))}`);
  }
  return edge;
}
