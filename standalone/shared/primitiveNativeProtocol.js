import { validateAgentSchema } from './agentJsonSchema.js';
import { executePrimitiveData, readPrimitivePath } from './primitiveAgentModel.js';

export const FINISH_STEP = 'finish_step';
export const nativeExits = (workflow, node) => workflow.edges.filter(edge => edge.source === node.id && !['error', 'tools', 'approval', 'result'].includes(edge.kind));
export function availableNativeExits(workflow, node, bindings) {
  return nativeExits(workflow, node).filter(edge => {
    if (!bindings || !edge.availableWhen) return true;
    let found = false;
    try { found = readPrimitivePath(bindings, edge.availableWhen.path) != null; } catch { /* The path is absent. */ }
    return found === (edge.availableWhen.operator === 'present');
  });
}
export function nativeFinishTool(workflow, node, bindings) {
  const exits = availableNativeExits(workflow, node, bindings);
  if (!exits.length) return null;
  return { type: 'function', function: { name: FINISH_STEP,
    description: `Finish this step by choosing an existing graph exit. ${exits.map(edge => `${edge.id}: ${edge.name}. ${edge.description ?? ''}`).join('\n')}`,
    parameters: { type: 'object', additionalProperties: false, required: ['exit', 'result', 'evidenceReferences'], properties: {
      exit: { type: 'string', enum: exits.map(edge => edge.id), description: 'Exact saved exit ID; you cannot create or rename exits.' },
      result: { type: 'object', description: 'Generated result for the next node. Follow the selected exit result contract.' },
      evidenceReferences: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: {
        requestId: { type: 'string' }, toolCallId: { type: 'string' }, name: { type: 'string' }, tool: { type: 'string' },
      }, additionalProperties: false }] }, description: 'Exact successful observation IDs; copy requestId from availableExitEvidence. A reference object with the same recorded requestId or toolCallId is also accepted. Use only these IDs or an allowed context path.' },
      summary: { type: 'string', description: 'Optional concise decision summary, not private chain-of-thought.' }
    } } } };
}
export function nativeModelMessages(request) {
  const context = { input: request.input, ...(request.context === undefined ? {} : { context: request.context }),
    ...(request.exitEvidence?.length ? { availableExitEvidence: request.exitEvidence } : {}),
    ...(request.skillDiscovery ? { skills: request.skillDiscovery } : {}),
    ...(request.codeChanges ? { codeChangeSnapshot: request.codeChanges, currentCodeChange: request.codeChanges.find(change => change.status === 'active') ?? null } : {}),
    ...(request.progress ? { currentChecklist: request.progress.tasks } : {}),
    ...(request.latestObservation ? { latestSuccessfulToolResult: request.latestObservation } : {}),
    ...(request.inputSchema ? { inputContract: request.inputSchema } : {}),
    exits: availableNativeExits(request.workflow, request.node, request).map(edge => ({ id: edge.id, name: edge.name, description: edge.description ?? '', resultSchema: edge.resultSchema ?? request.responseSchema ?? null, evidencePolicy: edge.evidencePolicy ?? 'optional', contextEvidencePaths: edge.contextEvidencePaths ?? null, evidenceChecks: edge.evidenceChecks ?? [], ...(edge.evidenceAlternatives ? { evidenceAlternatives: edge.evidenceAlternatives } : {}) })) };
  const settings = request.node?.settings;
  return [{ role: 'system', content: [request.purpose, request.systemPrompt, settings?.progressInstructions, settings?.historyInstructions, settings?.authoringInstructions,
    request.protocolInstructions ?? settings?.protocolInstructions, settings?.researchInstructions, settings?.toolContractInstructions,
    ...(request.instructionSkills ?? []).map(skill => `Skill: ${skill.title}\n${skill.body}`)].filter(Boolean).join('\n\n') },
  { role: 'user', content: JSON.stringify(context) }, ...(request.transcript ?? [])];
}
export function validateNativeFinish(call, workflow, node, observations, received = {}) {
  const supplied = call.arguments;
  const finish = nativeFinishTool(workflow, node, received);
  if (!finish) throw new Error('No saved exit is available for the current bindings.');
  const errors = validateAgentSchema(finish.function.parameters, supplied);
  if (errors.length) throw new Error(errors.join('; '));
  const args = { ...supplied, evidenceReferences: supplied.evidenceReferences.map(reference => {
    if (typeof reference === 'string') return reference;
    const match = (observations ?? []).find(item => (!reference.requestId || item.requestId === reference.requestId) &&
      (!reference.toolCallId || item.toolCallId === reference.toolCallId) &&
      (!reference.name || item.name === reference.name) && (!reference.tool || item.name === reference.tool));
    if (!match || !(reference.requestId || reference.toolCallId)) throw new Error('Evidence reference does not match a recorded tool observation.');
    return reference.requestId || reference.toolCallId;
  }) };
  const edge = availableNativeExits(workflow, node, received).find(edge => edge.id === args.exit);
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
  if (edge.evidencePolicy === 'required' && (!args.evidenceReferences.length || !args.evidenceReferences.some(id => (observations ?? []).some(item => item.success && !['agent.report_progress', 'agent.report_status'].includes(item.name) && [item.requestId, item.toolCallId].includes(id)) || /^(input|context)(\.|$)/.test(id)))) throw new Error('This exit requires authoritative evidence, not a progress report or the user question. Inspect the relevant live state before finishing.');
  const checkContracts = contracts => { for (const contract of contracts) {
    if (contract.whenObserved && !(observations ?? []).some(item => item.success && item.name === contract.whenObserved)) continue;
    const after = contract.afterTool ? (observations ?? []).findLastIndex(item => item.success && item.name === contract.afterTool) : -1;
    const eligible = (observations ?? []).filter((item, index) => index > after && item.success && item.name === contract.toolName);
    const observation = eligible.findLast(item => args.evidenceReferences.includes(item.requestId) || args.evidenceReferences.includes(item.toolCallId));
    if (!observation) throw new Error(`Exit '${edge.name}' needs referenced evidence from '${contract.toolName}'. Eligible request IDs: ${JSON.stringify(eligible.map(item => item.requestId))}.`);
    const reference = contract.referenceTool ? (observations??[]).findLast(item=>item.success&&item.name===contract.referenceTool) : undefined;
    const assertion = executePrimitiveData([{ op: 'assert', checks: contract.checks }], { observation, reference, generated: args.result });
    if (!assertion.assertions.passed) throw new Error(`Exit evidence checks failed: ${JSON.stringify(assertion.assertions.facts.filter(fact => !fact.passed))}`);
  } };
  checkContracts(edge.evidenceChecks ?? []);
  if (edge.evidenceAlternatives?.length) {
    const failures = [];
    for (const alternative of edge.evidenceAlternatives) {
      try { checkContracts(alternative.checks); return edge; }
      catch (error) { failures.push(`${alternative.label}: ${error.message}`); }
    }
    throw new Error(`Exit '${edge.name}' requires one verified evidence path. Cite exact request IDs for either: ${failures.join(' | ')}`);
  }
  return edge;
}
