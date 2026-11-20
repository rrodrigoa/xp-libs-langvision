import { assistantDebugDatabase } from './assistantStore.js';

export function readAgentHistory(name, args, identity) {
  const db=assistantDebugDatabase();
  db.exec('CREATE TABLE IF NOT EXISTS ai_history_cleared (workspace_id TEXT NOT NULL,execution_id TEXT NOT NULL,PRIMARY KEY(workspace_id,execution_id))');
  const anchor=db.prepare(`SELECT m.rowid AS position,m.*,c.workspace_id FROM ai_messages m JOIN ai_conversations c USING(conversation_id) WHERE message_id=?`).get(identity.userMessageId);
  if(!anchor || anchor.workspace_id!==identity.workspaceId || anchor.conversation_id!==identity.conversationId) throw new Error('History requires the current persisted request and workspace identity.');
  const before=Math.min(anchor.position,args.beforeSequence??anchor.position);
  const eligible=`m.rowid<? AND c.workspace_id=? AND m.role='user' AND json_extract(m.payload_json,'$.clarificationId') IS NULL AND NOT EXISTS(SELECT 1 FROM ai_history_cleared h WHERE h.workspace_id=c.workspace_id AND h.execution_id=m.message_id)`;
  if(name==='history.list_conversations') {
    const take=args.limit??10;
    const rows=db.prepare(`SELECT c.conversation_id AS conversationId,c.title,MAX(m.rowid) AS sequence,MAX(m.created_at) AS lastRequestAt FROM ai_messages m JOIN ai_conversations c USING(conversation_id) WHERE ${eligible} GROUP BY c.conversation_id HAVING MAX(m.rowid)<? ORDER BY sequence DESC LIMIT ?`).all(anchor.position,identity.workspaceId,before,take+1);
    const page=rows.slice(0,take).reverse();
    return {order:'chronological',conversations:page,hasMore:rows.length>take,nextBeforeSequence:rows.length>take?page[0].sequence:null};
  }
  if(name==='history.list_turns') {
    const take=args.limit??5, conversationId=args.conversationId??identity.conversationId;
    const conversation=db.prepare('SELECT workspace_id FROM ai_conversations WHERE conversation_id=?').get(conversationId);
    if(!conversation || conversation.workspace_id!==identity.workspaceId) throw new Error('Conversation history is unavailable in this workspace.');
    const rows=db.prepare(`SELECT m.rowid AS sequence,m.message_id AS executionId,m.conversation_id AS conversationId,m.content AS request,m.created_at AS createdAt FROM ai_messages m JOIN ai_conversations c USING(conversation_id) WHERE ${eligible} AND m.conversation_id=? ORDER BY m.rowid DESC LIMIT ?`).all(before,identity.workspaceId,conversationId,take+1);
    const turns=rows.slice(0,take).reverse();
    return {order:'chronological',turns,hasMore:rows.length>take,nextBeforeSequence:rows.length>take?turns[0].sequence:null};
  }
  const turn=db.prepare(`SELECT m.rowid AS position,m.* FROM ai_messages m JOIN ai_conversations c USING(conversation_id) WHERE ${eligible} AND m.message_id=?`).get(anchor.position,identity.workspaceId,args.executionId);
  if(!turn) throw new Error('That prior turn is unavailable, cleared, current/future, or belongs to another workspace.');
  const take=args.limit??20, after=args.afterSequence??0;
  if(name==='history.read_actions') {
    const rows=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_primitive_calls'").get() ? db.prepare('SELECT rowid AS sequence,request_json,status,result_json FROM ai_primitive_calls WHERE execution_id=? AND rowid>? ORDER BY rowid LIMIT ?').all(turn.message_id,after,take+1) : [];
    const actions=rows.slice(0,take).map(row=>({sequence:row.sequence,request:JSON.parse(row.request_json),status:row.status,observation:row.result_json?JSON.parse(row.result_json):null}));
    return {executionId:turn.message_id,order:'chronological',actions,hasMore:rows.length>take,nextAfterSequence:rows.length>take?actions.at(-1).sequence:null,limitation:rows.length?null:'No primitive tool calls were recorded for this turn.'};
  }
  if(name!=='history.read_turn') throw new Error('Unknown history tool.');
  const next=db.prepare(`SELECT sequence FROM ai_messages WHERE conversation_id=? AND sequence>? AND role='user' AND json_extract(payload_json,'$.clarificationId') IS NULL ORDER BY sequence LIMIT 1`).get(turn.conversation_id,turn.sequence);
  const rows=db.prepare('SELECT rowid AS position,* FROM ai_messages WHERE conversation_id=? AND sequence>=? AND sequence<? AND rowid<? AND sequence>? ORDER BY sequence LIMIT ?').all(turn.conversation_id,turn.sequence,next?.sequence??Number.MAX_SAFE_INTEGER,anchor.position,after,take+1);
  const messages=rows.slice(0,take).map(row=>{
    const payload=JSON.parse(row.payload_json??'{}');
    return {id:row.message_id,sequence:row.sequence,role:row.role,content:row.content,createdAt:row.created_at,
      ...(payload.progress?{progress:payload.progress}:{}),...(payload.clarificationId?{clarificationId:payload.clarificationId}:{}),...(payload.toolCallId?{toolCallId:payload.toolCallId}:{}),...(payload.finalAnswer?{finalAnswer:true}:{})};
  });
  return {executionId:turn.message_id,conversationId:turn.conversation_id,order:'chronological',messages,hasMore:rows.length>take,nextAfterSequence:rows.length>take?messages.at(-1).sequence:null,contextPolicy:'Historical public conversation and tool evidence only; no raw model/debug artifacts.'};
}
