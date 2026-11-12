import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator } from '../ActivityIndicator';
import { agentDesignRequest } from './agentDesignApi.js';
import { executionAttempts,attemptHandoffs } from '../../../../shared/agentInspection.js';
import { DebugPayload } from './AgentDebugExecution.jsx';
import { WorkflowExecutionTree } from './WorkflowExecutionTree.jsx';
import { JsonInspector } from './JsonInspector.jsx';
import { AgentExecutionGraph,workflowKey } from './AgentExecutionGraph.jsx';
import { AgentWaterfall } from './AgentWaterfall.jsx';

function ExecutionStorage({workspaceId,executionId,refresh,onClear}) {
  const [storage,setStorage]=useState(null),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();
    agentDesignRequest(`/debug/executions/${encodeURIComponent(executionId)}/storage?workspaceId=${encodeURIComponent(workspaceId)}`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setStorage(value);}).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return()=>controller.abort();
  },[workspaceId,executionId,refresh]);
  if(!storage?.enabled)return null;
  return <section className="ai-execution-storage"><p role="note">Sensitive execution data: complete requests, credentials, payloads and provider-returned thinking are retained locally until explicitly cleared. Protect this database and any exports.</p><div className="ai-json-actions"><span>{storage.artifactCount} artifacts / {Number(storage.referencedBytes).toLocaleString()} referenced bytes</span><a href={`/api/assistant/debug/executions/${encodeURIComponent(executionId)}/export?workspaceId=${encodeURIComponent(workspaceId)}`} download>Export execution data</a><button disabled={busy} onClick={()=>setConfirm(true)}>Clear execution payloads</button></div>
    {confirm&&<div role="group" aria-label="Confirm clear execution payloads"><p>Delete captured payloads for this execution? Timeline and pinned definition remain; deleted values cannot be recovered.</p><button disabled={busy} onClick={()=>setConfirm(false)}>Cancel</button><button disabled={busy} onClick={async()=>{setBusy(true);try{await agentDesignRequest(`/debug/executions/${encodeURIComponent(executionId)}`,{method:'DELETE',body:{workspaceId,confirmExecutionId:executionId}});setConfirm(false);onClear();}catch(error){setError(error.message);}finally{setBusy(false);}}}>Clear payloads</button></div>}{error&&<p role="status">{error}</p>}
  </section>;
}

function AttemptInspector({workspaceId,executionId,attempt,attempts,tools,onSelectTool,onSelectAttempt,traceRefresh}) {
  const [references,setReferences]=useState(null),[error,setError]=useState('');
  const [inspection,setInspection]=useState(null),[refresh,setRefresh]=useState(0);
  const [comparison,setComparison]=useState(null);
  const navigation=useRef(null);
  useEffect(()=>()=>navigation.current?.abort(),[]);
  useEffect(()=>{
    const controller=new AbortController();
    agentDesignRequest(`/executions/${encodeURIComponent(executionId)}/attempts/${encodeURIComponent(attempt.attemptId)}?workspaceId=${encodeURIComponent(workspaceId)}`,{signal:controller.signal})
      .then(value=>{if(!controller.signal.aborted){setInspection(value);if(value.attempt.status!==attempt.status)onSelectAttempt(value.attempt,attempts.map(item=>item.attemptId===value.attempt.attemptId?value.attempt:item));}}).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return()=>controller.abort();
  },[workspaceId,executionId,attempt.attemptId,attempt.status,refresh]);
  useEffect(()=>{
    if(attempt.status!=='started'||inspection&&inspection.attempt.status!=='started')return;
    const timer=setInterval(()=>setRefresh(value=>value+1),5000);return()=>clearInterval(timer);
  },[attempt.status,inspection?.attempt.status]);
  async function jump(id) {
    navigation.current?.abort();const controller=new AbortController();navigation.current=controller;
    try {const value=await agentDesignRequest(`/executions/${encodeURIComponent(executionId)}/attempts/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`,{signal:controller.signal});if(!controller.signal.aborted)onSelectAttempt(value.attempt,attempts);}
    catch(error){if(!controller.signal.aborted)setError(error.message);}
  }
  useEffect(()=>{
    const controller=new AbortController();setError('');
    agentDesignRequest(`/debug/nodes/${attempt.attemptId}/artifacts?workspaceId=${encodeURIComponent(workspaceId)}`,{signal:controller.signal})
      .then(value=>{if(!controller.signal.aborted)setReferences(value);})
      .catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return ()=>controller.abort();
  },[workspaceId,attempt.attemptId,attempt.status,traceRefresh]);
  const data=inspection?.attempt.metadata??attempt.metadata, ids=new Set((data.producedOutputs?.toolResults??[]).map(tool=>tool.id));
  const sections={Inputs:data.resolvedInputs??data.input,Bindings:data.bindings,Outputs:data.producedOutputs??data.output,'State changes':data.stateChanges,
    Transition:{edgeId:data.edgeId,branch:data.transition,destination:data.nextNodeId},'Error / Recovery':Object.hasOwn(data,'failure')?data.failure:data.error??data.producedOutputs?.failure};
  const artifactSections={Inputs:['resolved-bindings','resolved-inputs','inputs'],Bindings:['binding-provenance'],Outputs:['outputs'],'State changes':['state-changes'],Transition:['decision'],'Error / Recovery':['error-recovery']};
  const claimed=new Set();
  return <section data-testid="ai-debug-node-detail" className="ai-attempt-inspector">
    <h4>{attempt.title}</h4><p>{data.subgraph??'Conversation'} / {data.nodeId} / {attempt.attemptId}</p>
    <p>Pinned configuration: <code>{data.configurationHash??data.instructionHash??'Not captured'}</code></p>
    <p className="subtle-copy">These values belong to this attempt, not the current edited graph.</p>
    <details open data-testid="ai-node-handoffs"><summary>Context handoffs</summary>{(inspection?.handoffs??attemptHandoffs(attempt,attempts)).map(item=><div key={item.input}><code>{item.input}</code> ← <code>{item.binding.path??'constant'}</code><span> / {item.origin}{item.valueState?` / ${item.valueState}`:''}</span>{item.producerId&&<button className="ghost-button" onClick={()=>void jump(item.producerId)}>From {item.producerLabel}</button>}{item.callerNodeExecutionId&&<button className="ghost-button" onClick={()=>void jump(item.callerNodeExecutionId)}>Open workflow caller</button>}</div>)}{!Object.keys(data.bindings?.inputs??{}).length&&<p>No explicit input bindings were captured. Inspect complete captured payloads for legacy shared state; no handoff is inferred.</p>}</details>
    {(inspection?.handoffs??[]).filter(item=>item.valueReference).map(item=><DebugPayload key={`value-${item.input}`} workspaceId={workspaceId} artifact={{...item.valueReference.artifact,section:`Input value / ${item.input}`}} initialPath={item.valueReference.path}/>)}
    <details data-testid="ai-output-consumers"><summary>Downstream consumers ({inspection?.consumers?.length??0})</summary>{inspection?.consumers?.map(item=><p key={`${item.id}:${item.input}`}><code>{item.source}</code> → <button onClick={()=>void jump(item.id)}>{item.title} / {item.input}</button></p>)}{inspection?.hasMoreConsumers&&<p>First 100 consumers shown. Continue through the invocation timeline for additional consumers.</p>}{!inspection?.consumers?.length&&<p>No later mapped consumer has been recorded for these outputs in this invocation.</p>}</details>
    <label>Compare earlier attempt<select value={comparison?.id??''} onChange={event=>{
      const id=event.target.value;setComparison(id?{id,artifacts:null}:null);if(!id)return;
      navigation.current?.abort();const controller=new AbortController();navigation.current=controller;
      agentDesignRequest(`/debug/nodes/${encodeURIComponent(id)}/artifacts?workspaceId=${encodeURIComponent(workspaceId)}`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setComparison({id,artifacts:value.artifacts});}).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    }}><option value="">Select a previous attempt</option>{attempts.filter(item=>item.metadata.nodeId===data.nodeId&&item.metadata.invocationId===data.invocationId&&item.firstSequence<attempt.firstSequence).map(item=><option key={item.attemptId} value={item.attemptId}>{item.startedAt} / {item.status}</option>)}</select></label>
    {comparison&&<section><h4>Earlier attempt / {comparison.id}</h4>{comparison.artifacts===null?<ActivityIndicator label="Loading comparison"/>:comparison.artifacts.filter(item=>['resolved-bindings','outputs','decision','error-recovery'].includes(item.section)).map(artifact=><DebugPayload key={artifact.id} workspaceId={workspaceId} artifact={artifact}/>)}</section>}
    {Object.entries(sections).map(([title,value])=>{
      const artifact=artifactSections[title].map(section=>references?.artifacts?.find(item=>item.section===section)).find(Boolean);
      if(artifact){claimed.add(artifact.id);return <DebugPayload key={title} workspaceId={workspaceId} artifact={{...artifact,section:title}}/>;}
      return <details key={title}><summary>{title} / {value===undefined?'not captured':'recorded metadata'}</summary>{value===undefined?<p>Not captured for this historical attempt.</p>:<JsonInspector value={value}/>}</details>;
    })}
    {tools.filter(tool=>ids.has(tool.id)||tool.nodeExecutionId===data.nodeExecutionId).map(tool=><button key={tool.id} className="ghost-button" onClick={()=>onSelectTool({actionId:tool.id})}>{tool.name} / {tool.status}</button>)}
    <h4>Complete captured payloads</h4>
    {references===null&&!error?<ActivityIndicator label="Loading payload references"/>:null}
    {references?.enabled?<>{references.artifacts.filter(artifact=>!claimed.has(artifact.id)).map(artifact=><DebugPayload key={artifact.id} workspaceId={workspaceId} artifact={artifact}/>)}</>:references?<p>Full payloads were not captured, are disabled, or have been cleared. No missing values are inferred.</p>:null}
    {error&&<p role="status">{error}</p>}
  </section>;
}

export function AgentExecutionTrace({workspaceId,actionId,onSelectTool=()=>{},invocationId,editorMode=false,onClone,initialSelection}) {
  const [trace,setTrace]=useState(null),[after,setAfter]=useState(0),[selected,setSelected]=useState(null),[refresh,setRefresh]=useState(0),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const [graphView,setGraphView]=useState('assistant'),[edge,setEdge]=useState(null);
  const [artifactRevision,setArtifactRevision]=useState(0);
  useEffect(()=>{setTrace(null);setAfter(0);setSelected(null);},[workspaceId,actionId]);
  useEffect(()=>{if(!initialSelection?.attemptId)setGraphView(trace?.execution?.executionKind==='query-translation'?'queryTranslation':'assistant');},[trace?.executionId]);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');
    agentDesignRequest(`/audit/${encodeURIComponent(actionId)}/trace?workspaceId=${encodeURIComponent(workspaceId)}&after=${after}`,{signal:controller.signal})
      .then(value=>{if(!controller.signal.aborted)setTrace(current=>({...value,actionId,events:after&&current?.actionId===actionId?[...new Map([...current.events,...value.events].map(event=>[event.id,event])).values()].slice(-240):value.events}));})
      .catch(error=>{if(!controller.signal.aborted)setError(error.message);})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[workspaceId,actionId,after,refresh]);
  useEffect(()=>{if(['completed','failed','canceled','blocked','needs-attention','answered'].includes(trace?.execution?.status??trace?.status))return;const timer=setInterval(()=>{if(document.visibilityState!=='hidden')setRefresh(value=>value+1);},5000);return ()=>clearInterval(timer);},[trace?.execution?.status,trace?.status]);
  useEffect(()=>{
    if(!initialSelection?.attemptId)return;
    const controller=new AbortController();
    agentDesignRequest(`/executions/${encodeURIComponent(actionId)}/attempts/${encodeURIComponent(initialSelection.attemptId)}?workspaceId=${encodeURIComponent(workspaceId)}`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted){setSelected({attempt:value.attempt,attempts:[value.attempt]});setGraphView(workflowKey(value.attempt.metadata.subgraph));}}).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return()=>controller.abort();
  },[workspaceId,actionId,initialSelection?.attemptId]);
  const visible=trace?.actionId===actionId?trace:null;
  if(!visible)return error?<p role="status">{error}</p>:<ActivityIndicator label="Loading execution"/>;
  const attempts=executionAttempts(visible.events),attempt=selected?.attempt??null;
  const selectAttempt=(item,items)=>{setSelected({attempt:item,attempts:items});setGraphView(workflowKey(item.metadata.subgraph??item.metadata.workflowId));setEdge(null);};
  return <section className="ai-execution-trace" data-testid="ai-execution-trace" data-execution-id={visible.executionId}>
    <h4>Turn execution {loading&&<ActivityIndicator label="Updating execution"/>}</h4>
    <p>{visible.workflow?`${visible.workflow.definition.name} / v${visible.workflow.version}`:'Pinned definition unavailable'} / {visible.execution?.status??visible.status}</p>
    <ExecutionStorage workspaceId={workspaceId} executionId={visible.executionId??actionId} refresh={refresh} onClear={()=>{setArtifactRevision(value=>value+1);setRefresh(value=>value+1);}}/>
    {visible.workflow&&<>
      {!editorMode?<button className="ghost-button" data-testid="ai-open-execution-editor" onClick={()=>window.dispatchEvent(new CustomEvent('consilium-inspect-execution',{detail:{actionId:visible.executionId??actionId,attemptId:attempt?.attemptId}}))}>Open in Agent Editor</button>:<button className="ghost-button" data-testid="ai-clone-execution" onClick={()=>onClone?.(visible.workflow,attempt)}>Clone pinned revision and edit</button>}
      <AgentExecutionGraph bundle={visible.workflow.definition} attempt={attempt} attempts={[...new Map([...attempts,...(selected?.attempts??[])].map(item=>[item.attemptId,item])).values()]} onSelect={selectAttempt} view={graphView} onView={next=>{setGraphView(next);setSelected(null);setEdge(null);}} onEdge={setEdge}/>
      {edge&&<details open data-testid="ai-edge-inspection"><summary>Transition {edge.edge.source} → {edge.edge.target}</summary><JsonInspector value={edge.edge}/>{edge.attempts.map(item=><button key={item.attemptId} onClick={()=>selectAttempt(item,attempts)}>Inspect executed handoff / {item.startedAt}</button>)}{!edge.attempts.length&&<p>No matching attempt is loaded. Browse the workflow execution tree to load its invocation.</p>}</details>}
    </>}
    <AgentWaterfall workspaceId={workspaceId} executionId={visible.executionId??actionId} status={visible.execution?.status??visible.status} revision={artifactRevision} selectedAttemptId={attempt?.attemptId} onSelectAttempt={id=>{
      const loaded=attempts.find(item=>item.attemptId===id);if(loaded){selectAttempt(loaded,attempts);return;}
      agentDesignRequest(`/executions/${encodeURIComponent(visible.executionId??actionId)}/attempts/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`).then(value=>selectAttempt(value.attempt,attempts)).catch(error=>setError(error.message));
    }}/>
    <details><summary>User input and assistant output ({visible.messages.length})</summary>{visible.messages.map(message=><section key={message.id} data-testid="ai-trace-message"><strong>{message.role}</strong><pre>{message.content}</pre></section>)}</details>
    <details open><summary>Extracted objectives ({visible.tasks.length})</summary><ol>{visible.tasks.map(task=><li key={task.id}>{task.title} / <strong>{task.status}</strong></li>)}</ol><details><summary>Objective state / JSON</summary><div data-testid="ai-extracted-objectives"><JsonInspector value={visible.tasks.map(task=>({id:task.id,action:task.title,status:task.status,dependencies:task.dependencies,successCriteria:task.successCriteria}))}/></div></details></details>
    <div data-testid="ai-debug-execution"><h4>Actual steps, in execution order</h4>
      <WorkflowExecutionTree workspaceId={workspaceId} executionId={visible.executionId??actionId} invocationId={invocationId} selected={attempt?.attemptId} onSelect={selectAttempt}/>
      <details><summary>Chronological page / legacy attempts</summary><ol className="ai-trace-timeline" data-testid="ai-execution-attempts">{attempts.map((item,index)=><li key={item.attemptId} data-node-id={item.metadata.nodeId} data-attempt-id={item.attemptId}>
        <button className="ghost-button" data-testid="ai-chronological-attempt" data-node-id={item.metadata.nodeId} data-node-execution-id={item.attemptId} aria-pressed={attempt?.attemptId===item.attemptId} onClick={()=>selectAttempt(item,attempts)}>{index+1}. {item.title} / {item.status}</button>
        <small>{item.metadata.subgraph??'Conversation'}{item.metadata.objectiveId?` / objective ${item.metadata.objectiveId}`:''} / {item.startedAt}</small>
        {item.metadata.transition&&<p data-testid="ai-trace-transition"><code>{item.metadata.nodeId}</code> → <strong>{item.metadata.transition}</strong> → <code>{item.metadata.nextNodeId??'End'}</code></p>}
      </li>)}</ol></details>
      {attempt&&<AttemptInspector key={`${attempt.attemptId}:${artifactRevision}`} workspaceId={workspaceId} executionId={visible.executionId??actionId} attempt={attempt} attempts={selected.attempts} tools={visible.tools} onSelectTool={onSelectTool} onSelectAttempt={selectAttempt} traceRefresh={refresh}/>}
    </div>
    <div className="ai-design-dialog-actions">{after>0&&<button onClick={()=>{setSelected(null);setAfter(0);}}>First steps</button>}{visible.hasMore&&<button data-testid="ai-trace-next" disabled={loading} onClick={()=>setAfter(visible.nextCursor)}>More steps</button>}</div>
    {error&&<p role="status">{error}</p>}
  </section>;
}
