export function inspectNodeValue(value, depth = 0) {
  if (depth > 4) return '[bounded]';
  if (typeof value === 'string') return value.replace(/(SharedAccessKey|Password|ApiKey|Bearer)(\s*[=: ]\s*)[^;\s"']+/gi, '$1$2[redacted]').slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 16).map(item => inspectNodeValue(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 32).map(([key, item]) => [key, /password|secret|connectionString|token|apiKey|thinking|reasoning/i.test(key) ? '[redacted]' : inspectNodeValue(item, depth + 1)]));
  return value;
}

export function traceEventsForWorkflow(events, purpose = 'conversation') {
  return events.filter(event => {
    if (!event.metadata?.nodeId) return false;
    const owner = event.metadata.subgraph
      ?? (event.kind === 'agent-debug-node' ? event.metadata.workflowId : null)
      ?? (event.kind?.startsWith('query-translation') ? 'query-translation' : 'conversation');
    return owner === purpose;
  });
}

export function debugInvocationTree(events) {
  const groups = new Map();
  for (const event of events) {
    if (!groups.has(event.invocationId)) groups.set(event.invocationId, {
      id: event.invocationId, workflowId: event.workflowId, parentInvocationId: event.parentInvocationId,
      parentNodeExecutionId: event.parentNodeExecutionId, attempts: new Map(), children: []
    });
    groups.get(event.invocationId).attempts.set(event.nodeExecutionId, event);
  }
  const roots = [];
  for (const group of groups.values()) {
    const visited = new Set([group.id]);
    let parent = groups.get(group.parentInvocationId), cursor = parent;
    while (cursor) {
      if (visited.has(cursor.id)) { parent = null; break; }
      visited.add(cursor.id); cursor = groups.get(cursor.parentInvocationId);
    }
    if (parent) parent.children.push(group); else roots.push(group);
    group.attempts = [...group.attempts.values()];
  }
  return roots;
}

export function executionAttempts(events) {
  const attempts = new Map();
  for (const event of events) {
    if (!event.metadata?.nodeId) continue;
    const id = event.metadata.stageExecutionId ?? event.id;
    const prior = attempts.get(id);
    attempts.set(id, { ...event, attemptId:id, firstSequence:prior?.firstSequence??event.sequence,
      startedAt:prior?.startedAt??event.createdAt, metadata:{...prior?.metadata,...event.metadata} });
  }
  return [...attempts.values()].sort((a,b)=>a.firstSequence-b.firstSequence);
}

export function executionInvocationTree(events) {
  return debugInvocationTree(executionAttempts(events).map(attempt=>({...attempt,
    invocationId:attempt.metadata.invocationId??'historical-unlinked',
    workflowId:attempt.metadata.workflowName??attempt.metadata.subgraph??'Conversation',
    parentInvocationId:attempt.metadata.parentInvocationId,
    parentNodeExecutionId:attempt.metadata.parentNodeExecutionId,nodeExecutionId:attempt.attemptId})));
}

export function attemptHandoffs(attempt,attempts) {
  const earlier=attempts.filter(item=>item.firstSequence<attempt.firstSequence&&item.metadata.invocationId===attempt.metadata.invocationId&&item.status==='completed');
  return Object.entries(attempt.metadata.bindings?.inputs??{}).map(([input,binding])=>{
    const path=binding.path;
    const producer=path?[...earlier].reverse().find(item=>Object.values(item.metadata.bindings?.outputs??{}).some(output=>typeof output==='string'&&(path===output||path.startsWith(output+'.')))):null;
    return {input,binding,origin:!path?'constant':producer?'node-output':'workflow-input / producer not present on this page',producerId:producer?.attemptId,producerLabel:producer?.title};
  });
}
