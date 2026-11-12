import { randomUUID } from 'node:crypto';
import { assistantDebugDatabase } from './assistantStore.js';
import { gunzipSync } from 'node:zlib';

const initialized = new WeakSet();
function db() {
  const database = assistantDebugDatabase();
  if (!initialized.has(database)) {
    database.exec(`CREATE TABLE IF NOT EXISTS ai_execution_spans (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, execution_id TEXT NOT NULL,
      invocation_id TEXT, attempt_id TEXT, parent_id TEXT, kind TEXT NOT NULL,
      name TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL,
      metadata_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ix_ai_spans_execution ON ai_execution_spans(workspace_id,execution_id,started_at,id);`);
    initialized.add(database);
  }
  return database;
}
export function beginExecutionSpan(identity, kind, name, metadata = {}, id = randomUUID(), parentId = identity?.nodeExecutionId) {
  if (!identity?.workspaceId || !identity.executionId) return null;
  db().prepare('INSERT INTO ai_execution_spans VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,identity.workspaceId,identity.executionId,identity.invocationId??null,identity.nodeExecutionId??null,parentId===id?identity.parentNodeExecutionId??null:parentId??null,kind,name??'Model call',new Date().toISOString(),null,kind==='human'?'awaiting-user':'started',JSON.stringify(metadata));
  return id;
}
export function endExecutionSpan(id, status = 'completed', metadata = {}) {
  if (!id) return;
  db().prepare(`UPDATE ai_execution_spans SET ended_at=?,status=?,metadata_json=json_patch(metadata_json,?) WHERE id=? AND status IN ('started','awaiting-user')`).run(new Date().toISOString(),status,JSON.stringify(metadata),id);
}
export function cancelExecutionSpans(executionId) {
  db().prepare("UPDATE ai_execution_spans SET status='canceled',ended_at=COALESCE(ended_at,?) WHERE execution_id=? AND status IN ('started','awaiting-user')").run(new Date().toISOString(),executionId);
}
function recoverRecordedModelSpans(database,workspaceId,executionId) {
  if(!database.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_debug_paths'").get())return;
  const refs=database.prepare("SELECT * FROM ai_debug_references WHERE workspace_id=? AND execution_id=? AND section IN ('model-request','model-response','model-error') ORDER BY rowid").all(workspaceId,executionId);
  const field=(reference,path)=>{
    const item=database.prepare('SELECT start,length FROM ai_debug_paths WHERE hash=? AND path=?').get(reference.hash,path);
    if(!item||item.length>1024)return undefined;
    const first=Math.floor(item.start/32768),last=Math.floor((item.start+item.length-1)/32768);
    const bytes=Buffer.concat(database.prepare('SELECT payload FROM ai_debug_chunks WHERE hash=? AND part BETWEEN ? AND ? ORDER BY part').all(reference.hash,first,last).map(row=>gunzipSync(row.payload)));
    return JSON.parse(bytes.subarray(item.start-first*32768,item.start-first*32768+item.length).toString('utf8'));
  };
  const outcomes=new Map(refs.filter(ref=>ref.section!=='model-request').map(ref=>[field(ref,'/callId'),ref]));
  const exists=database.prepare('SELECT 1 FROM ai_execution_spans WHERE id=?');
  const insert=database.prepare('INSERT OR IGNORE INTO ai_execution_spans VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  database.transaction(()=>{for(const ref of refs.filter(ref=>ref.section==='model-request')) {
    const callId=field(ref,'/callId');if(!callId||exists.get(callId))continue;
    const outcome=outcomes.get(callId),failed=outcome?.section==='model-error'||Number(outcome&&field(outcome,'/status'))>=400;
    insert.run(callId,workspaceId,executionId,ref.invocation_id,ref.node_execution_id,ref.node_execution_id,'model',field(ref,'/body/model')??'Model call',ref.created_at,outcome?.created_at??null,outcome?failed?'failed':'completed':'unavailable',JSON.stringify({historical:true,callId,context:field(ref,'/body/options/num_ctx'),thinkingMode:field(ref,'/body/thinkingMode')??(field(ref,'/body/think')?'on':'off'),timing:outcome?'recorded':'end-unavailable',durationMs:outcome?field(outcome,'/durationMs'):undefined}));
  }})();
  // finish_step is graph control, not a product-tool execution. Recover only calls actually recorded.
  const normalized=database.prepare("SELECT * FROM ai_debug_references WHERE workspace_id=? AND execution_id=? AND section='native-model-normalization' ORDER BY rowid").all(workspaceId,executionId);
  database.transaction(()=>{for(const ref of normalized) {
    const entries=database.prepare("SELECT path FROM ai_debug_paths WHERE hash=? AND parent='/requests' ORDER BY ordinal").all(ref.hash);
    for(const {path} of entries) {
      const name=field(ref,path+'/name'); if(!name)continue;
      const nativeId=field(ref,path+'/id'),exit=field(ref,path+'/arguments/exit'),id=`historical-exit:${ref.id}:${nativeId}`;
      if(database.prepare("SELECT 1 FROM ai_execution_spans WHERE execution_id=? AND attempt_id=? AND json_extract(metadata_json,'$.nativeCallId')=? LIMIT 1").get(executionId,ref.node_execution_id,nativeId))continue;
      if(exists.get(id))continue;
      insert.run(id,workspaceId,executionId,ref.invocation_id,ref.node_execution_id,ref.node_execution_id,name==='finish_step'?'decision':'tool-request',name==='finish_step'?`finish_step -> ${exit??'unknown exit'}`:name,ref.created_at,ref.created_at,'recorded',JSON.stringify({historical:true,nativeCallId:nativeId,selectedExit:exit,timing:'start-unavailable',note:'Recorded model function request, not a product tool execution. Inspect the node transition and tool span for execution outcome.'}));
    }
  }})();
}
export function listExecutionSpans(workspaceId, executionId, { after = 0, limit = 100, invocationId, attemptId } = {}) {
  const database=db(), take=Math.max(1,Math.min(200,Number(limit)||100)), offset=Math.max(0,Math.floor(Number(after)||0));
  recoverRecordedModelSpans(database,workspaceId,executionId);
  // Older node lifecycle events contain real timestamps and identity; never infer missing model/tool spans.
  const query=`WITH legacy AS (
    SELECT json_extract(metadata_json,'$.nodeExecutionId') id,workspace_id,? execution_id,
      json_extract(metadata_json,'$.invocationId') invocation_id,json_extract(metadata_json,'$.nodeExecutionId') attempt_id,
      json_extract(metadata_json,'$.parentNodeExecutionId') parent_id,'node' kind,title name,
      MIN(created_at) started_at,MAX(CASE WHEN status<>'started' THEN created_at END) ended_at,
      CASE WHEN COUNT(*)=1 AND MIN(status)='started' THEN 'started' ELSE MAX(CASE WHEN status<>'started' THEN status END) END status,
      json_object('historical',json('true'),'nodeId',json_extract(metadata_json,'$.nodeId'),'workflowName',json_extract(metadata_json,'$.workflowName'),'timing',CASE WHEN MAX(status='started') THEN 'recorded' ELSE 'start-unavailable' END) metadata_json,MIN(rowid) ordering
    FROM workspace_audit_events WHERE workspace_id=? AND kind='agent-debug-node' AND json_extract(metadata_json,'$.executionId')=?
      AND json_extract(metadata_json,'$.nodeExecutionId') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM ai_execution_spans s WHERE s.workspace_id=? AND s.execution_id=? AND s.id=json_extract(workspace_audit_events.metadata_json,'$.nodeExecutionId'))
    GROUP BY json_extract(metadata_json,'$.nodeExecutionId')
  ), combined AS (SELECT *,rowid ordering FROM ai_execution_spans WHERE workspace_id=? AND execution_id=? UNION ALL SELECT * FROM legacy)
    SELECT *,COUNT(*) OVER() total FROM combined WHERE (? IS NULL OR invocation_id=?) AND (? IS NULL OR attempt_id=?) ORDER BY started_at,ordering LIMIT ? OFFSET ?`;
  const rows=database.prepare(query).all(executionId,workspaceId,executionId,workspaceId,executionId,workspaceId,executionId,invocationId??null,invocationId??null,attemptId??null,attemptId??null,take+1,offset);
  return {version:1,spans:rows.slice(0,take).map(row=>({id:row.id,parentId:row.parent_id,executionId:row.execution_id,invocationId:row.invocation_id,attemptId:row.attempt_id,kind:row.kind,name:row.name,startedAt:row.started_at,endedAt:row.ended_at,status:row.status,metadata:JSON.parse(row.metadata_json)})),hasMore:rows.length>take,nextCursor:rows.length>take?offset+take:null,total:rows[0]?.total??0};
}
