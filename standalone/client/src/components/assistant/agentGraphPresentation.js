
export function agentWorkflowCallTarget(node) {
  return node.handler === 'workflow' ? node.settings?.workflowRef ?? null : null;
}

export function agentWorkflowCallers(definition, workflowId) {
  const graphs = [['assistant', definition], ...['queryTranslation', 'executionWorkflow', 'synthesisWorkflow'].map(key => [key, definition?.[key]])];
  return graphs.flatMap(([key, graph]) => (graph?.nodes ?? []).filter(node => agentWorkflowCallTarget(node) === workflowId)
    .map(node => ({ workflowId: key, nodeId: node.id, label: node.label, workflowName: graph.name })));
}

export function agentWorkflowEntryPoint(workflowId) {
  return workflowId === 'assistant' ? 'Consilium chat: a user message or a resumed approval / clarification.'
    : workflowId === 'queryTranslation' ? 'Query translation API. This is a separate product entry point, not a conversation step.' : null;
}

export const AGENT_GRAPH_ROLES = {
  boundary: { label: 'Start / end', color: 'var(--ai-graph-boundary)', description: 'Entry and exit of this workflow.' },
  model: { label: 'Model', color: 'var(--ai-graph-model)', description: 'Planning, generation or evaluation using a model.' },
  tool: { label: 'Tool access', color: 'var(--ai-graph-tool)', description: 'Tool availability, authoritative reads or execution. Approval follows the saved policy.' },
  human: { label: 'User decision', color: 'var(--ai-graph-human)', description: 'A user may need to approve, reject or answer before continuing.' },
  decision: { label: 'Control / verification', color: 'var(--ai-graph-decision)', description: 'Routes or verifies execution state without granting permissions.' },
  knowledge: { label: 'Context', color: 'var(--ai-graph-knowledge)', description: 'Instructions, skills and contextual grounding.' }
};

const human = new Set(['approval_gate', 'clarification', 'human']);
const tool = new Set(['tools', 'action', 'execute_tools', 'query_schemas', 'query_lint', 'query_compile']);
const knowledge = new Set(['guidance', 'skills', 'context_evidence', 'query_context', 'execute_context']);

export function agentNodeRole(node) {
  if (['__start__', '__end__'].includes(node.id)) return 'boundary';
  const primitive = { start: 'boundary', end: 'boundary', llm: 'model', tool: 'tool', data: 'decision', human: 'human', workflow: 'decision' }[node.handler];
  if (primitive) return primitive;
  return 'decision';
}

export function agentNodeCanRequestTools(node) {
  return ['action', 'execute_generate'].includes(node.handler) || node.handler === 'llm' && Boolean(node.settings?.toolNames?.length);
}

export function editableAgentEdge(definition, id) {
  const edge = definition.edges.find(edge => edge.id === id);
  return edge ? structuredClone(edge) : null;
}

// A feedback edge points to an ancestor in the stable entry-rooted traversal.
// Do not color every edge in a strongly connected component, or a retry makes the whole graph orange.
export function agentLoopEdgeIds(definition) {
  const ids = new Set(['__start__', '__end__', ...(definition?.nodes ?? []).map(node => node.id)]);
  const priority = new Map(['always', 'ready', 'act', 'done', 'verified', 'clarify', 'pending', 'waiting', 'blocked'].map((value, index) => [value, index]));
  const outgoing = new Map();
  for (const edge of definition?.edges ?? []) if (ids.has(edge.source) && ids.has(edge.target)) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    outgoing.get(edge.source).push(edge);
  }
  for (const edges of outgoing.values()) edges.sort((a, b) => (priority.get(a.condition) ?? 99) - (priority.get(b.condition) ?? 99) || a.target.localeCompare(b.target) || a.id.localeCompare(b.id));
  const visited = new Set(), ancestors = new Set(), loops = new Set();
  const visit = id => {
    visited.add(id); ancestors.add(id);
    for (const edge of outgoing.get(id) ?? []) {
      if (ancestors.has(edge.target)) loops.add(edge.id);
      else if (!visited.has(edge.target)) visit(edge.target);
    }
    ancestors.delete(id);
  };
  visit(definition?.schemaVersion === 5 ? definition.nodes.find(node => node.handler === 'start')?.id ?? '__start__' : '__start__');
  for (const id of [...ids].sort()) if (!visited.has(id)) visit(id);
  return loops;
}

export function presentAgentEdges(definition, { selectedId, traversed = new Set() } = {}) {
  const loops = agentLoopEdgeIds(definition);
  const nodes = new Map((definition?.nodes ?? []).map(node => [node.id, node]));
  return (definition?.edges ?? []).map(edge => {
    const source = nodes.get(edge.source);
    const role = loops.has(edge.id) ? 'loop' : human.has(source?.handler) ? 'human' : source?.handler === 'llm' || definition.schemaVersion === 5 && source?.settings?.actionPath ? 'decision' : 'forward';
    const color = `var(--ai-graph-${role})`;
    const branch = definition.schemaVersion === 5 ? edge.id : edge.condition;
    const visited = traversed.has(`${edge.source}|${branch}|${edge.target}`);
    const label = definition.schemaVersion === 5 ? `${role === 'loop' ? 'Loop / ' : ''}${edge.name}` : `${role === 'loop' ? 'Loop' : ''}${role === 'loop' && edge.condition !== 'always' ? ' / ' : ''}${edge.condition === 'always' ? '' : edge.condition}`;
    return { ...edge, type: 'default', selected: edge.id === selectedId, animated: false,
      className: `ai-graph-edge is-${role}${visited ? ' is-traversed' : ''}`,
      label, ariaLabel: `${role === 'loop' ? 'Loop' : role === 'human' ? 'User decision' : 'Transition'}: ${edge.source} to ${edge.target}, ${branch}${visited ? ', executed on this page' : ''}`,
      data: { ...edge.data, role, loop: role === 'loop', visited },
      markerEnd: { type: 'arrowclosed', color },
      style: { stroke: color, strokeWidth: edge.id === selectedId ? 3.5 : visited ? 3 : 1.8, ...(role === 'loop' ? { strokeDasharray: '7 5' } : {}) },
      labelStyle: { fill: color, fontSize: 11, fontWeight: role === 'loop' ? 600 : 400 },
      labelBgStyle: { fill: 'var(--site-color-panel)', fillOpacity: 1 }, labelBgPadding: [6, 3], labelBgBorderRadius: 4 };
  });
}
