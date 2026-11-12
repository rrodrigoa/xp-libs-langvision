export const terminalSpan = status => !['started','running','awaiting-user','awaiting-approval','awaiting-clarification'].includes(status);
export function waterfallDurationLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'Timing unavailable';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000), pad = value => String(value).padStart(2, '0');
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}m`;
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}h`;
}
export function spanDuration(span, now = Date.now()) {
  if(['start-unavailable','end-unavailable'].includes(span.metadata?.timing))return null;
  const start=Date.parse(span.startedAt),end=span.endedAt?Date.parse(span.endedAt):terminalSpan(span.status)?start:now;
  return Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,end-start):null;
}
export function waterfallRows(spans) {
  const groups=new Map();
  for(const span of spans.filter(span=>span.kind==='node'&&span.invocationId)) {
    const id=`invocation:${span.invocationId}`,old=groups.get(id);
    groups.set(id,{id,kind:'workflow',name:span.metadata.workflowName??span.invocationId,parentId:old?.parentId??span.parentId,startedAt:old&&old.startedAt<span.startedAt?old.startedAt:span.startedAt,endedAt:old?.endedAt&&span.endedAt?old.endedAt>span.endedAt?old.endedAt:span.endedAt:span.endedAt,status:old&&!terminalSpan(old.status)?old.status:span.status,metadata:{},invocationId:span.invocationId});
  }
  spans=[...groups.values(),...spans.map(span=>span.kind==='node'&&span.invocationId?{...span,parentId:spans.some(parent=>parent.id===span.parentId&&parent.invocationId===span.invocationId)?span.parentId:`invocation:${span.invocationId}`}:span)];
  const byId=new Map(spans.map(span=>[span.id,span]));
  const result=[],visited=new Set();
  function visit(span,depth) {
    if(visited.has(span.id))return;visited.add(span.id);result.push({...span,depth});
    spans.filter(child=>child.parentId===span.id).forEach(child=>visit(child,depth+1));
  }
  spans.filter(span=>!byId.has(span.parentId)).forEach(span=>visit(span,0));
  spans.forEach(span=>visit(span,0));return result;
}
export function parseJsonText(text) {
  try {return {value:JSON.parse(text)};} catch(error) {return {error:error.message};}
}
export function modelPresentation(artifacts, callId) {
  const request=artifacts.find(item=>item.section==='model-request'&&item.value?.callId===callId)?.value;
  const captured=artifacts.find(item=>item.section==='model-response'&&item.value?.callId===callId)?.value;
  const envelope=typeof captured?.body==='string'?parseJsonText(captured.body).value:captured?.body;
  const raw=envelope?.debugPayload?.responseJson??envelope?.DebugPayload?.ResponseJson;
  const provider=typeof raw==='string'?parseJsonText(raw).value:envelope;
  const wire=provider?.response??provider;
  const message=wire?.choices?.[0]?.message??wire?.message??{};
  const original=message.content??'';
  const blocks=typeof original==='string'?[...original.matchAll(/<think>([\s\S]*?)<\/think>/gi)]:[];
  const thinking=message.thinking||message.reasoning_content||message.reasoning||blocks.map(block=>block[1]).join('\n');
  const mode=request?.body?.thinkingMode??(request?.body?.think?'on':'off');
  const returnedCalls=envelope?.message?.toolCalls??envelope?.message?.tool_calls??message.tool_calls??message.toolCalls??[];
  const toolCalls=Array.isArray(returnedCalls)?returnedCalls:[];
  const finish=toolCalls.find(call=>call.function?.name==='finish_step')?.function?.arguments;
  const finishStep=typeof finish==='string'?parseJsonText(finish).value:finish;
  return {request:request?.body,response:provider,thinking,thinkingState:thinking?'Provider-returned thinking':!captured?'Not captured historically':mode==='off'?'Thinking disabled':'Not returned by provider',
    responseKind:finishStep?'finish-step':toolCalls.length?'tool-calls':original?'text':captured?'empty':'unavailable',
    resultText:typeof finishStep?.result?.answerMarkdown==='string'?finishStep.result.answerMarkdown:null,
    content:typeof original==='string'?original.replace(/<think>[\s\S]*?<\/think>/gi,'').trim():original,
    toolCalls,finishStep,error:provider?.error??artifacts.find(item=>item.section==='model-error'&&item.value?.callId===callId)?.value?.message,usage:provider?{promptTokens:wire?.usage?.prompt_tokens??provider.prompt_eval_count??provider.promptEvalCount,outputTokens:wire?.usage?.completion_tokens??provider.eval_count??provider.evalCount,totalDurationNs:envelope?.totalDuration??provider.total_duration??provider.totalDuration,loadDurationNs:provider.load_duration??provider.loadDuration}:null};
}
