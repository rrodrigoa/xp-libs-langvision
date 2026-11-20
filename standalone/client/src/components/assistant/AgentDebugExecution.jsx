import { useEffect,useState } from 'react';
import { agentDesignRequest } from './agentDesignApi.js';
import { ActivityIndicator } from '../ActivityIndicator';
import { debugInvocationTree } from '../../../../shared/agentInspection.js';
import { JsonInspector } from './JsonInspector.jsx';

function Invocation({group,selected,onSelect}) {
  const knownParents=new Set(group.attempts.map(node=>node.nodeExecutionId));
  const renderChild=child=><Invocation key={child.id} group={child} selected={selected} onSelect={onSelect}/>;
  return <li data-testid="ai-debug-invocation" data-invocation-id={group.id}><details open><summary><strong>{group.workflowId}</strong> / {group.attempts.length} node attempts</summary><small>Invocation {group.id}{group.parentNodeExecutionId?` / called by ${group.parentNodeExecutionId}`:''}</small><ol>
    {group.attempts.map(node=><li key={node.nodeExecutionId} data-parent-node={node.parentNodeExecutionId??''}>
      <button data-testid="ai-debug-node-attempt" data-node-id={node.nodeId} data-node-execution-id={node.nodeExecutionId} className="ghost-button" aria-pressed={selected?.nodeExecutionId===node.nodeExecutionId} onClick={()=>onSelect(node)}>{node.title} / {node.status}{node.attempt>0?` / attempt ${node.attempt}`:''}{node.outcome?` / ${node.outcome}`:''}</button><small>{node.createdAt}</small>
      {group.children.some(child=>child.parentNodeExecutionId===node.nodeExecutionId)&&<ol>{group.children.filter(child=>child.parentNodeExecutionId===node.nodeExecutionId).map(renderChild)}</ol>}
    </li>)}
    {group.children.filter(child=>!knownParents.has(child.parentNodeExecutionId)).map(renderChild)}
  </ol></details></li>;
}

export function DebugPayload({workspaceId,artifact,initialPath=''}) {
  const [open,setOpen]=useState(false);
  return <details data-testid="ai-debug-payload" onToggle={event=>{if(event.target===event.currentTarget)setOpen(event.currentTarget.open);}}><summary>{artifact.section} / {artifact.bytes.toLocaleString()} bytes</summary>{open&&<JsonInspector workspaceId={workspaceId} artifact={artifact} initialPath={initialPath}/>}</details>;
}

export function AgentDebugExecution({workspaceId,executionId}) {
  const [result,setResult]=useState(null),[after,setAfter]=useState(0),[refresh,setRefresh]=useState(0),[selected,setSelected]=useState(null),[artifacts,setArtifacts]=useState(null),[error,setError]=useState(''),[confirm,setConfirm]=useState(false);
  useEffect(()=>{setResult(null);setAfter(0);setSelected(null);setArtifacts(null);},[workspaceId,executionId]);
  useEffect(()=>{
    const controller=new AbortController();
    agentDesignRequest(`/debug/executions/${encodeURIComponent(executionId)}/nodes?workspaceId=${encodeURIComponent(workspaceId)}&after=${after}`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setResult(current=>({...value,nodes:after?[...(current?.nodes??[]),...value.nodes].slice(-100):value.nodes}));}).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return ()=>controller.abort();
  },[workspaceId,executionId,after,refresh]);
  useEffect(()=>{if(after)return;const timer=setInterval(()=>{if(document.visibilityState!=='hidden')setRefresh(value=>value+1);},5000);return ()=>clearInterval(timer);},[after]);
  useEffect(()=>{
    if(!selected)return;
    const controller=new AbortController();setArtifacts(null);
    agentDesignRequest(`/debug/nodes/${selected.nodeExecutionId}/artifacts?workspaceId=${encodeURIComponent(workspaceId)}`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setArtifacts(value.artifacts);}).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return ()=>controller.abort();
  },[workspaceId,selected]);
  if(error&&!result)return <p role="status">Unable to load execution details: {error}</p>;
  if(!result)return <ActivityIndicator label="Loading execution details"/>;
  if(!result.enabled)return <p className="subtle-copy">Detailed debug values were not captured or raw debug access is disabled. Existing summaries remain available.</p>;
  const invocations=debugInvocationTree(result.nodes);
  return <section className="ai-debug-execution" data-testid="ai-debug-execution">
    <div className="ai-design-dialog-actions"><span>{result.storage?.artifactCount??0} artifacts / {(result.storage?.referencedBytes??0).toLocaleString()} referenced bytes</span><a href={`/api/assistant/debug/executions/${encodeURIComponent(executionId)}/export?workspaceId=${encodeURIComponent(workspaceId)}`} download>Export raw debug data</a><button onClick={()=>setConfirm(true)}>Clear debug payloads</button></div>
    {confirm&&<div role="alert"><p>Permanently clear raw payloads for this execution? Audit summaries remain.</p><button onClick={()=>setConfirm(false)}>Cancel</button><button onClick={async()=>{try{await agentDesignRequest(`/debug/executions/${encodeURIComponent(executionId)}`,{method:'DELETE',body:{workspaceId,confirmExecutionId:executionId}});setArtifacts([]);setConfirm(false);setRefresh(value=>value+1);}catch(error){setError(error.message);}}}>Clear this execution</button></div>}
    <h4>Node attempts and workflow calls</h4><ol className="ai-debug-attempts">{invocations.map(group=><Invocation key={group.id} group={group} selected={selected} onSelect={setSelected}/>)}</ol>
    {result.hasMore&&<button data-testid="ai-debug-next-attempts" onClick={()=>setAfter(result.nextCursor)}>More attempts</button>}{after>0&&<button onClick={()=>setAfter(0)}>First attempts</button>}
    {selected&&<section data-testid="ai-debug-node-detail"><h4>{selected.title} / {selected.nodeExecutionId}</h4><p>Invocation: {selected.invocationId}{selected.parentNodeExecutionId?` / Called by ${selected.parentNodeExecutionId}`:''}</p><p>Captured configuration: <code>{selected.configurationHash}</code></p><p className="subtle-copy">Configuration and inputs below belong to this execution, not the current edited graph.</p>{artifacts===null?<ActivityIndicator label="Loading payload references"/>:artifacts.length?artifacts.map(artifact=><DebugPayload key={artifact.id} artifact={artifact} workspaceId={workspaceId}/>):<p>No detailed payload is available for this attempt.</p>}</section>}
    {error&&<p role="status">{error}</p>}
  </section>;
}
