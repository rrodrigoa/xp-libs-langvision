import { useEffect,useState } from 'react';
import { agentDesignRequest } from './agentDesignApi.js';
import { executionAttempts } from '../../../../shared/agentInspection.js';
import { ActivityIndicator } from '../ActivityIndicator';

function useExecutionPage(path) {
  const [page,setPage]=useState(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  useEffect(()=>{
    if(!path)return;
    const controller=new AbortController();
    agentDesignRequest(path,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted){setPage({path,value});setError('');}}).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return()=>controller.abort();
  },[path,refresh]);
  useEffect(()=>{if(!path)return;const timer=setInterval(()=>{if(document.visibilityState!=='hidden')setRefresh(value=>value+1);},5000);return()=>clearInterval(timer);},[path]);
  return [page?.path===path?page.value:null,error];
}

export function WorkflowExecutionTree({workspaceId,executionId,invocationId,onSelect,selected}) {
  const query=new URLSearchParams({workspaceId});
  const [roots,error]=useExecutionPage(invocationId?null:`/executions/${encodeURIComponent(executionId)}/invocations?${query}`);
  const render=group=><WorkflowInvocation key={group.id} workspaceId={workspaceId} executionId={executionId} group={group} selected={selected} onSelect={onSelect}/>;
  if(invocationId)return <div className="ai-workflow-tree" data-testid="ai-workflow-tree"><ol className="ai-trace-timeline">{render({id:invocationId,name:'Selected workflow call'})}</ol></div>;
  return <div className="ai-workflow-tree" data-testid="ai-workflow-tree">{error&&<p role="status">{error}</p>}{!roots&&!error&&<ActivityIndicator label="Loading execution tree"/>}<ol className="ai-trace-timeline">{roots?.invocations.map(render)}</ol>{roots?.hasMore&&<p>More root calls exist. Select them from the paginated workflow list on the left.</p>}{roots&&!roots.invocations.length&&<p>Invocation identities were not captured in this historical execution. The chronological steps remain available below.</p>}</div>;
}

function WorkflowInvocation({workspaceId,executionId,group,selected,onSelect,ancestors=[]}) {
  const [open,setOpen]=useState(ancestors.length===0),[after,setAfter]=useState(0);
  const base=`/executions/${encodeURIComponent(executionId)}`;
  const query=new URLSearchParams({workspaceId,invocationId:group.id,after:String(after),limit:'100'});
  const [page,error]=useExecutionPage(open?`${base}/events?${query}`:null);
  const [children,childError]=useExecutionPage(open?`${base}/invocations?${new URLSearchParams({workspaceId,parentInvocationId:group.id,limit:'100'})}`:null);
  if(ancestors.includes(group.id))return <li>Invalid cyclic workflow reference.</li>;
  const attempts=executionAttempts(page?.events??[]),known=new Set(attempts.map(item=>item.attemptId));
  const childList=items=><ol>{items.map(child=><WorkflowInvocation key={child.id} workspaceId={workspaceId} executionId={executionId} group={child} ancestors={[...ancestors,group.id]} selected={selected} onSelect={onSelect}/>)}</ol>;
  return <li data-testid="ai-workflow-invocation" data-invocation-id={group.id}><details open={open} onToggle={event=>{if(event.target===event.currentTarget)setOpen(event.currentTarget.open);}}>
    <summary><strong>{group.name}</strong>{group.parentNodeExecutionId?' / called workflow':' / root workflow'}</summary>
    {open&&<><small>Invocation {group.id}{group.parentNodeExecutionId?` / caller ${group.parentNodeExecutionId}`:''}</small>
      {(error||childError)&&<p role="status">{error||childError}</p>}{!page&&!error&&<ActivityIndicator label="Loading node attempts"/>}
      <ol>{attempts.map(item=><li key={item.attemptId} data-testid="ai-trace-event" data-node-id={item.metadata.nodeId} data-attempt-id={item.attemptId}>
        <button className="ghost-button" data-testid="ai-debug-node-attempt" data-node-id={item.metadata.nodeId} data-node-execution-id={item.attemptId} aria-pressed={selected===item.attemptId} onClick={()=>onSelect(item,attempts)}>{item.title} / {item.status}</button>
        <small>{item.startedAt}{item.metadata.objectiveId?` / objective ${item.metadata.objectiveId}`:''}</small>
        {childList((children?.invocations??[]).filter(child=>child.parentNodeExecutionId===item.attemptId))}
        {item.metadata.transition&&<p data-testid="ai-trace-transition"><code>{item.metadata.nodeId}</code> → <strong>{item.metadata.transition}</strong> → <code>{item.metadata.nextNodeId??'End'}</code></p>}
      </li>)}</ol>
      {childList((children?.invocations??[]).filter(child=>!known.has(child.parentNodeExecutionId)))}
      {children?.hasMore&&<p>Additional nested calls are available in the workflow-call list.</p>}
      <div className="ai-design-dialog-actions">{after>0&&<button onClick={()=>setAfter(0)}>First attempts</button>}{page?.hasMore&&<button data-testid="ai-workflow-next-attempts" onClick={()=>setAfter(page.nextCursor)}>Next attempts</button>}</div>
    </>}
  </details></li>;
}
