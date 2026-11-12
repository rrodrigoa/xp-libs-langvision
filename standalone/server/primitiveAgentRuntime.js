import { Annotation, StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import { executeNativePrimitive, nativeHumanResult } from './primitiveNativeExecution.js';
import { validateAgentSchema } from '../shared/agentJsonSchema.js';
import { executePrimitiveData, primitiveActions, primitiveWorkflows, readPrimitivePath, resolvePrimitiveBinding, validatePrimitiveAgent } from '../shared/primitiveAgentModel.js';

const PrimitiveState = Annotation.Root({
  entry: Annotation(), payload: Annotation(), variables: Annotation(), result: Annotation(),
  steps: Annotation(), route: Annotation(), failure: Annotation(), identity: Annotation(), invocationId: Annotation(), native: Annotation()
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Adapters implement transport, persistence and authorization, never agent decisions.
export function compilePrimitiveAgent(definition, adapters, { checkpointer, workflowId = 'assistant', depth = 0 } = {}) {
  const errors = validatePrimitiveAgent(definition);
  if (errors.length) throw new Error(errors.join('\n'));
  if (depth > 8) throw new Error('Workflow invocation depth exceeds 8. Use visible edges for loops.');
  const workflow = primitiveWorkflows(definition).find(([id]) => id === workflowId)?.[1];
  if (!workflow) throw new Error(`Workflow '${workflowId}' does not exist.`);
  const graph = new StateGraph(PrimitiveState);
  const runtimeId = id => `operation__${id}`;
  for (const node of workflow.nodes) {
    graph.addNode(runtimeId(node.id), async (savedState, config) => {
      const state = { ...savedState, invocationId: savedState.invocationId ?? randomUUID() };
      config.signal?.throwIfAborted();
      const steps = (state.steps ?? 0) + 1;
      const execute = async () => {
        if (steps > workflow.maxSteps) throw new Error(`Workflow '${workflow.name}' exceeded its saved ${workflow.maxSteps}-step budget at '${node.label}'.`);
        let input, result, route, native = state.native;
        try {
          input = resolvePrimitiveBinding(node.settings.input, state);
          const s = node.settings;
          const nativeOutput = node.operationVersion === 2 ? await executeNativePrimitive({ node, workflow, definition, state, config, input, adapters }) : null;
          if (nativeOutput) ({ result, route, native } = nativeOutput);
          else if (node.handler === 'start') result = input;
          else if (node.handler === 'data') result = executePrimitiveData(s.operations, input);
          else if (node.handler === 'llm') {
            if (!adapters.model) throw new Error('No model adapter is configured.');
            const actions = primitiveActions(workflow, node.id);
            const request = { systemPrompt: s.systemPrompt, input, responseSchema: s.responseSchema,
              profileId: s.profileId ?? workflow.profileId ?? definition.profileId, toolNames: [...s.toolNames],
              ...(s.actionPath ? { availableActions: actions } : {}) };
            result = await adapters.model(request, { node, workflow, state, config });
            const schemaErrors = validateAgentSchema(s.responseSchema, result);
            if (schemaErrors.length) throw new Error(`Invalid model output: ${schemaErrors.join('; ')}`);
            if (s.actionPath) route = readPrimitivePath(result, s.actionPath);
          } else if (node.handler === 'tool') {
            const requests = readPrimitivePath(input, s.requestsPath);
            if (!Array.isArray(requests) || requests.length > 32) throw new Error('Tool requests must be an array of at most 32 items.');
            const seen = new Set();
            for (const request of requests) {
              if (!request || typeof request.id !== 'string' || !request.id.trim() || seen.has(request.id) || !s.toolNames.includes(request.name) || !object(request.arguments)) throw new Error('Tool request needs a unique ID, an explicitly available name and object arguments.');
              seen.add(request.id);
            }
            const method = s.mode === 'prepare' ? adapters.prepareTools : adapters.executeTools;
            if (!method) throw new Error(`No ${s.mode} tool adapter is configured.`);
            result = await method(requests, { node, workflow, state, config, input });
          } else if (node.handler === 'human') {
            if (!adapters.prepareHuman || !adapters.resolveHuman) throw new Error('Persistent human interaction adapter is required.');
            const pending = await adapters.prepareHuman(input, { node, workflow, state, config });
            const response = interrupt(pending);
            result = await adapters.resolveHuman(pending, response, { node, workflow, state, config });
            if (node.operationVersion === 2 && state.native) {
              native = nativeHumanResult(state.native, result, node);
              const kind = node.settings.kind === 'approval' && result.approved ? 'approval' : 'result';
              route = workflow.edges.find(edge => edge.source === node.id && edge.kind === kind)?.id;
            }
          } else if (node.handler === 'workflow') {
            const child = compilePrimitiveAgent(definition, adapters, { workflowId: s.workflowRef, depth: depth + 1 });
            const output = await child.invoke({ entry: input, variables: {}, steps: 0, identity: state.identity, invocationId: `${state.invocationId}/${node.id}/${steps}` }, { ...config, recursionLimit: definition[s.workflowRef].maxSteps + 5 });
            result = output.result;
            if (s.returnEvidence) {
              const observations = output.native?.observations ?? [];
              native = structuredClone(native ?? { sessions: {}, observations: [], pending: [], diagnostics: [] });
              for (const observation of observations) {
                const prior = native.observations.find(item => item.requestId === observation.requestId);
                if (prior && JSON.stringify(prior) !== JSON.stringify(observation)) throw new Error('Child evidence reused an identity with different values.');
                if (!prior) native.observations.push(observation);
              }
              result = { value: result, observations };
            }
          } else if (node.handler === 'end') {
            if (s.mode === 'publish') {
              const response = readPrimitivePath(input, s.responsePath);
              if (typeof response !== 'string' || !response.trim()) throw new Error('A publishing End needs a nonempty bound response.');
              if (!adapters.publish) throw new Error('No final-answer persistence adapter is configured.');
              await adapters.publish(response, { node, workflow, state, config, input });
            }
            return { result: input, payload: input, steps, route: END, failure: null };
          } else throw new Error(`Unsupported primitive '${node.handler}'.`);
          config.signal?.throwIfAborted();
          if (result === undefined) throw new Error('Node returned undefined instead of JSON.');
          JSON.stringify(result);
          const variables = { ...state.variables };
          for (const [name, binding] of Object.entries(s.outputs ?? {})) variables[name] = resolvePrimitiveBinding(binding, { ...state, result });
          let payload = result;
          if (s.outputMode === 'merge-input') {
            if (!object(input) || !object(result)) throw new Error('merge-input requires object input and output.');
            payload = { ...input, ...result };
          }
          if (!route && s.actionPath) route = readPrimitivePath(result, s.actionPath);
          const outgoing = primitiveActions(workflow, node.id);
          if (route !== undefined && !outgoing.some(edge => edge.id === route)) throw new Error(`Unknown action '${route}' from '${node.label}'.`);
          if (route === undefined) {
            if (outgoing.length !== 1) throw new Error(`Node '${node.label}' must select an exact outgoing action ID.`);
            route = outgoing[0].id;
          }
          return { payload, variables, route, steps, failure: null, ...(native ? { native } : {}) };
        } catch (error) {
          // LangGraph interrupts are control flow, not an agent error edge.
          if (error.name === 'GraphInterrupt' || error.name === 'NodeInterrupt') throw error;
          config.signal?.throwIfAborted();
          if (error.primitiveBudgetExhausted) throw error;
          const edge = workflow.edges.find(edge => edge.source === node.id && edge.kind === 'error');
          if (!edge) throw error;
          const failure = { nodeId: node.id, operation: node.handler, message: error.message, input: input ?? null, output: error.modelResponse ?? result ?? null };
          native = error.nativeState ?? native;
          if (native) {
            native = structuredClone(native);
            native.diagnostics.push(failure);
            const session = native.sessions?.[node.id] ?? native.sessions?.[native.origin];
            if (session) session.transcript.push({ role: 'user', content: JSON.stringify({ executionError: failure.message, instruction: 'Use this concrete failure to choose a different action or a saved blocked exit.' }) });
          }
          // Keep full inputs in the attempt artifact, not recursively inside the next input.
          const { input: failedInput, ...feedback } = failure;
          return { payload: { ...(node.settings.errorOutputMode === 'merge-input' && object(input) ? input : {}), error: feedback }, failure, route: edge.id, steps, ...(native ? { native } : {}) };
        }
      };
      const output = adapters.trace ? await adapters.trace({ node, workflow, workflowId, state, config }, execute) : await execute();
      return { ...output, invocationId: state.invocationId };
    });
    if (node.handler === 'end') graph.addEdge(runtimeId(node.id), END);
    else graph.addConditionalEdges(runtimeId(node.id), state => state.route, Object.fromEntries(workflow.edges.filter(edge => edge.source === node.id).map(edge => [edge.id, runtimeId(edge.target)])));
  }
  graph.addEdge(START, runtimeId(workflow.nodes.find(node => node.handler === 'start').id));
  return graph.compile({ ...(checkpointer ? { checkpointer } : {}) });
}
