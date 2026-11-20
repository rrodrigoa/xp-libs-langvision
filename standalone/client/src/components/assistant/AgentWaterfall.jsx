import { useEffect,useState } from 'react';
import { agentDesignRequest } from './agentDesignApi.js';
import { ActivityIndicator } from '../ActivityIndicator';
import { JsonInspector } from './JsonInspector.jsx';
import { modelPresentation,spanDuration,waterfallRows,terminalSpan,parseJsonText,waterfallDurationLabel as durationLabel } from '../../../../shared/agentWaterfall.js';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const sectionLabel=section=>({'native-tool-input':'Arguments','native-tool-result':'Result','tool-input':'Arguments','tool-result':'Result','tool-preparation':'Prepared actions','resolved-inputs':'Received context',outputs:'Produced state',decision:'Selected transition','human-decision':'Human decision','error-recovery':'Error / recovery'}[section]??section);
function MessageContent({content}) {
  const parsed=typeof content==='string'?parseJsonText(content):{value:content};
  return parsed.error?<pre>{content}</pre>:<JsonInspector value={parsed.value}/>;
}
function SpanContent({workspaceId,span}) {
  const [artifacts,setArtifacts]=useState(null),[error,setError]=useState('');
  useEffect(()=>{
    if(span.kind==='workflow'){setArtifacts([]);return;}
    const controller=new AbortController();setArtifacts(null);setError('');
    (async()=>{
      const refs=await agentDesignRequest(`/debug/nodes/${encodeURIComponent(span.attemptId)}/artifacts?workspaceId=${encodeURIComponent(workspaceId)}`,{signal:controller.signal});
      const sections=span.kind==='model'?['model-request','model-response','model-error']:span.kind==='tool'||span.kind==='skill'?['native-tool-input','native-tool-result','tool-input','tool-result']:['resolved-inputs','outputs','decision','human-decision','tool-preparation','error-recovery'];
      const values=await Promise.all(refs.artifacts.filter(item=>sections.includes(item.section)).map(async artifact=>({section:artifact.section,artifact,...await agentDesignRequest(`/debug/artifacts/${artifact.id}/value?workspaceId=${encodeURIComponent(workspaceId)}&editor=true`,{signal:controller.signal})})));
      if(!controller.signal.aborted)setArtifacts(values);
    })().catch(error=>{if(!controller.signal.aborted)setError(error.message);});return()=>controller.abort();
  },[workspaceId,span.id,span.status]);
  if(error)return <p role="status">{error}</p>;
  if(!artifacts)return <ActivityIndicator label="Loading span details"/>;
  if(!terminalSpan(span.status))return <p>Content is available after this call finishes. Its timer remains visible above.</p>;
  if(span.kind==='model') {
    const model=modelPresentation(artifacts,span.metadata.callId);
    return <section className="ai-model-readable" data-testid="ai-model-readable">
      <h4>Model request</h4><p>{span.name} / thinking {span.metadata.thinkingMode} / context {span.metadata.context??'not captured'}</p><p className="subtle-copy">Pinned digest: <code>{span.metadata.digest??'Not captured'}</code></p>
      {model.request?.messages?.map((message,index)=><details key={index}><summary>{index+1}. {message.role}{message.tool_name?` / ${message.tool_name}`:''}</summary><MessageContent content={message.content}/>{message.tool_calls&&<JsonInspector value={message.tool_calls}/>}</details>)}
      <details><summary>Available tools ({model.request?.tools?.length??0})</summary><JsonInspector value={model.request?.tools??[]}/></details>
      <h4>Model thinking</h4><details data-testid="ai-provider-thinking" open={Boolean(model.thinking)}><summary>{model.thinkingState}{model.thinking?` / ${model.thinking.length.toLocaleString()} characters`:''}</summary><pre>{model.thinking||'No provider-returned thinking text is available for this call. Unreturned internal reasoning cannot be displayed.'}</pre></details>
      <h4>Model response</h4><div data-testid="ai-model-response" data-response-kind={model.responseKind}>
        {model.content&&<MessageContent content={model.content}/>}
        {model.resultText&&<section data-testid="ai-model-returned-answer"><p className="subtle-copy">Returned in finish_step.result.answerMarkdown, not message.content.</p><ReactMarkdown remarkPlugins={[remarkGfm]}>{model.resultText}</ReactMarkdown></section>}
        {model.toolCalls.length>0&&<section data-testid="ai-model-native-response"><p>{model.finishStep?`Selected exit: ${model.finishStep.exit}`:'This call requested tools. Its results are recorded in the following Tool node.'}</p>{model.toolCalls.filter(call=>call.function?.name!=='finish_step').map((call,index)=><details key={call.id??index} open><summary>Tool request: {call.function?.name}</summary><p>Call ID: <code>{call.id??'Not returned by provider'}</code></p><JsonInspector value={typeof call.function?.arguments==='string'?parseJsonText(call.function.arguments).value??call.function.arguments:call.function?.arguments}/></details>)}</section>}
        {!model.content&&!model.toolCalls.length&&<p>{model.responseKind==='unavailable'?'Response payload is unavailable. Inspect the capture status and original artifacts below.':'The provider returned no response text or native calls.'}</p>}
      </div>
      {model.error&&<p role="alert">{model.error}</p>}
      {model.finishStep&&<section data-testid="ai-model-step-result"><h4>Result / exit {model.finishStep.exit}</h4>{!model.resultText&&<JsonInspector value={model.finishStep.result}/>}<p>{model.finishStep.summary}</p><details><summary>Evidence references</summary><JsonInspector value={model.finishStep.evidenceReferences??[]}/></details></section>}
      {!!model.toolCalls.length&&<><h4>Tool calls / selected exit</h4><JsonInspector value={model.toolCalls}/></>}
      {model.usage&&<details><summary>Provider-reported usage and timing</summary><JsonInspector value={model.usage}/></details>}
      {!model.request&&<p>Readable model payload was not captured or exceeds automatic loading size. Open the complete artifact below.</p>}
      <details><summary>Original captured payloads</summary>{artifacts.map(item=><details key={item.artifact.id}><summary>{item.section}</summary><JsonInspector workspaceId={workspaceId} artifact={item.artifact}/></details>)}</details>
    </section>;
  }
  if(span.kind==='workflow')return <p>Workflow invocation {span.invocationId}. Expand its rows to inspect actual node attempts and model calls.</p>;
  const matching=artifacts.filter(item=>!span.metadata.toolCallId||item.value?.requestId===span.metadata.toolCallId);
  return <section>{matching.length?matching.map(item=><details key={item.artifact.id} open><summary>{sectionLabel(item.section)}</summary><JsonInspector workspaceId={workspaceId} artifact={item.artifact}/></details>):<p>Detailed payloads were not captured for this span. Inspect its node attempt for available historical evidence.</p>}</section>;
}
export function AgentWaterfall({workspaceId,executionId,status,onSelectAttempt,selectedAttemptId,revision=0}) {
  const [spans,setSpans]=useState([]),[after,setAfter]=useState(0),[page,setPage]=useState(null),[refresh,setRefresh]=useState(0),[selected,setSelected]=useState(null),[error,setError]=useState(''),[collapsed,setCollapsed]=useState(new Set()),[now,setNow]=useState(Date.now());
  useEffect(()=>{setSpans([]);setAfter(0);setSelected(null);setPage(null);},[executionId,workspaceId]);
  useEffect(()=>{
    const controller=new AbortController();
    agentDesignRequest(`/executions/${encodeURIComponent(executionId)}/spans?workspaceId=${encodeURIComponent(workspaceId)}&after=${after}`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted){setSpans(value.spans);setPage(value);setError('');}}).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return()=>controller.abort();
  },[workspaceId,executionId,after,refresh,revision]);
  useEffect(()=>{if(terminalSpan(status))return;const timer=setInterval(()=>{setNow(Date.now());if(document.visibilityState!=='hidden')setRefresh(value=>value+1);},2000);return()=>clearInterval(timer);},[status,after]);
  const rows=waterfallRows(spans),start=Math.min(...spans.map(span=>Date.parse(span.startedAt))),end=Math.max(...spans.map(span=>span.endedAt?Date.parse(span.endedAt):terminalSpan(span.status)?Date.parse(span.startedAt):now)),width=Math.max(1,end-start);
  const hidden=new Set();for(const row of rows)if(collapsed.has(row.parentId)||hidden.has(row.parentId))hidden.add(row.id);
  const activeModel = spans.findLast(span => span.kind === 'model' && !span.endedAt && !terminalSpan(span.status));
  const activeNode = activeModel && spans.find(span => span.id === activeModel.attemptId);
  return <details open className="ai-waterfall" data-testid="ai-execution-waterfall"><summary>Execution waterfall <span>{page?.total??0} spans</span></summary>
    {activeModel && <p className="subtle-copy" data-testid="ai-waterfall-active-model"><ActivityIndicator label="Waiting for model"/> {activeModel.metadata.nodeLabel ?? activeNode?.name ?? 'Model node'} · {activeModel.name} · {durationLabel(spanDuration(activeModel, now))} elapsed</p>}
    <div className="ai-waterfall-scale"><span>0s</span><span>{durationLabel(spans.length?width/2:null)}</span><span>{durationLabel(spans.length?width:null)}</span></div>
    <div className="ai-waterfall-rows">{rows.filter(row=>!hidden.has(row.id)).map(row=><div key={row.id} className="ai-waterfall-row" data-status={row.status} data-kind={row.kind} data-span-id={row.id}>
      <div className="ai-waterfall-name" style={{paddingLeft:Math.min(row.depth,8)*12}}>{rows.some(child=>child.parentId===row.id)&&<button aria-label={`${collapsed.has(row.id)?'Expand':'Collapse'} ${row.name}`} onClick={()=>setCollapsed(current=>{const next=new Set(current);next.has(row.id)?next.delete(row.id):next.add(row.id);return next;})}>{collapsed.has(row.id)?'▸':'▾'}</button>}<button aria-pressed={selected?.id===row.id||selectedAttemptId===row.id} onClick={()=>{setSelected(row);if(row.attemptId)onSelectAttempt(row.attemptId);}}><small>{row.kind}</small> {row.name}</button></div>
      <div className="ai-waterfall-track" aria-label={`${row.name}: ${durationLabel(spanDuration(row,now))}`}><i style={{left:`${Math.max(0,(Date.parse(row.startedAt)-start)/width*100)}%`,width:`${Math.min(100,Math.max(.7,(spanDuration(row,now)??0)/width*100))}%`}}/></div><span>{!terminalSpan(row.status)&&<ActivityIndicator label={row.status}/>} {durationLabel(spanDuration(row,now))}</span>
    </div>)}</div>
    <p className="subtle-copy">Spans {spans.length?after+1:0}–{after+spans.length} of {page?.total??0}. Workflow bars summarize the loaded page; open the invocation tree for its full hierarchy.</p>
    {after>0&&<button className="ghost-button" onClick={()=>setAfter(Math.max(0,after-100))}>Previous spans</button>}{page?.hasMore&&<button className="ghost-button" onClick={()=>setAfter(page.nextCursor)}>More spans</button>}<button className="ghost-button" onClick={()=>setRefresh(value=>value+1)}>Refresh waterfall</button>
    {error&&<p role="status">{error}</p>}{selected&&<section className="ai-waterfall-detail"><h4>{selected.name} / {selected.kind}{selected.metadata.reused?' / persisted result; not replayed':''}</h4><SpanContent key={`${selected.id}:${revision}`} workspaceId={workspaceId} span={spans.find(span=>span.id===selected.id)??selected}/></section>}
  </details>;
}
