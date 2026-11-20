import { assistantDebugDatabase, getAssistantExecutionTrace, getAssistantTurn } from './assistantStore.js';
import { listDebugArtifacts, inspectDebugArtifact } from './assistantDebugTrace.js';
export const activeAssistantTranslations = new Map();

const initialized = new WeakSet();
function database() {
  const db = assistantDebugDatabase();
  if (!initialized.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS ai_executions (
      execution_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL,
      conversation_id TEXT, user_message_id TEXT, request TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ix_ai_execution_page ON ai_executions(workspace_id,created_at,execution_id);
      CREATE INDEX IF NOT EXISTS ix_ai_execution_audit ON workspace_audit_events(workspace_id,json_extract(metadata_json,'$.userMessageId'));
      CREATE INDEX IF NOT EXISTS ix_ai_execution_query ON workspace_audit_events(workspace_id,json_extract(metadata_json,'$.executionId'));`);
    db.exec('CREATE TABLE IF NOT EXISTS ai_history_cleared (workspace_id TEXT NOT NULL,execution_id TEXT NOT NULL,PRIMARY KEY(workspace_id,execution_id));');
    db.exec(`CREATE VIEW IF NOT EXISTS ai_canonical_execution_events AS
      SELECT e.rowid AS rowid,e.action_id,e.workspace_id,
        CASE WHEN e.kind IN ('agent-debug-node','agent-primitive-node') THEN 'agent-stage' ELSE e.kind END AS kind,
        e.title,e.summary,e.status,e.surface,e.signature,e.created_at,
        CASE WHEN e.kind IN ('agent-debug-node','agent-primitive-node') THEN json_set(COALESCE(e.metadata_json,'{}'),
          '$.recordedEventKind',e.kind,
          '$.stageExecutionId',COALESCE(json_extract(e.metadata_json,'$.stageExecutionId'),json_extract(e.metadata_json,'$.nodeExecutionId'),e.action_id),
          '$.subgraph',COALESCE(json_extract(e.metadata_json,'$.subgraph'),json_extract(e.metadata_json,'$.workflowId')))
          ELSE e.metadata_json END AS metadata_json
      FROM workspace_audit_events e WHERE e.kind!='agent-primitive-node' OR NOT EXISTS (
        SELECT 1 FROM workspace_audit_events d WHERE d.workspace_id=e.workspace_id AND d.kind='agent-debug-node'
        AND json_extract(d.metadata_json,'$.executionId')=json_extract(e.metadata_json,'$.userMessageId')
        AND json_extract(d.metadata_json,'$.invocationId')=json_extract(e.metadata_json,'$.invocationId')
        AND json_extract(d.metadata_json,'$.nodeId')=json_extract(e.metadata_json,'$.nodeId'))`);
    initialized.add(db);
  }
  return db;
}

export function beginAssistantExecution({ executionId, workspaceId, conversationId = null, userMessageId = null, request, kind = 'chat', createdAt = new Date().toISOString() }) {
  database().prepare('INSERT OR IGNORE INTO ai_executions SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM ai_history_cleared WHERE workspace_id=? AND execution_id=?)')
    .run(executionId, workspaceId, kind, conversationId, userMessageId, request, createdAt,workspaceId,executionId);
}

function backfill(workspaceId) {
  const db = database();
  // Correlate by recorded identities, never by proximity of timestamps.
  db.prepare(`INSERT OR IGNORE INTO ai_executions
    SELECT m.message_id,c.workspace_id,'chat',m.conversation_id,m.message_id,m.content,m.created_at
    FROM ai_messages m JOIN ai_conversations c ON c.conversation_id=m.conversation_id
    WHERE c.workspace_id=? AND m.role='user' AND json_extract(m.payload_json,'$.clarificationId') IS NULL
    AND NOT EXISTS(SELECT 1 FROM ai_history_cleared h WHERE h.workspace_id=c.workspace_id AND h.execution_id=m.message_id)`).run(workspaceId);
  db.prepare(`INSERT OR IGNORE INTO ai_executions
    SELECT json_extract(metadata_json,'$.executionId'),workspace_id,'query-translation',NULL,NULL,
      COALESCE(json_extract(metadata_json,'$.input.intent'),json_extract(metadata_json,'$.input.sql'),summary),created_at
    FROM workspace_audit_events WHERE workspace_id=? AND kind='query-translation'
      AND status='started' AND json_extract(metadata_json,'$.executionId') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM ai_history_cleared h WHERE h.workspace_id=workspace_audit_events.workspace_id AND h.execution_id=json_extract(metadata_json,'$.executionId'))`).run(workspaceId);
}

function project(row) {
  if (!row) return null;
  const db = database();
  const events = db.prepare(`SELECT * FROM workspace_audit_events WHERE workspace_id=? AND
    (json_extract(metadata_json,'$.userMessageId')=? OR json_extract(metadata_json,'$.executionId')=?)
    AND kind IN ('agent-workflow','query-translation') ORDER BY rowid DESC LIMIT 1`).get(row.workspace_id,row.execution_id,row.execution_id);
  const anchor = db.prepare(`SELECT action_id FROM workspace_audit_events WHERE workspace_id=? AND
    (json_extract(metadata_json,'$.userMessageId')=? OR json_extract(metadata_json,'$.executionId')=?) ORDER BY rowid LIMIT 1`).get(row.workspace_id,row.execution_id,row.execution_id);
  const turnRow = row.user_message_id ? db.prepare('SELECT turn_id FROM ai_turns WHERE user_message_id=? ORDER BY rowid LIMIT 1').get(row.user_message_id) : null;
  const turn = turnRow ? getAssistantTurn(turnRow.turn_id) : null;
  const final = turn ? db.prepare(`SELECT 1 FROM ai_messages WHERE conversation_id=? AND json_extract(payload_json,'$.turnId')=? AND json_extract(payload_json,'$.finalAnswer')=1 LIMIT 1`).get(row.conversation_id,turn.id) : null;
  let status = events?.status ?? 'running';
  if (row.kind === 'chat') {
    const conversation=db.prepare('SELECT state FROM ai_conversations WHERE conversation_id=?').get(row.conversation_id);
    const latest=db.prepare(`SELECT message_id FROM ai_messages WHERE conversation_id=? AND role='user' AND json_extract(payload_json,'$.clarificationId') IS NULL ORDER BY sequence DESC LIMIT 1`).get(row.conversation_id);
    const current = latest?.message_id === row.user_message_id;
    if (current&&conversation) status = ({ idle: final ? 'completed' : status, generating:'running', 'needs-attention':'blocked', interrupted:'interrupted' })[conversation.state] ?? conversation.state;
    else if (final) status = 'completed';
    if(final&&turn.tasks.some(task=>['blocked','failed'].includes(task.status)))status=turn.tasks.some(task=>task.status==='completed')?'partial':'blocked';
  }
  return { id:`execution:${row.execution_id}`,actionId:row.execution_id,executionId:row.execution_id,kind:'agent-turn',
    executionKind:row.kind,title:row.request.trim().slice(0,160)||'AI request',summary:row.request.slice(0,400),status,
    surface:row.kind==='chat'?'ai':'creatio',timestamp:row.created_at,createdAt:row.created_at,timestampMs:Date.parse(row.created_at),
    progress:{completed:turn?.tasks.filter(task=>task.status==='completed').length??0,total:turn?.tasks.length??0},
    metadata:{executionId:row.execution_id,conversationId:row.conversation_id,turnId:turn?.id??null,anchorActionId:anchor?.action_id??null},objectives:turn?.tasks??[] };
}

export function getAssistantExecution(workspaceId, executionId) {
  backfill(workspaceId);
  return project(database().prepare('SELECT * FROM ai_executions WHERE workspace_id=? AND execution_id=?').get(workspaceId,executionId));
}

export function listAssistantExecutions(workspaceId,{cursor,limit=30}={}) {
  backfill(workspaceId);
  const take=Math.max(1,Math.min(50,Math.floor(Number(limit)||30)));
  let before=null;
  if(cursor) { try { before=typeof cursor==='string'?JSON.parse(Buffer.from(cursor,'base64url').toString()):cursor; } catch { throw new Error('Invalid execution cursor.'); } }
  const rows=database().prepare(`SELECT * FROM ai_executions WHERE workspace_id=? AND
    (? IS NULL OR created_at<? OR (created_at=? AND execution_id<?)) ORDER BY created_at DESC,execution_id DESC LIMIT ?`)
    .all(workspaceId,before?.timestamp??null,before?.timestamp??null,before?.timestamp??null,before?.executionId??null,take+1);
  const page=rows.slice(0,take),last=page.at(-1);
  return {entries:page.map(project),hasMore:rows.length>take,nextCursor:rows.length>take?Buffer.from(JSON.stringify({timestamp:last.created_at,executionId:last.execution_id})).toString('base64url'):null};
}

export function assistantExecutionTrace(workspaceId, executionId, options={}) {
  const execution=getAssistantExecution(workspaceId,executionId);
  if(!execution?.metadata.anchorActionId)return null;
  const trace=getAssistantExecutionTrace(workspaceId,execution.metadata.anchorActionId,options);
  return trace?{...trace,...assistantExecutionEvents(workspaceId,executionId,options),execution}:null;
}

export function assistantExecutionEvents(workspaceId,executionId,{after=0,limit=60,invocationId}={}) {
  if(!database().prepare('SELECT 1 FROM ai_executions WHERE workspace_id=? AND execution_id=?').get(workspaceId,executionId))return {events:[],hasMore:false,nextCursor:null};
  const take=Math.max(1,Math.min(100,Math.floor(Number(limit)||60)));
  const rows=database().prepare(`SELECT rowid AS sequence,* FROM ai_canonical_execution_events WHERE workspace_id=? AND
    (json_extract(metadata_json,'$.userMessageId')=? OR json_extract(metadata_json,'$.executionId')=?)
    AND kind IN ('agent-stage','query-translation-step','agent-workflow','query-translation','agent-terminal-session')
    AND (? IS NULL OR json_extract(metadata_json,'$.invocationId')=?) AND rowid>? ORDER BY rowid LIMIT ?`)
    .all(workspaceId,executionId,executionId,invocationId??null,invocationId??null,Math.max(0,Number(after)||0),take+1);
  return {events:rows.slice(0,take).map(row=>({id:row.action_id,sequence:row.sequence,kind:row.kind,title:row.title,status:row.status,createdAt:row.created_at,metadata:JSON.parse(row.metadata_json??'{}')})),hasMore:rows.length>take,nextCursor:rows.length>take?rows[take-1].sequence:null};
}

export function assistantExecutionInvocations(workspaceId,executionId,{parentInvocationId,after=0,limit=30}={}) {
  const db=database(),take=Math.max(1,Math.min(100,Math.floor(Number(limit)||30)));
  if(!db.prepare('SELECT 1 FROM ai_executions WHERE workspace_id=? AND execution_id=?').get(workspaceId,executionId))return {invocations:[],hasMore:false,nextCursor:null};
  const rows=db.prepare(`WITH calls AS (
    SELECT json_extract(metadata_json,'$.invocationId') AS id,
      json_extract(metadata_json,'$.parentInvocationId') AS parentInvocationId,
      json_extract(metadata_json,'$.parentNodeExecutionId') AS parentNodeExecutionId,
      COALESCE(json_extract(metadata_json,'$.subgraph'),'conversation') AS workflowId,
      COALESCE(json_extract(metadata_json,'$.workflowName'),json_extract(metadata_json,'$.subgraph'),'Conversation') AS name,
      MIN(rowid) AS firstSequence,COUNT(DISTINCT json_extract(metadata_json,'$.stageExecutionId')) AS attemptCount
    FROM ai_canonical_execution_events WHERE workspace_id=?
      AND (json_extract(metadata_json,'$.userMessageId')=? OR json_extract(metadata_json,'$.executionId')=?)
      AND kind IN ('agent-stage','query-translation-step') AND json_extract(metadata_json,'$.invocationId') IS NOT NULL
    GROUP BY json_extract(metadata_json,'$.invocationId'))
    SELECT c.*,EXISTS(SELECT 1 FROM calls child WHERE child.parentInvocationId=c.id) AS hasChildren
    FROM calls c WHERE (parentInvocationId IS ? OR (? IS NULL AND NOT EXISTS(SELECT 1 FROM calls p WHERE p.id=c.parentInvocationId)))
      AND firstSequence>? ORDER BY firstSequence LIMIT ?`)
    .all(workspaceId,executionId,executionId,parentInvocationId??null,parentInvocationId??null,Math.max(0,Number(after)||0),take+1);
  return {invocations:rows.slice(0,take),hasMore:rows.length>take,nextCursor:rows.length>take?rows[take-1].firstSequence:null};
}

export function assistantAttemptInspection(workspaceId,executionId,nodeExecutionId) {
  const db=database();
  const rows=db.prepare(`SELECT rowid AS sequence,* FROM ai_canonical_execution_events WHERE workspace_id=?
    AND (json_extract(metadata_json,'$.userMessageId')=? OR json_extract(metadata_json,'$.executionId')=?)
    AND kind IN ('agent-stage','query-translation-step') AND json_extract(metadata_json,'$.stageExecutionId')=? ORDER BY rowid LIMIT 3`)
    .all(workspaceId,executionId,executionId,nodeExecutionId);
  if(!rows.length)return null;
  const last=rows.at(-1),metadata=Object.assign({},...rows.map(row=>JSON.parse(row.metadata_json??'{}')));
  const artifacts=listDebugArtifacts(workspaceId,nodeExecutionId),resolved=artifacts.find(item=>item.section==='resolved-bindings');
  const provenanceArtifact = artifacts.find(item => item.section === 'binding-provenance');
  const recordedProvenance = provenanceArtifact ? inspectDebugArtifact(workspaceId, provenanceArtifact.id)?.value : null;
  if (!metadata.bindings && Array.isArray(recordedProvenance)) metadata.bindings = {
    inputs: Object.fromEntries(recordedProvenance.map(item => [item.input, item.binding])),
    outputs: Object.fromEntries((metadata.producedPaths ?? []).map(path => [path, path]))
  };
  const handoffs=Object.entries(metadata.bindings?.inputs??{}).map(([input,binding])=>{
    const source=binding?.path;
    const producer=typeof source==='string'?db.prepare(`SELECT json_extract(e.metadata_json,'$.stageExecutionId') AS id,e.title
      FROM ai_canonical_execution_events e WHERE workspace_id=? AND rowid<? AND kind IN ('agent-stage','query-translation-step') AND status='completed'
      AND (json_extract(e.metadata_json,'$.userMessageId')=? OR json_extract(e.metadata_json,'$.executionId')=?)
      AND json_extract(e.metadata_json,'$.invocationId')=?
      AND EXISTS(SELECT 1 FROM json_each(e.metadata_json,'$.bindings.outputs') p
        WHERE p.type='text' AND (p.value=? OR substr(?,1,length(p.value)+1)=p.value||'.'))
      ORDER BY rowid DESC LIMIT 1`).get(workspaceId,rows[0].sequence,executionId,executionId,metadata.invocationId??null,source,source):null;
    const value=input.split('.').reduce((current,key)=>current?.[key],metadata.resolvedInputs);
    const valueState=!Object.hasOwn(metadata,'resolvedInputs')?'not-captured':value===undefined?'missing':value===null?'null':value===''?'empty-string':Array.isArray(value)&&!value.length?'empty-array':'present';
    return {input,binding,valueState,origin:!source?'constant':producer?'node-output':'invocation-input',producerId:producer?.id,producerLabel:producer?.title,
      valueReference:resolved?{artifact:resolved,path:`/values/${input.replace(/~/g,'~0').replace(/\//g,'~1')}`}:null,
      callerNodeExecutionId:!producer&&source?metadata.parentNodeExecutionId:null};
  });
  if (Array.isArray(recordedProvenance)) for (const item of handoffs) {
    const recorded = recordedProvenance.find(value => value.input === item.input);
    if (!recorded) continue;
    item.valueState = recorded.valueState;
    if (recorded.producer) {
      item.producerId = recorded.producer.nodeExecutionId;
      item.producerLabel = recorded.producer.nodeId;
      item.origin = 'node-output';
    }
  }
  const outputs=Object.values(metadata.bindings?.outputs??{}).filter(item=>typeof item==='string');
  const consumers=outputs.length?db.prepare(`SELECT DISTINCT json_extract(e.metadata_json,'$.stageExecutionId') AS id,e.title,p.key AS input,json_extract(p.value,'$.path') AS source
    FROM ai_canonical_execution_events e,json_each(e.metadata_json,'$.bindings.inputs') p
    WHERE e.workspace_id=? AND e.rowid>? AND e.kind IN ('agent-stage','query-translation-step') AND e.status='completed'
    AND (json_extract(e.metadata_json,'$.userMessageId')=? OR json_extract(e.metadata_json,'$.executionId')=?)
    AND json_extract(e.metadata_json,'$.invocationId')=?
    AND EXISTS(SELECT 1 FROM json_each(?) o WHERE json_extract(p.value,'$.path')=o.value OR substr(json_extract(p.value,'$.path'),1,length(o.value)+1)=o.value||'.')
    AND NOT EXISTS(SELECT 1 FROM ai_canonical_execution_events w,json_each(w.metadata_json,'$.bindings.outputs') q
      WHERE w.workspace_id=e.workspace_id AND w.rowid>? AND w.rowid<e.rowid AND w.kind IN ('agent-stage','query-translation-step') AND w.status='completed'
      AND json_extract(w.metadata_json,'$.invocationId')=? AND q.type='text'
      AND (json_extract(p.value,'$.path')=q.value OR substr(json_extract(p.value,'$.path'),1,length(q.value)+1)=q.value||'.'))
    ORDER BY e.rowid LIMIT 101`).all(workspaceId,last.sequence,executionId,executionId,metadata.invocationId??null,JSON.stringify(outputs),last.sequence,metadata.invocationId??null):[];
  return {attempt:{id:last.action_id,title:last.title,status:last.status,createdAt:last.created_at,startedAt:rows[0].created_at,
    attemptId:nodeExecutionId,firstSequence:rows[0].sequence,sequence:last.sequence,metadata},handoffs,consumers:consumers.slice(0,100),hasMoreConsumers:consumers.length>100,artifacts,captureCompleteness:artifacts.length?'full-artifacts':'historical-preview'};
}
