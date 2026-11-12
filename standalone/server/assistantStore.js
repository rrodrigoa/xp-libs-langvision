import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { starterPrimitiveAgent } from '../shared/primitiveAgentStarter.js';
import { encryptModelSecret, decryptModelSecret, validateModelConnection } from './modelConnection.js';

let assistantDb = null;

function workspaceDbPath() {
  const explicit = process.env.CHRONOSQL_WORKSPACE_DB ?? process.env.CHRONOSCOPE_WORKSPACE_DB;
  if (explicit) {
    return path.resolve(explicit);
  }

  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".chronosql");
  return path.join(base, "ChronosQL", "chronoscope-workspace.db");
}

export function assistantWorkspaceDbPath() {
  return workspaceDbPath();
}

export function assistantDebugDatabase() { return getDb(); }

export function assistantCheckpointDbPath() {
  return path.resolve(process.env.CHRONOSQL_ASSISTANT_CHECKPOINT_DB ?? `${workspaceDbPath()}.ai-checkpoints.db`);
}

function getDb() {
  if (!assistantDb) {
    const dbPath = workspaceDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    assistantDb = new Database(dbPath);
    assistantDb.pragma("busy_timeout = 5000");
    assistantDb.pragma("journal_mode = WAL");
  }
  ensureSchema(assistantDb);
  return assistantDb;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_workflow_definitions (
      workflow_id TEXT PRIMARY KEY, version INTEGER NOT NULL, definition_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_workflow_versions (
      workflow_id TEXT NOT NULL, version INTEGER NOT NULL, definition_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(workflow_id, version)
    );
    CREATE TABLE IF NOT EXISTS ai_workflow_version_labels (
      workflow_id TEXT NOT NULL, version INTEGER NOT NULL, label TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(workflow_id,version)
    );
    CREATE TABLE IF NOT EXISTS workspace_ai_workflows (
      workspace_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_workflow_drafts (
      workflow_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, definition_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_ai_workflow_revisions (
      workspace_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_profiles (
      profile_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL DEFAULT 120000,
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      num_ctx INTEGER NOT NULL DEFAULT 16384,
      temperature REAL NOT NULL DEFAULT 0,
      seed INTEGER NOT NULL DEFAULT 42,
      think INTEGER NOT NULL DEFAULT 0,
      thinking_mode TEXT NOT NULL DEFAULT 'off',
      keep_alive TEXT NOT NULL DEFAULT '30m',
      expected_digest TEXT,
      capability_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_ai_settings (
      workspace_id TEXT PRIMARY KEY,
      profile_id TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_ai_context_documents (
      workspace_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_ai_skills (
      skill_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'domain',
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, title)
    );
    CREATE TABLE IF NOT EXISTS ai_embedding_cache (
      content_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(content_hash, model)
    );
    CREATE TABLE IF NOT EXISTS ai_episodic_memory (
      memory_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      conversation_id TEXT,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      verified INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_conversations (
      conversation_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      current_surface TEXT NOT NULL DEFAULT 'creatio',
      state TEXT NOT NULL DEFAULT 'idle',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_messages (
      message_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      surface TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(conversation_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS ai_tool_calls (
      tool_call_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      message_id TEXT,
      tool_name TEXT NOT NULL,
      tool_version TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      risk TEXT NOT NULL,
      status TEXT NOT NULL,
      preview_json TEXT,
      result_json TEXT,
      error TEXT,
      expected_revision TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      approved_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_context_snapshots (
      context_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      manifest_version TEXT NOT NULL,
      context_hash TEXT NOT NULL,
      context_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      through_sequence INTEGER NOT NULL,
      summary TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_turns (
      turn_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      original_request TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_turn_tasks (
      task_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      title TEXT NOT NULL,
      surface TEXT NOT NULL,
      expected_tools_json TEXT NOT NULL,
      verification_tools_json TEXT NOT NULL DEFAULT '[]',
      recovery_tools_json TEXT NOT NULL DEFAULT '[]',
      required_action_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      repair_attempts INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      recovery_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      intent TEXT,
      dependencies_json TEXT NOT NULL DEFAULT '[]',
      required_facts_json TEXT NOT NULL DEFAULT '[]',
      success_criteria_json TEXT NOT NULL DEFAULT '[]',
      evidence_policy TEXT NOT NULL DEFAULT 'authoritative-tool-evidence',
      candidate_capabilities_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(turn_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS ai_task_tool_calls (
      task_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      PRIMARY KEY(task_id, tool_call_id)
    );
    CREATE TABLE IF NOT EXISTS ai_clarifications (
      clarification_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      task_id TEXT,
      prompt TEXT NOT NULL,
      options_json TEXT NOT NULL,
      recommendation TEXT,
      round INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      response TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ai_agent_reviews (
      review_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      turn_id TEXT,
      phase TEXT NOT NULL,
      model TEXT,
      source TEXT NOT NULL,
      review_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_audit_events (
      action_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL,
      surface TEXT,
      signature TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation ON ai_messages(conversation_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_ai_tools_conversation ON ai_tool_calls(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ai_context_conversation ON ai_context_snapshots(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ai_turns_conversation ON ai_turns(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ai_tasks_turn ON ai_turn_tasks(turn_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_ai_clarifications_conversation ON ai_clarifications(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ai_skills_workspace ON workspace_ai_skills(workspace_id, enabled, updated_at);
    CREATE INDEX IF NOT EXISTS idx_ai_memory_workspace ON ai_episodic_memory(workspace_id, verified, created_at);
    CREATE INDEX IF NOT EXISTS idx_ai_reviews_conversation ON ai_agent_reviews(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_audit_events ON workspace_audit_events(workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_audit_dedupe ON workspace_audit_events(workspace_id, kind, signature, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_audit_conversation ON workspace_audit_events(workspace_id, json_extract(metadata_json, '$.conversationId'), created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_audit_execution ON workspace_audit_events(workspace_id, json_extract(metadata_json, '$.executionId'), created_at);
  `);
  const taskColumns = new Set(db.pragma("table_info(ai_turn_tasks)").map(column => column.name));
  if (!taskColumns.has("verification_tools_json")) db.exec("ALTER TABLE ai_turn_tasks ADD COLUMN verification_tools_json TEXT NOT NULL DEFAULT '[]'");
  if (!taskColumns.has("recovery_tools_json")) db.exec("ALTER TABLE ai_turn_tasks ADD COLUMN recovery_tools_json TEXT NOT NULL DEFAULT '[]'");
  if (!taskColumns.has("attempt_count")) db.exec("ALTER TABLE ai_turn_tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0");
  if (!taskColumns.has("recovery_count")) db.exec("ALTER TABLE ai_turn_tasks ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0");
  if (!taskColumns.has("intent")) db.exec("ALTER TABLE ai_turn_tasks ADD COLUMN intent TEXT");
  if (!db.pragma('table_info(ai_turns)').some(column=>column.name==='current_task_id')) db.exec('ALTER TABLE ai_turns ADD COLUMN current_task_id TEXT');
  if (!taskColumns.has("dependencies_json")) db.exec("ALTER TABLE ai_turn_tasks ADD COLUMN dependencies_json TEXT NOT NULL DEFAULT '[]'");
  if (!taskColumns.has("required_facts_json")) db.exec("ALTER TABLE ai_turn_tasks ADD COLUMN required_facts_json TEXT NOT NULL DEFAULT '[]'");
  if (!taskColumns.has("success_criteria_json")) db.exec("ALTER TABLE ai_turn_tasks ADD COLUMN success_criteria_json TEXT NOT NULL DEFAULT '[]'");
  if (!taskColumns.has("evidence_policy")) db.exec("ALTER TABLE ai_turn_tasks ADD COLUMN evidence_policy TEXT NOT NULL DEFAULT 'authoritative-tool-evidence'");
  if (!taskColumns.has("candidate_capabilities_json")) db.exec("ALTER TABLE ai_turn_tasks ADD COLUMN candidate_capabilities_json TEXT NOT NULL DEFAULT '[]'");
  const profileColumns = new Set(db.pragma("table_info(ai_profiles)").map(column => column.name));
  if (!profileColumns.has("thinking_mode")) db.exec("ALTER TABLE ai_profiles ADD COLUMN thinking_mode TEXT NOT NULL DEFAULT 'off'");
  if (!profileColumns.has("connection_json")) db.exec("ALTER TABLE ai_profiles ADD COLUMN connection_json TEXT");
  if (!db.pragma('table_info(ai_clarifications)').some(column => column.name === 'presentation_json')) db.exec('ALTER TABLE ai_clarifications ADD COLUMN presentation_json TEXT');
  db.exec('CREATE TABLE IF NOT EXISTS ai_model_secrets (secret_id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL)');
}

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function profileRow(row) {
  return row ? {
    id: row.profile_id,
    displayName: row.display_name,
    baseUrl: row.base_url,
    model: row.model,
    timeoutMs: row.timeout_ms,
    maxConcurrency: row.max_concurrency,
    numCtx: row.num_ctx,
    temperature: row.temperature,
    seed: row.seed,
    think: Boolean(row.think),
    thinkingMode: row.thinking_mode || (row.think ? "on" : "off"),
    keepAlive: row.keep_alive,
    expectedDigest: row.expected_digest,
    capability: parseJson(row.capability_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...parseJson(row.connection_json, { provider: 'ollama' })
  } : null;
}

export function listAiProfiles() {
  return getDb().prepare("SELECT * FROM ai_profiles ORDER BY display_name, profile_id").all().map(profileRow);
}

export function getAiProfile(profileId) {
  return profileRow(getDb().prepare("SELECT * FROM ai_profiles WHERE profile_id = ?").get(profileId));
}

export function saveAiProfile(profile) {
  const db = getDb();
  const timestamp = now();
  const profileId = profile.id || id("profile");
  const previous = getAiProfile(profileId);
  const connection = validateModelConnection(profile);
  if (previous && profile.expectedUpdatedAt && previous.updatedAt !== profile.expectedUpdatedAt) throw Object.assign(new Error('Profile changed. Reload before saving.'), { status: 409 });
  connection.credentialReference = previous?.credentialReference ?? null;
  if (profile.clearApiKey || connection.authMode === 'none' || connection.apiKeySource === 'environment') connection.credentialReference = null;
  if (typeof profile.apiKey === 'string' && profile.apiKey && connection.authMode !== 'none' && connection.apiKeySource === 'value') {
    connection.credentialReference = id('model-secret');
    db.prepare('INSERT INTO ai_model_secrets VALUES (?,?)').run(connection.credentialReference, encryptModelSecret(profile.apiKey, workspaceDbPath()));
  }
  if (connection.authMode !== 'none' && connection.apiKeySource === 'value' && !connection.credentialReference) throw new Error('Enter an API key or choose an environment variable.');
  db.prepare(`
    INSERT INTO ai_profiles (
      profile_id, display_name, base_url, model, timeout_ms, max_concurrency,
      num_ctx, temperature, seed, think, thinking_mode, keep_alive, expected_digest, capability_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET
      display_name=excluded.display_name, base_url=excluded.base_url, model=excluded.model,
      timeout_ms=excluded.timeout_ms, max_concurrency=excluded.max_concurrency,
      num_ctx=excluded.num_ctx, temperature=excluded.temperature, seed=excluded.seed,
      think=excluded.think, thinking_mode=excluded.thinking_mode, keep_alive=excluded.keep_alive,
      expected_digest=excluded.expected_digest, capability_json=excluded.capability_json,
      updated_at=excluded.updated_at
  `).run(
    profileId,
    profile.displayName || "Local Ollama",
    profile.baseUrl,
    profile.model,
    profile.timeoutMs ?? 120000,
    profile.maxConcurrency ?? 1,
    profile.numCtx ?? 16384,
    profile.temperature ?? 0,
    profile.seed ?? 42,
    profile.think ? 1 : 0,
    profile.thinkingMode ?? (profile.think ? "on" : "off"),
    profile.keepAlive ?? "30m",
    profile.expectedDigest ?? null,
    profile.capability ? JSON.stringify(profile.capability) : null,
    timestamp,
    timestamp
  );
  db.prepare('UPDATE ai_profiles SET connection_json=? WHERE profile_id=?').run(JSON.stringify(connection), profileId);
  return getAiProfile(profileId);
}

// Inference resolves literal credentials here, never through public profile APIs or graph state.
export function modelConnectionForProfile(profile) {
  const connection = validateModelConnection(profile);
  if (profile.credentialReference && connection.authMode !== 'none' && connection.apiKeySource === 'value') {
    const secret = getDb().prepare('SELECT ciphertext FROM ai_model_secrets WHERE secret_id=?').get(profile.credentialReference);
    if (!secret) throw new Error('The saved model credential is unavailable. Re-enter the API key.');
    connection.apiKey = decryptModelSecret(secret.ciphertext, workspaceDbPath());
  }
  return connection;
}

export function deleteAiProfile(profileId) {
  const db = getDb();
  db.prepare("UPDATE workspace_ai_settings SET profile_id = NULL WHERE profile_id = ?").run(profileId);
  return db.prepare("DELETE FROM ai_profiles WHERE profile_id = ?").run(profileId).changes > 0;
}

export function selectWorkspaceAiProfile(workspaceId, profileId) {
  const timestamp = now();
  getDb().prepare(`
    INSERT INTO workspace_ai_settings(workspace_id, profile_id, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET profile_id=excluded.profile_id, updated_at=excluded.updated_at
  `).run(workspaceId, profileId, timestamp);
  return getWorkspaceAiProfile(workspaceId);
}

export function getWorkspaceAiProfile(workspaceId) {
  const row = getDb().prepare(`
    SELECT p.* FROM workspace_ai_settings s
    JOIN ai_profiles p ON p.profile_id = s.profile_id
    WHERE s.workspace_id = ?
  `).get(workspaceId);
  return profileRow(row) ?? listAiProfiles()[0] ?? null;
}

function workspaceContextRow(row) {
  return row ? {
    workspaceId: row.workspace_id,
    title: row.title,
    content: row.content,
    contentHash: row.content_hash,
    version: row.version,
    updatedAt: row.updated_at
  } : null;
}

export function getWorkspaceAiContext(workspaceId) {
  return workspaceContextRow(getDb().prepare(
    "SELECT * FROM workspace_ai_context_documents WHERE workspace_id = ?").get(workspaceId));
}

export function saveWorkspaceAiContext(workspaceId, document = {}) {
  const title = String(document.title ?? "Workspace domain context").trim().slice(0, 120) || "Workspace domain context";
  const content = String(document.content ?? "").replace(/\r\n?/g, "\n").trim();
  if (!content) throw new Error("Workspace AI context cannot be empty.");
  if (content.length > 20_000) throw new Error("Workspace AI context cannot exceed 20,000 characters.");
  const contentHash = createHash("sha256").update(`${title}\n${content}`, "utf8").digest("hex");
  const existing = getWorkspaceAiContext(workspaceId);
  getDb().prepare(`
    INSERT INTO workspace_ai_context_documents
      (workspace_id, title, content, content_hash, version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      title=excluded.title,
      content=excluded.content,
      content_hash=excluded.content_hash,
      version=excluded.version,
      updated_at=excluded.updated_at
  `).run(workspaceId, title, content, contentHash, (existing?.version ?? 0) + 1, now());
  return getWorkspaceAiContext(workspaceId);
}

export function deleteWorkspaceAiContext(workspaceId) {
  return getDb().prepare("DELETE FROM workspace_ai_context_documents WHERE workspace_id = ?").run(workspaceId).changes > 0;
}

function workspaceSkillRow(row) {
  return row ? {
    id: row.skill_id,
    workspaceId: row.workspace_id,
    title: row.title,
    kind: row.kind,
    content: row.content,
    contentHash: row.content_hash,
    version: row.version,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trust: "user-authored-untrusted-domain-guidance"
  } : null;
}

export function listWorkspaceAiSkills(workspaceId, { enabledOnly = true } = {}) {
  const rows = getDb().prepare(`SELECT * FROM workspace_ai_skills WHERE workspace_id = ?
    ${enabledOnly ? "AND enabled = 1" : ""} ORDER BY title, skill_id`).all(workspaceId);
  const skills = rows.map(workspaceSkillRow);
  const legacy = getWorkspaceAiContext(workspaceId);
  if (legacy && !skills.some(skill => skill.title === legacy.title)) {
    skills.unshift({ ...legacy, id: `legacy:${workspaceId}`, workspaceId, kind: "domain", enabled: true, trust: "user-authored-untrusted-domain-guidance" });
  }
  return skills;
}

export function saveWorkspaceAiSkill(workspaceId, skill = {}) {
  const content = String(skill.content ?? "").trim();
  const title = String(skill.title ?? "").trim();
  const kind = String(skill.kind ?? "domain").trim().toLowerCase();
  if (!title || title.length > 120) throw new Error("Workspace skill title must contain 1 to 120 characters.");
  if (!content || content.length > 20_000) throw new Error("Workspace skill Markdown must contain 1 to 20,000 characters.");
  if (!["domain", "workflow", "terminology", "preference"].includes(kind)) throw new Error("Workspace skill kind is unsupported.");
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)?.[1] ?? "";
  if (/^\s*(?:tool|tools|capability|capabilities|risk|permission|permissions|approval|schema|executor)\s*:/im.test(frontmatter)) {
    throw new Error("Workspace skills may describe domain knowledge and preferences, but cannot define tools, schemas, permissions, risks, approvals, or executors.");
  }
  const db = getDb();
  const existing = skill.id ? db.prepare("SELECT * FROM workspace_ai_skills WHERE skill_id = ? AND workspace_id = ?").get(skill.id, workspaceId) : null;
  const skillId = existing?.skill_id ?? id("skill");
  const timestamp = now();
  const contentHash = createHash("sha256").update(content).digest("hex");
  db.prepare(`INSERT INTO workspace_ai_skills(skill_id, workspace_id, title, kind, content, content_hash, version, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(skill_id) DO UPDATE SET title=excluded.title, kind=excluded.kind, content=excluded.content,
      content_hash=excluded.content_hash, version=workspace_ai_skills.version + 1, enabled=excluded.enabled, updated_at=excluded.updated_at`)
    .run(skillId, workspaceId, title, kind, content, contentHash, existing ? existing.version : 1, skill.enabled === false ? 0 : 1, existing?.created_at ?? timestamp, timestamp);
  return workspaceSkillRow(db.prepare("SELECT * FROM workspace_ai_skills WHERE skill_id = ?").get(skillId));
}

export function deleteWorkspaceAiSkill(workspaceId, skillId) {
  return getDb().prepare("DELETE FROM workspace_ai_skills WHERE workspace_id = ? AND skill_id = ?").run(workspaceId, skillId).changes > 0;
}

export function getCachedAssistantEmbedding(contentHash, model) {
  const row = getDb().prepare("SELECT * FROM ai_embedding_cache WHERE content_hash = ? AND model = ?").get(contentHash, model);
  return row ? parseJson(row.embedding_json, []) : null;
}

export function saveCachedAssistantEmbedding(contentHash, model, embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0 || embedding.some(value => !Number.isFinite(Number(value)))) {
    throw new Error("Assistant embedding is invalid.");
  }
  getDb().prepare(`INSERT INTO ai_embedding_cache(content_hash, model, embedding_json, dimensions, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(content_hash, model) DO UPDATE SET embedding_json=excluded.embedding_json,
      dimensions=excluded.dimensions, created_at=excluded.created_at`)
    .run(contentHash, model, JSON.stringify(embedding), embedding.length, now());
  return embedding;
}

export function listVerifiedAssistantMemory(workspaceId, limit = 40) {
  return getDb().prepare(`SELECT * FROM ai_episodic_memory WHERE workspace_id = ? AND verified = 1
    ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(workspaceId, Math.max(1, Math.min(100, limit))).map(row => ({
      id: row.memory_id, workspaceId: row.workspace_id, conversationId: row.conversation_id, kind: row.kind,
      summary: row.summary, evidence: parseJson(row.evidence_json, []), verified: true, contentHash: row.content_hash,
      createdAt: row.created_at, trust: "verified-episodic-memory"
    }));
}

export function getAssistantConversationSummary(conversationId) {
  const row = getDb().prepare("SELECT * FROM ai_conversation_summaries WHERE conversation_id = ?").get(conversationId);
  return row ? { conversationId, throughSequence: row.through_sequence, summary: row.summary, updatedAt: row.updated_at } : null;
}

export function createConversation({ workspaceId, title = "Consilium AI Assitant", surface = "creatio" }) {
  const db = getDb();
  const conversationId = id("conversation");
  const timestamp = now();
  db.prepare(`INSERT INTO ai_conversations
    (conversation_id, workspace_id, title, current_surface, state, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'idle', 0, ?, ?)`)
    .run(conversationId, workspaceId, title, surface, timestamp, timestamp);
  return getConversation(conversationId);
}

export function getConversation(conversationId) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM ai_conversations WHERE conversation_id = ?").get(conversationId);
  if (!row) return null;
  return {
    id: row.conversation_id,
    workspaceId: row.workspace_id,
    title: row.title,
    currentSurface: row.current_surface,
    state: row.state,
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: listMessages(conversationId),
    toolCalls: listToolCalls(conversationId),
    turns: listAssistantTurns(conversationId),
    reviews: listAssistantAgentReviews(conversationId),
    clarification: pendingAssistantClarification(conversationId)
  };
}

export function listAssistantAgentReviews(conversationId) {
  return getDb().prepare("SELECT * FROM ai_agent_reviews WHERE conversation_id = ? ORDER BY created_at, rowid")
    .all(conversationId).map(row => ({
      id: row.review_id,
      conversationId: row.conversation_id,
      turnId: row.turn_id,
      phase: row.phase,
      model: row.model,
      source: row.source,
      review: parseJson(row.review_json, {}),
      createdAt: row.created_at
    }));
}

function assistantTaskRow(row) {
  return row ? {
    id: row.task_id,
    turnId: row.turn_id,
    ordinal: row.ordinal,
    title: row.title,
    surface: row.surface,
    expectedTools: parseJson(row.expected_tools_json, []),
    verificationTools: parseJson(row.verification_tools_json, []),
    recoveryTools: parseJson(row.recovery_tools_json, []),
    requiredActionCount: row.required_action_count,
    status: row.status,
    repairAttempts: row.repair_attempts,
    attemptCount: row.attempt_count,
    recoveryCount: row.recovery_count,
    error: row.error,
    intent: row.intent,
    dependencies: parseJson(row.dependencies_json, []),
    requiredFacts: parseJson(row.required_facts_json, []),
    successCriteria: parseJson(row.success_criteria_json, []),
    evidencePolicy: row.evidence_policy,
    candidateCapabilities: parseJson(row.candidate_capabilities_json, []),
    toolCallIds: getDb().prepare("SELECT tool_call_id FROM ai_task_tool_calls WHERE task_id = ? ORDER BY created_at")
      .all(row.task_id).map(item => item.tool_call_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}

export function getAssistantTask(taskId) {
  return assistantTaskRow(getDb().prepare("SELECT * FROM ai_turn_tasks WHERE task_id = ?").get(taskId));
}

export function getAssistantTurn(turnId) {
  const row = getDb().prepare("SELECT * FROM ai_turns WHERE turn_id = ?").get(turnId);
  return row ? {
    id: row.turn_id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    originalRequest: row.original_request,
    currentTaskId: row.current_task_id ?? null,
    status: row.status,
    tasks: getDb().prepare("SELECT * FROM ai_turn_tasks WHERE turn_id = ? ORDER BY ordinal").all(turnId).map(assistantTaskRow),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}

export function listAssistantTurns(conversationId, limit = 20) {
  return getDb().prepare("SELECT turn_id FROM ai_turns WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(conversationId, limit).map(row => getAssistantTurn(row.turn_id)).reverse();
}

export function createAssistantTurn({ conversationId, userMessageId, originalRequest, tasks }) {
  const db = getDb();
  const turnId = id("turn");
  const timestamp = now();
  const transaction = db.transaction(() => {
    db.prepare(`INSERT INTO ai_turns(turn_id, conversation_id, user_message_id, original_request, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)`).run(turnId, conversationId, userMessageId, originalRequest, timestamp, timestamp);
    const insert = db.prepare(`INSERT INTO ai_turn_tasks(
      task_id, turn_id, ordinal, title, surface, expected_tools_json, verification_tools_json, recovery_tools_json,
      required_action_count, status, repair_attempts, attempt_count, recovery_count, intent, dependencies_json,
      required_facts_json, success_criteria_json, evidence_policy, candidate_capabilities_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)`);
    tasks.forEach((task, index) => insert.run(
      task.id?.startsWith(`${turnId}-objective-`)?task.id:id("task"), turnId, task.ordinal ?? index + 1, task.title, task.surface,
      JSON.stringify(task.expectedTools ?? []), JSON.stringify(task.verificationTools ?? []), JSON.stringify(task.recoveryTools ?? []), task.requiredActionCount ?? 0,
      index === 0 ? (task.status ?? "active") : (task.status ?? "pending"), task.intent ?? null,
      JSON.stringify(task.dependencies ?? []), JSON.stringify(task.requiredFacts ?? []), JSON.stringify(task.successCriteria ?? []),
      task.evidencePolicy ?? "authoritative-tool-evidence", JSON.stringify(task.candidateCapabilities ?? task.expectedTools ?? []), timestamp, timestamp));
  });
  transaction();
  return getAssistantTurn(turnId);
}

export function activeAssistantTask(turnId) {
  const row = getDb().prepare(`SELECT * FROM ai_turn_tasks WHERE turn_id = ?
    AND status IN ('active','awaiting-approval','awaiting-clarification','executing','recovering','verifying') ORDER BY ordinal LIMIT 1`).get(turnId);
  return assistantTaskRow(row);
}

export function updateAssistantTask(taskId, status, { error, incrementRepair = false, incrementAttempt = false, incrementRecovery = false } = {}) {
  getDb().prepare(`UPDATE ai_turn_tasks SET status = ?, error = ?,
    repair_attempts = repair_attempts + ?, attempt_count = attempt_count + ?, recovery_count = recovery_count + ?, updated_at = ? WHERE task_id = ?`)
    .run(status, error ?? null, incrementRepair ? 1 : 0, incrementAttempt ? 1 : 0, incrementRecovery ? 1 : 0, now(), taskId);
  const task = getAssistantTask(taskId);
  if (task) getDb().prepare("UPDATE ai_turns SET updated_at = ? WHERE turn_id = ?").run(now(), task.turnId);
  return task;
}

export function linkAssistantTaskToolCall(taskId, toolCallId) {
  getDb().prepare("INSERT OR IGNORE INTO ai_task_tool_calls(task_id, tool_call_id, created_at) VALUES (?, ?, ?)")
    .run(taskId, toolCallId, now());
  return getAssistantTask(taskId);
}

export function assistantTaskForToolCall(toolCallId) {
  const row = getDb().prepare(`SELECT t.* FROM ai_turn_tasks t JOIN ai_task_tool_calls l ON l.task_id = t.task_id
    WHERE l.tool_call_id = ?`).get(toolCallId);
  return assistantTaskRow(row);
}

export function assistantTaskToolCalls(taskId) {
  return getDb().prepare("SELECT tool_call_id FROM ai_task_tool_calls WHERE task_id = ? ORDER BY created_at, rowid")
    .all(taskId).map(row => getToolCall(row.tool_call_id));
}

export function completedAssistantTaskActionCount(task) {
  const expected = new Set(task?.expectedTools ?? []);
  const completed = assistantTaskToolCalls(task.id).filter(call => call.status === "completed" && expected.has(call.name));
  const identities = completed.map(call => {
    if (call.name === "figura.create_panel") return `${call.name}:${call.result?.spec?.id ?? call.arguments?.panelId ?? call.id}`;
    if (call.name === "speculum.add_widget") return `${call.name}:${call.result?.widget?.id ?? call.arguments?.widgetType ?? call.id}`;
    if (call.name === "creatio.add_connection") {
      return `${call.name}:${call.arguments?.direction ?? ""}:${call.arguments?.name ?? call.id}`;
    }
    return call.id;
  });
  return new Set(identities).size;
}

export function assistantTaskProgress(task) {
  const calls = assistantTaskToolCalls(task.id);
  const completedActionCount = completedAssistantTaskActionCount(task);
  const expected = new Set(task?.expectedTools ?? []);
  const latestActionAt = calls
    .filter(call => call.status === "completed" && expected.has(call.name))
    .map(call => call.completedAt ?? call.createdAt)
    .sort()
    .at(-1) ?? null;
  const completedVerificationTools = new Set(calls
    .filter(call => call.status === "completed"
      && (task?.verificationTools ?? []).includes(call.name)
      && (!latestActionAt || (call.completedAt ?? call.createdAt) >= latestActionAt))
    .map(call => call.name));
  const missingVerificationTools = (task?.verificationTools ?? []).filter(tool => !completedVerificationTools.has(tool));
  return {
    completedActionCount,
    missingVerificationTools,
    satisfied: completedActionCount >= Number(task?.requiredActionCount ?? 0) && missingVerificationTools.length === 0
  };
}

export function setAssistantTurnStatus(turnId, status) {
  getDb().prepare("UPDATE ai_turns SET status = ?, updated_at = ? WHERE turn_id = ?").run(status, now(), turnId);
  return getAssistantTurn(turnId);
}

function clarificationRow(row) {
  return row ? {
    id: row.clarification_id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    taskId: row.task_id,
    prompt: row.prompt,
    options: parseJson(row.options_json, []),
    recommendation: row.recommendation,
    round: row.round,
    status: row.status,
    response: row.response,
    presentation: parseJson(row.presentation_json),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  } : null;
}

export function createAssistantClarification({ conversationId, turnId, taskId = null, prompt, options, recommendation = null, round = 1, presentation = null }) {
  const clarificationId = id("clarification");
  getDb().prepare(`INSERT INTO ai_clarifications(
    clarification_id, conversation_id, turn_id, task_id, prompt, options_json, recommendation, round, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(clarificationId, conversationId, turnId, taskId, prompt, JSON.stringify(options ?? []), recommendation, round, now());
  if (presentation) getDb().prepare('UPDATE ai_clarifications SET presentation_json=? WHERE clarification_id=?').run(JSON.stringify(presentation), clarificationId);
  setAssistantTurnStatus(turnId, "awaiting-clarification");
  if (taskId) updateAssistantTask(taskId, "awaiting-clarification");
  setConversationState(conversationId, "awaiting-clarification");
  return getAssistantClarification(clarificationId);
}

export function getAssistantClarification(clarificationId) {
  return clarificationRow(getDb().prepare("SELECT * FROM ai_clarifications WHERE clarification_id = ?").get(clarificationId));
}

export function pendingAssistantClarification(conversationId) {
  return clarificationRow(getDb().prepare(`SELECT * FROM ai_clarifications
    WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(conversationId));
}

export function listAssistantClarifications(turnId) {
  return getDb().prepare("SELECT * FROM ai_clarifications WHERE turn_id = ? ORDER BY round, created_at, rowid")
    .all(turnId).map(clarificationRow);
}

export function resolveAssistantClarification(clarificationId, response) {
  getDb().prepare("UPDATE ai_clarifications SET status = 'resolved', response = ?, resolved_at = ? WHERE clarification_id = ? AND status = 'pending'")
    .run(String(response ?? "").trim(), now(), clarificationId);
  return getAssistantClarification(clarificationId);
}

export function cancelAssistantConversationWork(conversationId) {
  const db = getDb();
  const timestamp = now();
  const transaction = db.transaction(() => {
    const turns = db.prepare(`UPDATE ai_turns SET status = 'canceled', updated_at = ?
      WHERE conversation_id = ? AND status IN ('active','awaiting-approval','awaiting-clarification','generating','needs-attention')`)
      .run(timestamp, conversationId).changes;
    const tasks = db.prepare(`UPDATE ai_turn_tasks SET status = 'canceled', error = NULL, updated_at = ?
      WHERE turn_id IN (SELECT turn_id FROM ai_turns WHERE conversation_id = ?)
        AND status IN ('pending','active','awaiting-approval','awaiting-clarification','executing','recovering','verifying')`)
      .run(timestamp, conversationId).changes;
    const tools = db.prepare(`UPDATE ai_tool_calls SET status = 'canceled', error = 'Canceled by the user.', completed_at = ?
      WHERE conversation_id = ? AND status IN ('pending','executing')`)
      .run(timestamp, conversationId).changes;
    return turns + tasks + tools;
  });
  return transaction();
}

export function listConversations(workspaceId) {
  return getDb().prepare(`SELECT conversation_id FROM ai_conversations
    WHERE workspace_id = ? AND archived = 0 ORDER BY updated_at DESC`).all(workspaceId)
    .map(row => getConversation(row.conversation_id));
}

export function setConversationState(conversationId, state, surface) {
  getDb().prepare(`UPDATE ai_conversations SET state = ?, current_surface = COALESCE(?, current_surface), updated_at = ?
    WHERE conversation_id = ?`).run(state, surface ?? null, now(), conversationId);
}

export function archiveConversation(conversationId) {
  getDb().prepare("UPDATE ai_conversations SET archived = 1, state = 'archived', updated_at = ? WHERE conversation_id = ?")
    .run(now(), conversationId);
}

export function addMessage(conversationId, role, content, surface, payload = null) {
  const db = getDb();
  const sequence = db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM ai_messages WHERE conversation_id = ?")
    .get(conversationId).next;
  const messageId = id("message");
  db.prepare(`INSERT INTO ai_messages
    (message_id, conversation_id, sequence, role, content, surface, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(messageId, conversationId, sequence, role, content ?? null, surface ?? null, payload ? JSON.stringify(payload) : null, now());
  return listMessages(conversationId).find(message => message.id === messageId);
}

export function listMessages(conversationId, limit = 60) {
  return getDb().prepare(`SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY sequence DESC LIMIT ?`)
    .all(conversationId, limit).reverse().map(row => ({
      id: row.message_id,
      sequence: row.sequence,
      role: row.role,
      content: row.content,
      surface: row.surface,
      payload: parseJson(row.payload_json),
      createdAt: row.created_at
    }));
}

export function saveContextSnapshot(conversationId, manifestVersion, context) {
  const serialized = JSON.stringify(context);
  const contextId = id("context");
  const hash = crypto.createHash("sha256").update(serialized).digest("hex");
  getDb().prepare(`INSERT INTO ai_context_snapshots
    (context_id, conversation_id, manifest_version, context_hash, context_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(contextId, conversationId, manifestVersion, hash, serialized, now());
  return { id: contextId, hash, manifestVersion, context };
}

export function latestContextSnapshot(conversationId) {
  const row = getDb().prepare(`SELECT * FROM ai_context_snapshots WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(conversationId);
  return row ? {
    id: row.context_id,
    hash: row.context_hash,
    manifestVersion: row.manifest_version,
    context: parseJson(row.context_json),
    createdAt: row.created_at
  } : null;
}

export function createToolCall({ conversationId, messageId, capability, args, preview, expectedRevision, requiresApproval = null }) {
  const db = getDb();
  const serializedArgs = JSON.stringify(args ?? {});
  const key = crypto.createHash("sha256")
    .update(`${conversationId}\u241f${capability.name}\u241f${serializedArgs}\u241f${messageId ?? ""}`)
    .digest("hex");
  const existing = db.prepare("SELECT tool_call_id FROM ai_tool_calls WHERE idempotency_key = ?").get(key);
  if (existing) return getToolCall(existing.tool_call_id);
  const toolCallId = id("tool");
  db.prepare(`INSERT INTO ai_tool_calls
    (tool_call_id, conversation_id, message_id, tool_name, tool_version, arguments_json,
     risk, status, preview_json, expected_revision, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      toolCallId, conversationId, messageId ?? null, capability.name, capability.version,
      serializedArgs, capability.risk, (requiresApproval ?? !['read', 'navigate'].includes(capability.risk)) ? 'pending' : 'executing',
      JSON.stringify(preview ?? {}), expectedRevision ?? null, key, now());
  return getToolCall(toolCallId);
}

export function getToolCall(toolCallId) {
  const row = getDb().prepare("SELECT * FROM ai_tool_calls WHERE tool_call_id = ?").get(toolCallId);
  return row ? {
    id: row.tool_call_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    name: row.tool_name,
    version: row.tool_version,
    arguments: parseJson(row.arguments_json, {}),
    risk: row.risk,
    status: row.status,
    preview: parseJson(row.preview_json, {}),
    result: parseJson(row.result_json),
    error: row.error,
    expectedRevision: row.expected_revision,
    idempotencyKey: row.idempotency_key,
    approvedAt: row.approved_at,
    completedAt: row.completed_at,
    createdAt: row.created_at
  } : null;
}

export function listToolCalls(conversationId) {
  return getDb().prepare("SELECT tool_call_id FROM ai_tool_calls WHERE conversation_id = ? ORDER BY created_at, rowid")
    .all(conversationId).map(row => getToolCall(row.tool_call_id));
}

export function listWorkspaceToolCalls(workspaceId, { limit = 80, before = null } = {}) {
  return getDb().prepare(`SELECT tc.tool_call_id, m.surface
    FROM ai_tool_calls tc
    JOIN ai_conversations c ON c.conversation_id = tc.conversation_id
    LEFT JOIN ai_messages m ON m.message_id = tc.message_id
    WHERE c.workspace_id = ?
      AND (? IS NULL OR tc.created_at < ? OR (tc.created_at = ? AND ('tool:' || tc.tool_call_id) < ?))
    ORDER BY tc.created_at DESC, tc.tool_call_id DESC
    LIMIT ?`).all(
      workspaceId,
      before?.timestamp ?? null,
      before?.timestamp ?? null,
      before?.timestamp ?? null,
      before?.id ?? null,
      Math.max(10, Math.min(200, Number(limit) || 80)))
    .map(row => ({ ...getToolCall(row.tool_call_id), surface: row.surface ?? null }));
}

export function getWorkspaceToolCall(workspaceId, toolCallId) {
  const row = getDb().prepare(`SELECT tc.tool_call_id, m.surface
    FROM ai_tool_calls tc
    JOIN ai_conversations c ON c.conversation_id = tc.conversation_id
    LEFT JOIN ai_messages m ON m.message_id = tc.message_id
    WHERE c.workspace_id = ? AND tc.tool_call_id = ?`).get(workspaceId, toolCallId);
  return row ? { ...getToolCall(row.tool_call_id), surface: row.surface ?? null } : null;
}

function workspaceAuditRow(row) {
  return row ? {
    id: row.action_id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    status: row.status,
    surface: row.surface,
    signature: row.signature,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at
  } : null;
}

export function recordWorkspaceAuditEvent({
  workspaceId = "default",
  kind,
  title,
  summary,
  status = "failed",
  surface = null,
  signature,
  metadata = {},
  dedupeMs = 300000
}) {
  const cutoff = new Date(Date.now() - dedupeMs).toISOString();
  const existing = getDb().prepare(`SELECT * FROM workspace_audit_events
    WHERE workspace_id = ? AND kind = ? AND signature = ? AND created_at >= ?
    ORDER BY created_at DESC LIMIT 1`).get(workspaceId, kind, signature, cutoff);
  if (existing) return { ...workspaceAuditRow(existing), deduplicated: true };
  const actionId = id("audit");
  getDb().prepare(`INSERT INTO workspace_audit_events(
    action_id, workspace_id, kind, title, summary, status, surface, signature, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(actionId, workspaceId, kind, title, summary, status, surface, signature, JSON.stringify(metadata), now());
  return { ...getWorkspaceAuditEvent(workspaceId, actionId), deduplicated: false };
}

export function listWorkspaceAuditEvents(workspaceId, { limit = 80, before = null, historyType = 'all' } = {}) {
  return getDb().prepare(`SELECT * FROM workspace_audit_events
    WHERE workspace_id = ?
      AND (? = 'all' OR ((kind LIKE 'agent-%' OR kind LIKE 'assistant-%' OR kind LIKE 'ai-%' OR kind LIKE 'query-translation-%' OR kind IN ('agent','assistant','ai','query-translation')) = (? = 'ai')))
      AND (? IS NULL OR created_at < ? OR (created_at = ? AND ('audit:' || action_id) < ?))
    ORDER BY created_at DESC, action_id DESC LIMIT ?`).all(
      workspaceId,
      historyType, historyType,
      before?.timestamp ?? null,
      before?.timestamp ?? null,
      before?.timestamp ?? null,
      before?.id ?? null,
      Math.max(10, Math.min(200, Number(limit) || 80)))
    .map(workspaceAuditRow);
}

export function getWorkspaceAuditEvent(workspaceId, actionId) {
  return workspaceAuditRow(getDb().prepare(`SELECT * FROM workspace_audit_events
    WHERE workspace_id = ? AND action_id = ?`).get(workspaceId, actionId));
}

export function getAssistantExecutionTrace(workspaceId, actionId, { after = 0, limit = 60 } = {}) {
  const db = getDb();
  const event = getWorkspaceAuditEvent(workspaceId, actionId);
  if (event?.metadata?.executionId && event.kind.startsWith('query-translation')) {
    const executionId = event.metadata.executionId;
    const take = Math.max(10, Math.min(100, Number(limit) || 60));
    const rows = db.prepare(`SELECT rowid AS audit_sequence, * FROM workspace_audit_events WHERE workspace_id = ? AND json_extract(metadata_json, '$.executionId') = ? AND rowid > ? ORDER BY rowid LIMIT ?`).all(workspaceId, executionId, Math.max(0, Number(after) || 0), take + 1);
    const start = db.prepare(`SELECT * FROM workspace_audit_events WHERE workspace_id = ? AND json_extract(metadata_json, '$.executionId') = ? AND json_extract(metadata_json, '$.workflowDefinition') IS NOT NULL ORDER BY rowid LIMIT 1`).get(workspaceId, executionId);
    const end = db.prepare(`SELECT * FROM workspace_audit_events WHERE workspace_id = ? AND json_extract(metadata_json, '$.executionId') = ? ORDER BY rowid DESC LIMIT 1`).get(workspaceId, executionId);
    const initial = parseJson(start?.metadata_json, {}); const final = parseJson(end?.metadata_json, {});
    const pinned=initial.workflowId&&initial.workflowVersion?db.prepare('SELECT definition_json FROM ai_workflow_versions WHERE workflow_id=? AND version=?').get(initial.workflowId,initial.workflowVersion):null;
    const events = rows.slice(0, take).map(row => ({ ...workspaceAuditRow(row), sequence: row.audit_sequence }));
    return { executionId, status: end?.status, workflow: pinned ? { id: initial.workflowId, version: initial.workflowVersion, definition: JSON.parse(pinned.definition_json) } : initial.workflowDefinition && !JSON.stringify(initial.workflowDefinition).includes('[bounded]') ? { id: initial.workflowId ?? 'query-translation', version: initial.workflowVersion ?? 1, definition: initial.workflowDefinition } : null,
      events, messages: [{ id: `${executionId}:input`, role: 'user', content: initial.input?.direction === 'ai-to-query' ? initial.input?.intent : initial.input?.sql, createdAt: start?.created_at },
        ...(final.output ? [{ id: `${executionId}:output`, role: 'assistant', content: `${final.output.description}\n\n${final.output.sql}`, createdAt: end.created_at }] : [])],
      tools: [], reviews: [], tasks: [], reasoningPolicy: 'Conversation messages exclude provider thinking. Opt-in raw debug artifacts may contain provider-returned thinking. Translation candidates and compiler diagnostics are recorded.', hasMore: rows.length > take, nextCursor: rows.length > take ? events.at(-1).sequence : null };
  }
  const call = event ? null : getWorkspaceToolCall(workspaceId, actionId);
  const task = call ? assistantTaskForToolCall(call.id) : null;
  const conversationId = event?.metadata?.conversationId ?? call?.conversationId;
  if (!conversationId || !db.prepare('SELECT 1 FROM ai_conversations WHERE conversation_id = ? AND workspace_id = ?').get(conversationId, workspaceId)) return null;
  let turn = task ? getAssistantTurn(task.turnId) : event?.metadata?.turnId ? getAssistantTurn(event.metadata.turnId) : null;
  if (!turn) {
    const row = db.prepare(`SELECT t.turn_id FROM ai_turns t JOIN ai_messages m ON m.message_id = t.user_message_id
      WHERE t.conversation_id = ? AND (? IS NULL OR t.user_message_id = ?) AND m.created_at <= ? ORDER BY m.sequence DESC LIMIT 1`)
      .get(conversationId, event?.metadata?.userMessageId ?? null, event?.metadata?.userMessageId ?? null, event?.createdAt ?? now());
    turn = row ? getAssistantTurn(row.turn_id) : null;
  }
  if (!turn && event?.metadata?.userMessageId) {
    const user = db.prepare("SELECT * FROM ai_messages WHERE message_id = ? AND conversation_id = ? AND role = 'user'").get(event.metadata.userMessageId, conversationId);
    if (user) turn = { id: null, userMessageId: user.message_id, conversationId, tasks: [], status: db.prepare('SELECT state FROM ai_conversations WHERE conversation_id = ?').get(conversationId).state };
  }
  if (!turn || turn.conversationId !== conversationId) return null;
  const userMessage = db.prepare('SELECT * FROM ai_messages WHERE message_id = ?').get(turn.userMessageId);
  if (!userMessage) return null;
  const nextUser = db.prepare(`SELECT m.created_at FROM ai_turns t JOIN ai_messages m ON m.message_id = t.user_message_id WHERE t.conversation_id = ? AND m.sequence > ? ORDER BY m.sequence LIMIT 1`).get(conversationId, userMessage.sequence);
  const take = Math.max(10, Math.min(100, Number(limit) || 60));
  const rows = db.prepare(`SELECT rowid AS audit_sequence, * FROM workspace_audit_events WHERE workspace_id = ?
    AND json_extract(metadata_json, '$.conversationId') = ? AND rowid > ?
    AND (json_extract(metadata_json, '$.turnId') = ? OR json_extract(metadata_json, '$.userMessageId') = ?
      OR (json_extract(metadata_json, '$.turnId') IS NULL AND json_extract(metadata_json, '$.userMessageId') IS NULL AND created_at >= ? AND (? IS NULL OR created_at < ?)))
    ORDER BY rowid LIMIT ?`).all(workspaceId, conversationId, Math.max(0, Number(after) || 0), turn.id, turn.userMessageId, userMessage.created_at, nextUser?.created_at ?? null, nextUser?.created_at ?? null, take + 1);
  const events = rows.slice(0, take).map(row => ({ ...workspaceAuditRow(row), sequence: row.audit_sequence }));
  const graphReference = db.prepare(`SELECT metadata_json FROM workspace_audit_events WHERE workspace_id = ? AND json_extract(metadata_json, '$.conversationId') = ?
    AND (json_extract(metadata_json, '$.turnId') = ? OR json_extract(metadata_json, '$.userMessageId') = ?) AND json_extract(metadata_json, '$.graphVersion') IS NOT NULL ORDER BY rowid LIMIT 1`).get(workspaceId, conversationId, turn.id, turn.userMessageId);
  const graphVersion = parseJson(graphReference?.metadata_json, {}).graphVersion ?? event?.metadata?.graphVersion ?? (event?.metadata?.workflowId ? `${event.metadata.workflowId}@${event.metadata.workflowVersion ?? event.metadata.version}` : null);
  const version = /^(.*)@(\d+)$/.exec(graphVersion ?? '');
  const workflow = version ? db.prepare('SELECT * FROM ai_workflow_versions WHERE workflow_id = ? AND version = ?').get(version[1], Number(version[2])) : null;
  const messages = db.prepare(`SELECT * FROM ai_messages WHERE conversation_id = ? AND role IN ('user','assistant')
    AND (message_id = ? OR json_extract(payload_json, '$.turnId') = ? OR json_extract(payload_json, '$.userMessageId') = ?) ORDER BY sequence LIMIT 100`).all(conversationId, turn.userMessageId, turn.id, turn.userMessageId).map(row => ({ id: row.message_id, role: row.role, content: String(row.content ?? '').slice(0, 16000), truncated: String(row.content ?? '').length > 16000, createdAt: row.created_at }));
  const hasOwners = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_debug_tool_owners'").get();
  const tools = db.prepare(`SELECT DISTINCT c.* FROM ai_tool_calls c
    LEFT JOIN ai_task_tool_calls l ON l.tool_call_id = c.tool_call_id LEFT JOIN ai_turn_tasks t ON t.task_id = l.task_id
    LEFT JOIN ai_messages m ON m.message_id=c.message_id
    WHERE t.turn_id = ? OR (c.conversation_id=? AND json_extract(m.payload_json,'$.userMessageId')=?)
    ORDER BY c.created_at, c.rowid LIMIT 100`).all(turn.id, conversationId, turn.userMessageId).map(row => ({ id: row.tool_call_id, name: row.tool_name, risk: row.risk, status: row.status, approvedAt: row.approved_at, completedAt: row.completed_at, error: row.error, createdAt: row.created_at,
      ...(hasOwners ? { nodeExecutionId: db.prepare('SELECT node_execution_id FROM ai_debug_tool_owners WHERE tool_call_id=? AND workspace_id=?').get(row.tool_call_id, workspaceId)?.node_execution_id } : {}) }));
  return { executionId: turn.userMessageId, conversationId, turnId: turn.id, status: turn.status,
    workflow: workflow ? { id: workflow.workflow_id, version: workflow.version, definition: JSON.parse(workflow.definition_json) } : null,
    events, messages, tools, tasks: turn.tasks, reviews: turn.id ? listAssistantAgentReviews(conversationId).filter(review => review.turnId === turn.id) : [],
    reasoningPolicy: 'Conversation messages exclude provider thinking. Opt-in raw debug artifacts may contain provider-returned thinking. Structured review results and explanations are available.',
    hasMore: rows.length > take, nextCursor: rows.length > take ? events.at(-1).sequence : null };
}

export function updateToolCall(toolCallId, status, { result, error, approved = false } = {}) {
  getDb().prepare(`UPDATE ai_tool_calls SET status = ?, result_json = COALESCE(?, result_json),
    error = ?, approved_at = CASE WHEN ? THEN COALESCE(approved_at, ?) ELSE approved_at END,
    completed_at = CASE WHEN ? IN ('completed','failed','rejected') THEN ? ELSE completed_at END
    WHERE tool_call_id = ?`)
    .run(status, result === undefined ? null : JSON.stringify(result), error ?? null, approved ? 1 : 0, now(), status, now(), toolCallId);
  return getToolCall(toolCallId);
}

export function interruptActiveConversations() {
  const db = getDb();
  db.prepare("UPDATE ai_conversations SET state = 'interrupted', updated_at = ? WHERE state = 'generating'").run(now());
  db.prepare("UPDATE ai_tool_calls SET status = 'interrupted', completed_at = ? WHERE status = 'executing'").run(now());
}

export function closeAssistantStore() {
  assistantDb?.close();
  assistantDb = null;
}

function ensureAgentLifecycle() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS ai_agent_archives (workflow_id TEXT PRIMARY KEY, archived_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_system_agents (role TEXT PRIMARY KEY, workflow_id TEXT NOT NULL);`);
  db.transaction(() => {
  let rows = db.prepare('SELECT * FROM ai_workflow_definitions ORDER BY updated_at, workflow_id').all();
  for (const row of rows) {
    const definition = JSON.parse(row.definition_json);
    if (definition.schemaVersion !== 5 || !definition.synthesisWorkflow) continue;
    const referenced = [definition, definition.queryTranslation, definition.executionWorkflow].some(graph => graph?.nodes?.some(node => node.handler === 'workflow' && node.settings?.workflowRef === 'synthesisWorkflow'));
    if (referenced) continue;
    delete definition.synthesisWorkflow;
    const migrated = saveAssistantWorkflow(row.workflow_id, definition, row.version);
    db.prepare('UPDATE workspace_ai_workflow_revisions SET version=? WHERE workflow_id=? AND version=?').run(migrated.version, row.workflow_id, row.version);
  }
  for (const row of db.prepare('SELECT * FROM ai_workflow_drafts').all()) {
    const definition = JSON.parse(row.definition_json);
    if (definition.schemaVersion !== 5 || !definition.synthesisWorkflow) continue;
    const referenced = [definition, definition.queryTranslation, definition.executionWorkflow].some(graph => graph?.nodes?.some(node => node.handler === 'workflow' && node.settings?.workflowRef === 'synthesisWorkflow'));
    if (!referenced) {
      delete definition.synthesisWorkflow;
      db.prepare('UPDATE ai_workflow_drafts SET definition_json=?, revision=revision+1, updated_at=? WHERE workflow_id=? AND revision=?').run(JSON.stringify(definition), now(), row.workflow_id, row.revision);
    }
  }
  rows = db.prepare('SELECT * FROM ai_workflow_definitions ORDER BY updated_at, workflow_id').all();
  let primitive = rows.filter(row => JSON.parse(row.definition_json).schemaVersion === 5 && !db.prepare('SELECT 1 FROM ai_agent_archives WHERE workflow_id=?').get(row.workflow_id));
  if (!primitive.length) {
    const definition = starterPrimitiveAgent();
    definition.resources.bootstrapRequired = true;
    saveAssistantWorkflow('consilium-primitive', definition, 0);
    primitive = db.prepare("SELECT * FROM ai_workflow_definitions WHERE workflow_id='consilium-primitive'").all();
  }
  const system = primitive.find(row => /^Consilium Primitive$/i.test(JSON.parse(row.definition_json).name)) ?? primitive[0];
  db.prepare("INSERT OR IGNORE INTO ai_system_agents VALUES ('consilium', ?)").run(system.workflow_id);
  })();
}

export function systemAgentPolicy(workflowId, definition) {
  ensureAgentLifecycle();
  const pinned = Boolean(getDb().prepare('SELECT 1 FROM ai_system_agents WHERE workflow_id=?').get(workflowId));
  const workflows = new Set(['assistant']);
  const pending = [...workflows];
  while (pending.length) {
    const key = pending.shift(), graph = key === 'assistant' ? definition : definition?.[key];
    for (const node of graph?.nodes ?? []) if (node.handler === 'workflow' && node.settings?.workflowRef && !workflows.has(node.settings.workflowRef)) {
      workflows.add(node.settings.workflowRef); pending.push(node.settings.workflowRef);
    }
  }
  return { systemPinned: pinned, pinnedWorkflows: pinned ? [...workflows] : [],
    deletionReason: pinned ? 'Required system agent. Query translation and invoked operation workflows are dependencies.' : null };
}

export function deleteAssistantWorkflow(workflowId, expectedDraftVersion, expectedVersion) {
  const db = getDb();
  ensureAgentLifecycle();
  return db.transaction(() => {
    const saved = db.prepare('SELECT * FROM ai_workflow_definitions WHERE workflow_id=?').get(workflowId);
    const draft = db.prepare('SELECT * FROM ai_workflow_drafts WHERE workflow_id=?').get(workflowId);
    if (!saved && !draft) throw Object.assign(new Error('Agent not found.'), { status: 404 });
    if ((saved?.version ?? 0) !== expectedVersion || (draft?.revision ?? 0) !== expectedDraftVersion) throw Object.assign(new Error('Agent changed. Reload before deleting.'), { status: 409 });
    const policy = systemAgentPolicy(workflowId, JSON.parse(draft?.definition_json ?? saved.definition_json));
    if (policy.systemPinned) throw Object.assign(new Error(policy.deletionReason), { status: 409 });
    if (db.prepare('SELECT 1 FROM workspace_ai_workflows WHERE workflow_id=?').get(workflowId) || db.prepare('SELECT 1 FROM workspace_ai_workflow_revisions WHERE workflow_id=?').get(workflowId)) throw Object.assign(new Error('Select another active agent before deleting this agent.'), { status: 409 });
    db.prepare('INSERT INTO ai_agent_archives VALUES (?, ?) ON CONFLICT DO NOTHING').run(workflowId, now());
    // Immutable definitions and execution evidence remain available to Historia.
    return { deleted: true, id: workflowId };
  })();
}

export function listAssistantWorkflows() {
  ensureAgentLifecycle();
  return getDb().prepare('SELECT d.* FROM ai_workflow_definitions d LEFT JOIN ai_agent_archives a USING(workflow_id) WHERE a.workflow_id IS NULL ORDER BY d.workflow_id').all()
    .map(row => ({ id: row.workflow_id, version: row.version, definition: JSON.parse(row.definition_json), updatedAt: row.updated_at }))
    .filter(item => item.definition.schemaVersion === 5);
}

export function activeAssistantWorkflow(workspaceId = 'default') {
  ensureAgentLifecycle();
  const pinned = getDb().prepare('SELECT v.* FROM workspace_ai_workflow_revisions p JOIN ai_workflow_versions v ON v.workflow_id=p.workflow_id AND v.version=p.version WHERE p.workspace_id=?').get(workspaceId);
  if (pinned && JSON.parse(pinned.definition_json).schemaVersion === 5) return { id: pinned.workflow_id, version: pinned.version, definition: JSON.parse(pinned.definition_json), updatedAt: pinned.updated_at };
  const selected = getDb().prepare('SELECT workflow_id FROM workspace_ai_workflows WHERE workspace_id = ?').get(workspaceId);
  const workflows = listAssistantWorkflows();
  const candidate=workflows.find(item => item.id === selected?.workflow_id) ?? workflows.find(item => item.id === getDb().prepare("SELECT workflow_id FROM ai_system_agents WHERE role='consilium'").get()?.workflow_id) ?? workflows[0];
  const live=getDb().prepare(`SELECT v.* FROM ai_workflow_versions v LEFT JOIN ai_workflow_version_labels l USING(workflow_id,version)
    WHERE v.workflow_id=? AND COALESCE(l.deleted,0)=0 ORDER BY v.version DESC LIMIT 1`).get(candidate.id);
  return live?{id:live.workflow_id,version:live.version,definition:JSON.parse(live.definition_json),updatedAt:live.updated_at}:candidate;
}

export function publishAssistantBootstrap(workspaceId, previous, definition) {
  const db = getDb();
  return db.transaction(() => {
    const active = activeAssistantWorkflow(workspaceId);
    if (active.id !== previous.id || active.version !== previous.version || !active.definition.resources?.bootstrapRequired) return active;
    const saved = saveAssistantWorkflow(previous.id, definition, previous.version);
    // Only an explicitly pinned workspace needs promotion. Other workspaces
    // already select the latest system revision when no active pin exists.
    db.prepare('UPDATE workspace_ai_workflow_revisions SET version=? WHERE workspace_id=? AND workflow_id=? AND version=?')
      .run(saved.version,workspaceId,previous.id,previous.version);
    return saved;
  })();
}

export function saveAssistantWorkflow(workflowId, definition, expectedVersion) {
  const db = getDb();
  if (definition?.schemaVersion !== 5) throw new Error('Only Consilium Primitive definitions can be saved.');
  if (db.prepare("SELECT name FROM sqlite_master WHERE name='ai_agent_archives'").get() && db.prepare('SELECT 1 FROM ai_agent_archives WHERE workflow_id=?').get(workflowId)) throw Object.assign(new Error('This agent was deleted.'), { status: 409 });
  return db.transaction(() => {
    const current = db.prepare('SELECT version FROM ai_workflow_definitions WHERE workflow_id = ?').get(workflowId);
    if ((current?.version ?? 0) !== expectedVersion) throw Object.assign(new Error('Agent definition changed. Reload before saving.'), { status: 409 });
    const version = expectedVersion + 1;
    const serialized = JSON.stringify(definition);
    const timestamp = now();
    db.prepare('INSERT INTO ai_workflow_definitions VALUES (?, ?, ?, ?) ON CONFLICT(workflow_id) DO UPDATE SET version=excluded.version, definition_json=excluded.definition_json, updated_at=excluded.updated_at').run(workflowId, version, serialized, timestamp);
    db.prepare('INSERT INTO ai_workflow_versions VALUES (?, ?, ?, ?)').run(workflowId, version, serialized, timestamp);
    return { id: workflowId, version, definition, updatedAt: timestamp };
  })();
}

export function latestSelectableAssistantWorkflow(workflowId) {
  if (!listAssistantWorkflows().some(item => item.id === workflowId)) throw new Error('Agent definition was not found.');
  const live=getDb().prepare(`SELECT v.* FROM ai_workflow_versions v LEFT JOIN ai_workflow_version_labels l USING(workflow_id,version)
    WHERE v.workflow_id=? AND COALESCE(l.deleted,0)=0 ORDER BY v.version DESC LIMIT 1`).get(workflowId);
  if(!live)throw new Error('No published version is available for this agent.');
  return {id:live.workflow_id,version:live.version,definition:JSON.parse(live.definition_json),updatedAt:live.updated_at};
}

export function selectAssistantWorkflow(workspaceId, workflowId, expectedActive) {
  const db = getDb();
  return db.transaction(() => {
    const workflow = latestSelectableAssistantWorkflow(workflowId);
    if (expectedActive) {
      const active = activeAssistantWorkflow(workspaceId);
      if (active.id !== expectedActive.id || active.version !== expectedActive.version) {
        throw Object.assign(new Error('The active version changed. Reload before activating.'), { status: 409 });
      }
    }
    db.prepare('INSERT INTO workspace_ai_workflows VALUES (?, ?) ON CONFLICT(workspace_id) DO UPDATE SET workflow_id=excluded.workflow_id').run(workspaceId, workflowId);
    if (workflow.definition.schemaVersion >= 2) db.prepare('INSERT INTO workspace_ai_workflow_revisions VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET workflow_id=excluded.workflow_id, version=excluded.version').run(workspaceId, workflowId, workflow.version);
    else db.prepare('DELETE FROM workspace_ai_workflow_revisions WHERE workspace_id=?').run(workspaceId);
    return workflow;
  })();
}

export function listAssistantWorkflowDrafts() {
  ensureAgentLifecycle();
  return getDb().prepare('SELECT d.* FROM ai_workflow_drafts d LEFT JOIN ai_agent_archives a USING(workflow_id) WHERE a.workflow_id IS NULL ORDER BY workflow_id').all().map(row => ({ id: row.workflow_id, draftVersion: row.revision, definition: JSON.parse(row.definition_json), updatedAt: row.updated_at })).filter(item => item.definition.schemaVersion === 5);
}
export function saveAssistantWorkflowDraft(workflowId, definition, expectedDraftVersion = 0) {
  ensureAgentLifecycle();
  if (definition?.schemaVersion !== 5) throw new Error('Only Consilium Primitive drafts are supported.');
  if (getDb().prepare('SELECT 1 FROM ai_agent_archives WHERE workflow_id=?').get(workflowId)) throw Object.assign(new Error('This agent was deleted.'), { status: 409 });
  const db = getDb();
  return db.transaction(() => {
    const current = db.prepare('SELECT revision FROM ai_workflow_drafts WHERE workflow_id=?').get(workflowId);
    if ((current?.revision ?? 0) !== expectedDraftVersion) throw Object.assign(new Error('Agent draft changed. Reload before saving.'), { status: 409 });
    const revision = expectedDraftVersion + 1, timestamp = now();
    db.prepare('INSERT INTO ai_workflow_drafts VALUES (?, ?, ?, ?) ON CONFLICT(workflow_id) DO UPDATE SET revision=excluded.revision, definition_json=excluded.definition_json, updated_at=excluded.updated_at').run(workflowId, revision, JSON.stringify(definition), timestamp);
    return { id: workflowId, draftVersion: revision, definition, updatedAt: timestamp };
  })();
}

export function publishAssistantWorkflowDraft(workspaceId, workflowId, expectedDraftVersion, expectedActive) {
  const db = getDb();
  return db.transaction(() => {
    const draft = db.prepare('SELECT * FROM ai_workflow_drafts WHERE workflow_id=?').get(workflowId);
    if (!draft || draft.revision !== expectedDraftVersion) throw Object.assign(new Error('The draft changed after validation. Reload before activating.'), { status: 409 });
    if (expectedActive) {
      const active = activeAssistantWorkflow(workspaceId);
      if (active.id !== expectedActive.id || active.version !== expectedActive.version) {
        throw Object.assign(new Error('The active version changed. Reload before activating.'), { status: 409 });
      }
    }
    const current = db.prepare('SELECT version FROM ai_workflow_definitions WHERE workflow_id=?').get(workflowId);
    const published = saveAssistantWorkflow(workflowId, JSON.parse(draft.definition_json), current?.version ?? 0);
    selectAssistantWorkflow(workspaceId, workflowId);
    return published;
  })();
}

export function __setAssistantDbForTests(db) {
  assistantDb?.close();
  assistantDb = db;
  ensureSchema(assistantDb);
}
