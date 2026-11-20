export function applyAgentCanvasChanges(nodes, changes) {
  let result=nodes;
  for(const change of changes) {
    if(change.type==='remove'&&result.some(node=>node.id===change.id))result=result.filter(node=>node.id!==change.id);
    if(change.type==='position'&&change.position&&result.some(node=>node.id===change.id&&(node.position?.x!==change.position.x||node.position?.y!==change.position.y)))
      result=result.map(node=>node.id===change.id?{...node,position:{...change.position}}:node);
  }
  return result;
}

export function primitiveWorkflowUsage(definition, key) {
  const graph=key==='assistant'?definition:definition[key];
  const callers=[['assistant',definition],...['queryTranslation','executionWorkflow','synthesisWorkflow'].map(id=>[id,definition[id]])]
    .flatMap(([id,workflow])=>(workflow?.nodes??[]).filter(node=>node.handler==='workflow'&&node.settings.workflowRef===key).map(node=>({workflowId:id,nodeId:node.id,label:node.label})));
  const entry=key==='assistant'?'Consilium chat':key==='queryTranslation'?'Optional query translation API':callers.length?'Explicit workflow invocation':'Not called by this agent';
  return {entry,callers,unused:key!=='assistant'&&key!=='queryTranslation'&&!callers.length,
    tools:[...new Set((graph?.nodes??[]).flatMap(node=>node.settings.toolNames??[]))],
    resultFields:[...new Set((graph?.edges??[]).flatMap(edge=>Object.keys(edge.resultSchema?.properties??{})))],
    modelNodes:(graph?.nodes??[]).filter(node=>node.handler==='llm').length};
}
