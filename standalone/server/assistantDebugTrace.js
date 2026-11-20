import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { assistantDebugDatabase, getConversation, recordWorkspaceAuditEvent } from './assistantStore.js';
function readNodePath(value, path) {
  if (typeof path !== 'string' || !path.split('.').every(key => /^[A-Za-z0-9_-]+$/.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('Invalid historical state path.');
  return path.split('.').reduce((current, key) => current != null && Object.hasOwn(Object(current), key) ? current[key] : undefined, value);
}
import { indexJsonDocument } from '../shared/agentJsonIndex.js';
import { jsonSearchableValue } from '../shared/agentJsonSearch.js';
import { beginExecutionSpan, endExecutionSpan, listExecutionSpans } from './assistantSpans.js';

const active = new AsyncLocalStorage();
const initialized = new WeakSet();
export const rawDebugEnabled = () => process.env.CHRONOSQL_AI_DEBUG_CAPTURE === 'raw';
export const executionNodeContext = () => active.getStore();
export const debugTraceContext = () => active.getStore()?.raw ? active.getStore() : undefined;
const encode = value => JSON.stringify(value, (_key, item) => item === undefined ? { $type: 'undefined' } : typeof item === 'bigint' ? { $type: 'bigint', value: String(item) } : typeof item === 'function' ? { $type: 'runtime-function' } : item);
function db() {
  const database = assistantDebugDatabase();
  if (!initialized.has(database)) {
    database.exec(`CREATE TABLE IF NOT EXISTS ai_debug_artifacts (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, compressed_bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_debug_chunks (hash TEXT NOT NULL, part INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(hash,part));
      CREATE TABLE IF NOT EXISTS ai_debug_references (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, execution_id TEXT NOT NULL, invocation_id TEXT NOT NULL, node_execution_id TEXT NOT NULL, section TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_debug_paths (hash TEXT NOT NULL, path TEXT NOT NULL, parent TEXT, key TEXT NOT NULL, ordinal INTEGER NOT NULL, type TEXT NOT NULL, start INTEGER NOT NULL, length INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(hash,path));
      CREATE TABLE IF NOT EXISTS ai_debug_tool_owners (tool_call_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,execution_id TEXT NOT NULL,invocation_id TEXT NOT NULL,node_execution_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ix_ai_debug_path_children ON ai_debug_paths(hash,parent,ordinal);
      CREATE INDEX IF NOT EXISTS ix_ai_debug_execution ON ai_debug_references(workspace_id,execution_id,node_execution_id);
      CREATE INDEX IF NOT EXISTS ix_ai_debug_reference_hash ON ai_debug_references(hash);
      CREATE INDEX IF NOT EXISTS ix_ai_debug_node_refs ON ai_debug_references(workspace_id,node_execution_id);
      CREATE INDEX IF NOT EXISTS ix_ai_debug_timeline ON workspace_audit_events(workspace_id,kind,json_extract(metadata_json,'$.executionId'));
      CREATE INDEX IF NOT EXISTS ix_ai_debug_producers ON workspace_audit_events(workspace_id,kind,status,json_extract(metadata_json,'$.executionId'),json_extract(metadata_json,'$.invocationId'));`);
    initialized.add(database);
  }
  return database;
}
export function linkDebugToolCall(toolCall) {
  const trace=debugTraceContext();if(!trace)return;
  db().prepare('INSERT OR IGNORE INTO ai_debug_tool_owners VALUES (?,?,?,?,?)').run(toolCall.id,trace.workspaceId,trace.executionId,trace.invocationId,trace.nodeExecutionId);
  trace.capture('tool-request',toolCall);
}
export function captureToolArtifact(toolCall,section,value) {
  if(!rawDebugEnabled())return null;
  const owner=db().prepare('SELECT * FROM ai_debug_tool_owners WHERE tool_call_id=?').get(toolCall.id);
  if(owner)return saveDebugArtifact({workspaceId:owner.workspace_id,executionId:owner.execution_id,invocationId:owner.invocation_id,nodeExecutionId:owner.node_execution_id},section,value);
  return debugTraceContext()?.capture(section,value)??null;
}
export function saveDebugArtifact(identity, section, value) {
  if (!rawDebugEnabled()) return null;
  const database = db(), serialized = encode(value), bytes = Buffer.from(serialized), hash = createHash('sha256').update(bytes).digest('hex');
  const id = randomUUID();
  database.transaction(() => {
    if (!database.prepare('SELECT 1 FROM ai_debug_artifacts WHERE hash=?').get(hash)) {
      const insert = database.prepare('INSERT INTO ai_debug_chunks VALUES (?,?,?)');
      let compressedBytes=0;
      for (let offset = 0, part = 0; offset < bytes.length; offset += 32768, part++) {const compressed=gzipSync(bytes.subarray(offset,offset+32768));compressedBytes+=compressed.length;insert.run(hash,part,compressed);}
      database.prepare('INSERT INTO ai_debug_artifacts VALUES (?,?,?)').run(hash, bytes.length, compressedBytes);
      indexArtifact(database,hash,serialized);
    }
    database.prepare('INSERT INTO ai_debug_references VALUES (?,?,?,?,?,?,?,?)').run(id, identity.workspaceId, identity.executionId, identity.invocationId, identity.nodeExecutionId, section, hash, new Date().toISOString());
  })();
  return { id, section, bytes: bytes.length, hash };
}
function indexArtifact(database, hash, text) {
  const insert=database.prepare('INSERT OR IGNORE INTO ai_debug_paths VALUES (?,?,?,?,?,?,?,?,?)');
  for(const item of indexJsonDocument(text))insert.run(hash,item.path,item.parent,item.key,item.ordinal,item.type,item.start,item.length,item.count);
}
function artifactBytes(database,hash,start,length) {
  if(!length)return Buffer.alloc(0);
  const first=Math.floor(start/32768),last=Math.floor((start+length-1)/32768);
  return Buffer.concat(database.prepare('SELECT payload FROM ai_debug_chunks WHERE hash=? AND part>=? AND part<=? ORDER BY part').all(hash,first,last).map(row=>gunzipSync(row.payload))).subarray(start-first*32768,start-first*32768+length);
}
export function inspectDebugArtifact(workspaceId,id,{path='',after=0,limit=50,textOffset=0,query='',full='false',editor='false'}={}) {
  if(!rawDebugEnabled())return null;
  const database=db(),reference=database.prepare('SELECT r.*,a.bytes FROM ai_debug_references r JOIN ai_debug_artifacts a ON a.hash=r.hash WHERE r.workspace_id=? AND r.id=?').get(workspaceId,id);
  if(!reference)return null;
  if(!database.prepare("SELECT 1 FROM ai_debug_paths WHERE hash=? AND path=''").get(reference.hash)) {
    database.transaction(()=>indexArtifact(database,reference.hash,artifactBytes(database,reference.hash,0,reference.bytes).toString('utf8')))();
  }
  const item=database.prepare('SELECT * FROM ai_debug_paths WHERE hash=? AND path=?').get(reference.hash,String(path));
  if(!item)return null;
  const search=String(query).slice(0,200);
  const hits=[],take=Math.max(1,Math.min(100,Math.floor(Number(limit)||50))),requestedOffset=Math.max(0,Math.floor(Number(after)||0));let hitCount=0;
  if(search) {
    const needle=search.toLowerCase();
    for(const row of database.prepare('SELECT * FROM ai_debug_paths WHERE hash=? AND substr(path,1,?)=? ORDER BY start').iterate(reference.hash,item.path.length+1,item.path+'/')) {
      let found=row.key.toLowerCase().includes(needle);
      if(!found&&!['array','object'].includes(row.type)) {
        if(row.length<=5*1024*1024) {
          const scalar=JSON.parse(artifactBytes(database,reference.hash,row.start,row.length).toString('utf8'));
          found=jsonSearchableValue('',scalar).toLowerCase().includes(needle);
        } else {
          const decoder=new TextDecoder();let tail='';
          for(let offset=0;offset<row.length&&!found;offset+=32768){const text=tail+decoder.decode(artifactBytes(database,reference.hash,row.start+offset,Math.min(32768,row.length-offset)),{stream:offset+32768<row.length});found=text.toLowerCase().includes(needle);tail=text.slice(-Math.max(needle.length,16));}
        }
      }
      if(found){if(hitCount>=requestedOffset&&hits.length<take)hits.push(row);hitCount++;}
    }
  }
  const matching=search?hitCount:item.count;
  const offset=Math.min(matching,requestedOffset);
  const project=row=>({path:row.path,key:row.key,type:row.type,bytes:row.length,count:row.count,
    ...(row.length<=4096&&row.type!=='array'&&row.type!=='object'?{value:JSON.parse(artifactBytes(database,reference.hash,row.start,row.length).toString('utf8'))}:{} )});
  const children=search?hits:database.prepare('SELECT * FROM ai_debug_paths WHERE hash=? AND parent=? AND ordinal>=? ORDER BY ordinal LIMIT ?').all(reference.hash,item.path,offset,take);
  const result={id,section:reference.section,hash:reference.hash,complete:true,...project(item),children:children.map(project),matchingCount:matching,nextCursor:offset+children.length<matching?offset+children.length:null};
  if(item.length<=(editor==='true'?5*1024*1024:262144)||full==='true')result.value=JSON.parse(artifactBytes(database,reference.hash,item.start,item.length).toString('utf8'));
  else if(item.type==='string') {
    const start=Math.max(0,Math.min(item.length,Math.floor(Number(textOffset)||0)));
    const buffer=artifactBytes(database,reference.hash,item.start+start,Math.min(32772,item.length-start));
    let from=0,to=Math.min(32768,buffer.length);while(from<to&&(buffer[from]&192)===128)from++;while(to>from&&start+to<item.length&&(buffer[to]&192)===128)to--;
    result.text=buffer.subarray(from,to).toString('utf8');result.textOffset=start;result.nextTextOffset=start+to<item.length?start+to:null;
  }
  return result;
}
export function listDebugArtifacts(workspaceId, nodeExecutionId) {
  if (!rawDebugEnabled()) return [];
  return db().prepare('SELECT r.id,r.section,a.bytes,r.hash FROM ai_debug_references r JOIN ai_debug_artifacts a ON a.hash=r.hash WHERE r.workspace_id=? AND r.node_execution_id=? ORDER BY r.created_at,r.rowid').all(workspaceId,nodeExecutionId);
}
export function readExecutionDebugArtifact(workspaceId, executionId, id, offset, limit) {
  if (!rawDebugEnabled()) return null;
  const database = db();
  const reference = database.prepare(`SELECT r.hash,a.bytes FROM ai_debug_references r
    JOIN ai_debug_artifacts a ON a.hash=r.hash WHERE r.workspace_id=? AND r.execution_id=? AND r.id=?`)
    .get(workspaceId, executionId, id);
  if (!reference) return null;
  const start = Math.min(offset, reference.bytes);
  const end = Math.min(start + limit, reference.bytes);
  return {
    payload: artifactBytes(database, reference.hash, start, end - start).toString('base64'),
    offset: start, nextOffset: end < reference.bytes ? end : null, bytes: reference.bytes,
  };
}
export function readDebugArtifact(workspaceId, id, offset = 0, limit = 32768) {
  if (!rawDebugEnabled()) return null;
  const database = db(), reference = database.prepare('SELECT r.*,a.bytes FROM ai_debug_references r JOIN ai_debug_artifacts a ON a.hash=r.hash WHERE r.workspace_id=? AND r.id=?').get(workspaceId,id);
  if (!reference) return null;
  const start=Math.min(reference.bytes,Math.max(0,Math.floor(Number(offset)||0))),take=Math.max(4,Math.min(65536,Number(limit)||32768)),first=Math.floor(start/32768),end=Math.min(reference.bytes,start+take);
  const buffer=Buffer.concat(database.prepare('SELECT payload FROM ai_debug_chunks WHERE hash=? AND part>=? AND part<=? ORDER BY part').all(reference.hash,first,Math.floor(end/32768)).map(row=>gunzipSync(row.payload)));
  let from=start-first*32768,to=end-first*32768;
  while(from<buffer.length&&(buffer[from]&192)===128)from++;
  while(to<buffer.length&&(buffer[to]&192)===128)to--;
  const next=first*32768+to;
  return {id,section:reference.section,content:buffer.subarray(from,to).toString('utf8'),offset:start,nextOffset:next<reference.bytes?next:null,bytes:reference.bytes,offsetUnit:'utf8-bytes'};
}
export function debugExecutionStorage(workspaceId, executionId) {
  if (!rawDebugEnabled()) return { enabled: false };
  const database = db();
  return { enabled: true, mode: 'raw', ...database.prepare('SELECT COUNT(*) AS artifactCount, COALESCE(SUM(a.bytes),0) AS referencedBytes FROM ai_debug_references r JOIN ai_debug_artifacts a ON a.hash=r.hash WHERE r.workspace_id=? AND r.execution_id=?').get(workspaceId,executionId) };
}
export function listDebugNodes(workspaceId,executionId,after=0,limit=40) {
  if(!rawDebugEnabled())return {enabled:false,nodes:[],hasMore:false};
  const take=Math.max(1,Math.min(100,Number(limit)||40));
  const rows=db().prepare(`SELECT rowid AS sequence,* FROM workspace_audit_events WHERE workspace_id=? AND kind='agent-debug-node' AND json_extract(metadata_json,'$.executionId')=? AND rowid>? ORDER BY rowid LIMIT ?`).all(workspaceId,executionId,Math.max(0,Number(after)||0),take+1);
  return {enabled:true,nodes:rows.slice(0,take).map(row=>({sequence:row.sequence,title:row.title,status:row.status,createdAt:row.created_at,...JSON.parse(row.metadata_json)})),hasMore:rows.length>take,nextCursor:rows.length>take?rows[take-1].sequence:null};
}
export function* exportDebugExecution(workspaceId,executionId) {
  if(!rawDebugEnabled())throw new Error('Raw debug capture is disabled.');
  const database=db();
  let cursor=0;
  do {const page=listExecutionSpans(workspaceId,executionId,{after:cursor,limit:200});for(const span of page.spans)yield JSON.stringify({type:'span',version:1,...span})+'\n';cursor=page.nextCursor;}while(cursor!==null);
  for(const reference of database.prepare('SELECT * FROM ai_debug_references WHERE workspace_id=? AND execution_id=? ORDER BY rowid').iterate(workspaceId,executionId)) {
    yield JSON.stringify({type:'artifact',...reference})+'\n';
    for(const chunk of database.prepare('SELECT part,payload FROM ai_debug_chunks WHERE hash=? ORDER BY part').iterate(reference.hash))yield JSON.stringify({type:'chunk',id:reference.id,codec:'gzip',part:chunk.part,payload:chunk.payload.toString('base64')})+'\n';
  }
}
export function clearUnreferencedDebugArtifacts(database,hashes) {
  const retained=database.prepare('SELECT 1 FROM ai_debug_references WHERE hash=? LIMIT 1');
  const tables=['ai_debug_paths','ai_debug_chunks','ai_debug_artifacts'].filter(table=>database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  const remove=tables.map(table=>database.prepare(`DELETE FROM ${table} WHERE hash=?`));
  for(const hash of new Set(hashes))if(!retained.get(hash))for(const statement of remove)statement.run(hash);
}
export function deleteDebugExecution(workspaceId, executionId) {
  if (!rawDebugEnabled()) throw new Error('Raw debug capture is disabled.');
  const database = db();
  database.transaction(() => {
    const hashes=database.prepare('SELECT DISTINCT hash FROM ai_debug_references WHERE workspace_id=? AND execution_id=?').all(workspaceId,executionId).map(row=>row.hash);
    database.prepare('DELETE FROM ai_debug_references WHERE workspace_id=? AND execution_id=?').run(workspaceId,executionId);
    database.prepare('DELETE FROM ai_debug_tool_owners WHERE workspace_id=? AND execution_id=?').run(workspaceId,executionId);
    clearUnreferencedDebugArtifacts(database,hashes);
  })();
}
export function stateChanges(before, after) {
  return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter(key => encode(before?.[key]) !== encode(after?.[key])).map(path => ({ path, before: before?.[path], after: after?.[path], existedBefore: Object.hasOwn(before ?? {},path), existsAfter: Object.hasOwn(after ?? {},path) }));
}
const primitiveBindings = (binding, target = 'payload') => binding?.fields ? Object.entries(binding.fields).flatMap(([key, source]) => primitiveBindings(source, `${target}.${key}`))
  : binding?.merge ? binding.merge.flatMap((source, index) => primitiveBindings(source, `${target}.merge_${index}`)) : [[target, binding]];
function bindingProvenance(identity, node, state) {
  const bindings = node.settings?.input ? Object.fromEntries([...primitiveBindings(node.settings.input), ...(node.settings.context ? primitiveBindings(node.settings.context, 'context') : [])]) : node.settings?.inputBindings ?? {};
  return Object.entries(bindings).map(([input, binding]) => {
    const source = binding.path;
    const value = source ? readNodePath(state, source) : binding.value;
    const producer = source ? db().prepare(`SELECT metadata_json FROM workspace_audit_events e
      WHERE workspace_id=? AND kind='agent-debug-node' AND status IN ('completed','failed')
      AND json_extract(metadata_json,'$.executionId')=? AND json_extract(metadata_json,'$.invocationId')=?
      AND EXISTS (SELECT 1 FROM json_each(e.metadata_json,'$.producedPaths') p WHERE p.value=? OR ? LIKE p.value || '.%')
      ORDER BY rowid DESC LIMIT 1`).get(identity.workspaceId, identity.executionId, identity.invocationId, source, source) : null;
    const owner = producer ? JSON.parse(producer.metadata_json) : null;
    return { input, binding, source: source ?? 'constant', valueState: value === undefined ? 'missing' : value === null ? 'null' : value === '' ? 'empty-string' : Array.isArray(value) && !value.length ? 'empty-array' : 'present',
      producer: owner ? { nodeId: owner.nodeId, nodeExecutionId: owner.nodeExecutionId, workflowId: owner.workflowId, invocationId: owner.invocationId } : null,
      origin: owner ? 'node-output' : source ? 'invocation-input' : 'constant' };
  });
}
export async function traceNode({ conversationId, userMessageId, turnId, workflow, node, invocationId, workspaceId, onReference, parentIdentity, signal }, state, execute) {
  const parent = active.getStore() ?? parentIdentity, conversation = conversationId ? getConversation(conversationId) : null;
  const identity = { workspaceId: workspaceId ?? conversation?.workspaceId, executionId: parent?.executionId ?? userMessageId ?? randomUUID(), invocationId: invocationId ?? parent?.invocationId ?? randomUUID(), nodeExecutionId: randomUUID(), parentNodeExecutionId:parent?.nodeExecutionId??null,parentInvocationId:parent?.invocationId??null };
  if (!identity.workspaceId) return execute();
  const artifacts = [];
  const spanId=beginExecutionSpan(identity,'node',node.label,{nodeId:node.id,handler:node.handler,workflowName:workflow.name},identity.nodeExecutionId);
  const capture = (section,value) => { const ref = saveDebugArtifact(identity,section,value); if (ref) { artifacts.push(ref); onReference?.(ref); } return ref; };
  return active.run({ ...identity, raw:rawDebugEnabled(), capture }, async () => {
    const before=JSON.parse(encode(state));
    capture('inputs',state); capture('configuration',node); capture('binding-provenance',bindingProvenance(identity,node,state));
    if (workflow.schemaVersion !== 5) capture('resolved-inputs',Object.fromEntries(Object.entries(node.settings?.inputBindings??{}).map(([key,binding])=>[key,binding.path?readNodePath(state,binding.path):binding.value])));
    const primitive = workflow.schemaVersion === 5;
    const metadata = { ...identity, parentNodeExecutionId: parent?.nodeExecutionId ?? null, parentInvocationId: parent?.invocationId ?? null, conversationId, userMessageId: userMessageId ?? parent?.executionId, turnId, nodeId: node.id, handler: node.handler, workflowId: workflow.purpose ?? 'conversation', workflowName: workflow.name, subgraph: workflow.purpose ?? 'conversation', stageExecutionId: identity.nodeExecutionId, configurationHash: createHash('sha256').update(encode(node)).digest('hex'), workflowHash: createHash('sha256').update(encode(workflow)).digest('hex'), attempt: state.iteration ?? state.attempts ?? state.steps ?? 0, rawDebug: rawDebugEnabled(),
      ...(primitive ? { bindings: { inputs: Object.fromEntries([...primitiveBindings(node.settings.input), ...(node.settings.context ? primitiveBindings(node.settings.context, 'context') : [])]), outputs: { payload: 'payload', ...Object.fromEntries(Object.keys(node.settings.outputs ?? {}).map(key => [key, `variables.${key}`])) } } } : {}) };
    const record = (status, extra = {}) => recordWorkspaceAuditEvent({ workspaceId: identity.workspaceId, kind: 'agent-debug-node', title: node.label, summary: `${workflow.name} / ${status}`, status, surface: 'ai', signature: `${identity.nodeExecutionId}:${status}`, metadata: { ...metadata, artifacts: [...artifacts], ...extra } });
    record('started');
    try {
      const output = await execute(); capture('outputs',output); capture('state-changes',stateChanges(before,{...state,...output}));
      if (output?.failure) capture('error-recovery', output.failure);
      const edge = workflow.schemaVersion === 5 ? workflow.edges.find(edge => edge.id === output?.route) : null;
      capture('decision', { route: output?.route ?? output?.stepOutcome ?? output?.terminalState ?? null, edge: edge ?? null, failure: output?.failure ?? null });
      const producedPaths = workflow.schemaVersion === 5 ? [...['payload', 'result'].filter(key => Object.hasOwn(output ?? {}, key)), ...Object.keys(node.settings.outputs ?? {}).map(key => `variables.${key}`)]
        : [...new Set([...Object.keys(output ?? {}), ...Object.values(node.settings?.outputBindings ?? {})])];
      endExecutionSpan(spanId,output?.failure?'failed':'completed',{route:output?.route??null,nextNodeId:edge?.target??null});
      record(output?.failure ? 'failed' : 'completed', { turnId: output?.turnId ?? turnId, producedPaths, failure: output?.failure ?? null, outcome: output?.stepOutcome ?? output?.terminalState ?? output?.route ?? null,
        ...(edge ? { transition: edge.id, edgeId: edge.id, nextNodeId: edge.target } : {}), attempt: output?.iteration ?? output?.attempts ?? output?.steps ?? metadata.attempt }); return output;
    } catch (error) {
      const paused = error.name === 'GraphInterrupt' || error.constructor?.name === 'GraphInterrupt';
      endExecutionSpan(spanId,paused?'paused':error.name==='AbortError'||signal?.aborted?'canceled':'failed');
      capture('error-recovery',{ name:error.name,message:error.message,stack:error.stack,interrupted:paused }); record(paused ? node.settings?.kind === 'approval' ? 'awaiting-approval' : 'awaiting-clarification' : error.name === 'AbortError' || signal?.aborted ? 'canceled' : 'failed', { producedPaths: [], ...(metadata.bindings ? { bindings: { ...metadata.bindings, outputs: {} } } : {}) }); throw error;
    }
  });
}

export async function traceModelRequest(body, execute, metadata = {}) {
  const trace = executionNodeContext();
  if (!trace) return execute();
  const callId = randomUUID(), started = performance.now();
  const spanId=beginExecutionSpan(trace,'model',body.model,{...metadata,callId,model:body.model,context:body.options?.num_ctx,thinkingMode:body.thinkingMode??(body.think?'on':'off')},callId);
  trace.capture('model-request',{ callId, body });
  try {
    const response = await execute();
    // A clone preserves the consumer's stream. Raw chunks are captured by the gateway separately.
    if(trace.raw) {
      const text = await response.clone().text();
      trace.capture('model-response',{ callId,status:response.status,headers:Object.fromEntries(response.headers),body:text,durationMs:performance.now()-started });
    }
    endExecutionSpan(spanId,response.ok?'completed':'failed',{durationMs:performance.now()-started,httpStatus:response.status});
    return response;
  } catch (error) { trace.capture('model-error',{callId,message:error.message,durationMs:performance.now()-started}); endExecutionSpan(spanId,error.name==='AbortError'?'canceled':'failed',{durationMs:performance.now()-started}); throw error; }
}
