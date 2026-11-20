import { assistantDebugDatabase, getConversation, archiveConversation, createConversation } from './assistantStore.js';
import { listAssistantExecutions,activeAssistantTranslations } from './assistantExecutions.js';
import { canClearAssistantConversation } from '../shared/assistantHistoryPolicy.js';
import { clearUnreferencedDebugArtifacts } from './assistantDebugTrace.js';

export const busyHistory = () => Object.assign(new Error('Finish or cancel the agent execution before clearing.'),{status:409});
export function clearAssistantChat(conversationId,workspaceId,isRunning=()=>false) {
  const db=assistantDebugDatabase();
  return db.transaction(()=>{
    const conversation=getConversation(conversationId);
    if(!conversation||conversation.workspaceId!==workspaceId)throw Object.assign(new Error('Conversation not found.'),{status:404});
    if(isRunning(conversationId)||!canClearAssistantConversation(conversation))throw busyHistory();
    archiveConversation(conversationId);
    db.prepare('DELETE FROM ai_episodic_memory WHERE conversation_id=?').run(conversationId);
    return createConversation({workspaceId,surface:conversation.currentSurface});
  })();
}

const aiKinds="(kind LIKE 'agent-%' OR kind LIKE 'assistant-%' OR kind LIKE 'ai-%' OR kind LIKE 'query-translation-%' OR kind IN ('agent','assistant','ai','query-translation'))";
export function clearWorkspaceJobAudit(workspaceId) {
  return assistantDebugDatabase().prepare(`DELETE FROM workspace_audit_events WHERE workspace_id=? AND NOT ${aiKinds}`).run(workspaceId).changes;
}
export function clearWorkspaceAiHistory(workspaceId,isRunning=()=>false) {
  listAssistantExecutions(workspaceId,{limit:1});
  const db=assistantDebugDatabase();
  return db.transaction(()=>{
    for(const row of db.prepare('SELECT conversation_id,state FROM ai_conversations WHERE workspace_id=? AND archived=0').all(workspaceId)) {
      const pending=db.prepare("SELECT 1 FROM ai_tool_calls WHERE conversation_id=? AND status IN ('pending','executing') LIMIT 1").get(row.conversation_id);
      if(isRunning(row.conversation_id)||pending||!canClearAssistantConversation({state:row.state}))throw busyHistory();
    }
    if([...activeAssistantTranslations.values()].includes(workspaceId))throw busyHistory();
    const count=db.prepare('SELECT COUNT(*) AS count FROM ai_executions WHERE workspace_id=?').get(workspaceId).count;
    db.prepare('INSERT OR IGNORE INTO ai_history_cleared SELECT workspace_id,execution_id FROM ai_executions WHERE workspace_id=?').run(workspaceId);
    for (const table of ['ai_primitive_calls', 'ai_primitive_humans', 'ai_primitive_human_instances', 'ai_primitive_runs', 'ai_active_budgets']) if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      db.prepare(`DELETE FROM ${table} WHERE execution_id IN (SELECT execution_id FROM ai_executions WHERE workspace_id=?)`).run(workspaceId);
    }
    db.prepare('DELETE FROM ai_executions WHERE workspace_id=?').run(workspaceId);
    db.prepare(`DELETE FROM workspace_audit_events WHERE workspace_id=? AND ${aiKinds}`).run(workspaceId);
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_debug_references'").get()) {
      const hashes=db.prepare('SELECT DISTINCT hash FROM ai_debug_references WHERE workspace_id=?').all(workspaceId).map(row=>row.hash);
      db.prepare('DELETE FROM ai_debug_references WHERE workspace_id=?').run(workspaceId);
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_debug_tool_owners'").get())db.prepare('DELETE FROM ai_debug_tool_owners WHERE workspace_id=?').run(workspaceId);
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_execution_spans'").get())db.prepare('DELETE FROM ai_execution_spans WHERE workspace_id=?').run(workspaceId);
      clearUnreferencedDebugArtifacts(db,hashes);
    }
    return {cleared:count};
  })();
}
