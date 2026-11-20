import { assistantDebugDatabase, activeAssistantWorkflow, saveAssistantWorkflowDraft } from './assistantStore.js';

const database = assistantDebugDatabase;
const conflict = message => Object.assign(new Error(message), { status: 409 });
export function workflowVersion(workflowId, version, includeDeleted = false) {
  const row = database().prepare(`SELECT v.*,COALESCE(l.label,'Version '||v.version) AS label,
    COALESCE(l.revision,0) AS revision,COALESCE(l.deleted,0) AS deleted
    FROM ai_workflow_versions v LEFT JOIN ai_workflow_version_labels l USING(workflow_id,version)
    WHERE v.workflow_id=? AND v.version=?`).get(workflowId, Number(version));
  if (!row || row.deleted && !includeDeleted) throw Object.assign(new Error('Workflow version not found.'), { status: 404 });
  return { id: row.workflow_id, version: row.version, label: row.label, revision: row.revision,
    definition: JSON.parse(row.definition_json), updatedAt: row.updated_at };
}
export function listWorkflowVersions(workspaceId, workflowId) {
  const active = activeAssistantWorkflow(workspaceId), db = database();
  return db.prepare(`SELECT v.version FROM ai_workflow_versions v
    LEFT JOIN ai_workflow_version_labels l USING(workflow_id,version)
    WHERE v.workflow_id=? AND COALESCE(l.deleted,0)=0 ORDER BY v.version DESC`).all(workflowId).map(row => {
      const item = workflowVersion(workflowId, row.version);
      return { ...item, definition: undefined, active: active.id === workflowId && active.version === item.version,
        workflows: [item.definition, item.definition.queryTranslation, item.definition.executionWorkflow, item.definition.synthesisWorkflow]
          .filter(Boolean).map(graph => ({ name: graph.name, purpose: graph.purpose ?? 'conversation', schemaVersion: graph.schemaVersion })) };
    });
}
export function editWorkflowVersion(workflowId, version, { label, remove = false, expectedRevision }) {
  const db = database();
  return db.transaction(() => {
    const item = workflowVersion(workflowId, version);
    if (item.revision !== expectedRevision) throw conflict('Version metadata changed. Reload before editing.');
    if (remove) {
      const pinned = db.prepare('SELECT 1 FROM workspace_ai_workflow_revisions WHERE workflow_id=? AND version=? LIMIT 1').get(workflowId, item.version);
      const legacy = db.prepare(`SELECT 1 FROM workspace_ai_workflows w
        WHERE w.workflow_id=? AND ?=(SELECT MAX(v.version) FROM ai_workflow_versions v
          LEFT JOIN ai_workflow_version_labels l USING(workflow_id,version)
          WHERE v.workflow_id=w.workflow_id AND COALESCE(l.deleted,0)=0) AND NOT EXISTS
        (SELECT 1 FROM workspace_ai_workflow_revisions p WHERE p.workspace_id=w.workspace_id) LIMIT 1`).get(workflowId, item.version);
      if (pinned || legacy) throw conflict('An active version cannot be deleted. Activate another version first.');
      const remaining=db.prepare(`SELECT COUNT(*) AS count FROM ai_workflow_versions v LEFT JOIN ai_workflow_version_labels l USING(workflow_id,version)
        WHERE v.workflow_id=? AND COALESCE(l.deleted,0)=0`).get(workflowId).count;
      if(remaining===1)throw conflict('Keep at least one published version for this agent.');
    }
    const name = remove ? item.label : String(label ?? '').trim();
    if (!name || name.length > 100) throw new Error('Use a version name between 1 and 100 characters.');
    db.prepare(`INSERT INTO ai_workflow_version_labels VALUES (?,?,?,?,?) ON CONFLICT(workflow_id,version)
      DO UPDATE SET label=excluded.label,revision=excluded.revision,deleted=excluded.deleted`)
      .run(workflowId, item.version, name, item.revision + 1, remove ? 1 : 0);
    return { version: item.version, label: name, revision: item.revision + 1, deleted: remove };
  })();
}
export function activateWorkflowVersion(workspaceId, workflowId, version, expectedActive, validate) {
  const db = database();
  return db.transaction(() => {
    const active = activeAssistantWorkflow(workspaceId);
    if (db.prepare('SELECT 1 FROM ai_agent_archives WHERE workflow_id=?').get(workflowId)) throw conflict('This agent was deleted.');
    const requested = workflowVersion(workflowId, version);
    if (requested.definition.schemaVersion !== 5) throw conflict('Retired staged revisions are read-only.');
    if (!expectedActive || active.id !== expectedActive.id || active.version !== expectedActive.version)
      throw conflict('The active version changed. Reload before activating.');
    const item = workflowVersion(workflowId, version);
    validate(item.definition);
    db.prepare(`INSERT INTO workspace_ai_workflows VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET workflow_id=excluded.workflow_id`).run(workspaceId, workflowId);
    db.prepare(`INSERT INTO workspace_ai_workflow_revisions VALUES (?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET workflow_id=excluded.workflow_id,version=excluded.version`).run(workspaceId, workflowId, item.version);
    return item;
  })();
}
export function cloneWorkflowVersion(workflowId, version, expectedDraftVersion) {
  return database().transaction(() => {
    const item = workflowVersion(workflowId, version);
    return { ...saveAssistantWorkflowDraft(workflowId, item.definition, expectedDraftVersion), clonedFromVersion: item.version };
  })();
}
