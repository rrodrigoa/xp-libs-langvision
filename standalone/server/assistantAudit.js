function timestampOf(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function isAiAuditKind(kind) {
  return /^(?:agent|assistant|ai)(?:-|$)/.test(String(kind)) || /^query-translation(?:-|$)/.test(String(kind));
}

export function encodeAuditCursor(entry) {
  if (!entry?.timestamp || !entry?.id) return null;
  return Buffer.from(JSON.stringify({ timestamp: entry.timestamp, id: entry.id }), "utf8").toString("base64url");
}

export function decodeAuditCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    return typeof value.timestamp === "string" && typeof value.id === "string" ? value : null;
  } catch {
    return null;
  }
}

export function toolAuditEntry(call) {
  const summary = call.preview?.summary ?? `${call.name} ${call.status}`;
  return {
    id: `tool:${call.id}`,
    actionId: call.id,
    kind: "assistant-tool",
    title: call.name,
    summary,
    status: call.status,
    risk: call.risk,
    surface: call.surface ?? null,
    timestamp: call.completedAt ?? call.approvedAt ?? call.createdAt,
    timestampMs: timestampOf(call.completedAt ?? call.approvedAt ?? call.createdAt)
  };
}

export function runAuditEntry(run) {
  const error = (run.diagnostics ?? []).find(item => String(item.severity).toLowerCase() === "error" || item.severity === 2);
  return {
    id: `run:${run.runId}`,
    actionId: run.runId,
    kind: "run",
    title: run.displayName ?? run.runId,
    summary: run.statusReason || error?.message || run.sqlPreview || `${run.telemetryMode ?? "unknown"} telemetry`,
    status: run.status ?? "unknown",
    risk: null,
    surface: "creatio",
    telemetryMode: run.telemetryMode ?? "unknown",
    timestamp: run.completedAt ?? run.startedAt ?? run.createdAt,
    timestampMs: timestampOf(run.completedAt ?? run.startedAt ?? run.createdAt)
  };
}

export function mergeRunAuditEvidence(runs = [], activeRuns = []) {
  const active = new Map(activeRuns.map(run => [run.runId, run]));
  return runs.map(run => {
    const diagnostics = run.diagnostics?.length ? run.diagnostics : active.get(run.runId)?.diagnostics ?? [];
    const error = diagnostics.find(item => String(item.severity).toLowerCase() === "error" || item.severity === 2);
    return { ...run, diagnostics, statusReason: run.statusReason || (error ? [error.message, error.hint].filter(Boolean).join(" ") : null) };
  });
}

export function workspaceAuditEntry(event) {
  return {
    id: `audit:${event.id}`,
    actionId: event.id,
    kind: event.kind,
    title: event.title,
    summary: event.summary,
    status: event.status,
    risk: null,
    surface: event.surface ?? null,
    timestamp: event.createdAt,
    timestampMs: timestampOf(event.createdAt)
  };
}

function compareAuditEntries(left, right) {
  return right.timestampMs - left.timestampMs || right.id.localeCompare(left.id);
}

function beforeCursor(entry, cursor) {
  if (!cursor) return true;
  const cursorMs = timestampOf(cursor.timestamp);
  return entry.timestampMs < cursorMs || (entry.timestampMs === cursorMs && entry.id.localeCompare(cursor.id) < 0);
}

export function paginateAuditEntries({ toolCalls = [], runs = [], auditEvents = [], cursor, limit = 30, historyType = 'all' }) {
  const safeLimit = Math.max(5, Math.min(50, Number(limit) || 30));
  const decoded = typeof cursor === "string" ? decodeAuditCursor(cursor) : cursor;
  const entries = [
    ...toolCalls.map(toolAuditEntry),
    ...runs.map(runAuditEntry),
    ...auditEvents.map(workspaceAuditEntry)
  ].filter(entry => (historyType === 'all' || (historyType === 'ai' ? isAiAuditKind(entry.kind) : !isAiAuditKind(entry.kind))) && beforeCursor(entry, decoded)).sort(compareAuditEntries);
  const page = entries.slice(0, safeLimit);
  return {
    entries: page,
    nextCursor: entries.length > safeLimit ? encodeAuditCursor(page.at(-1)) : null,
    hasMore: entries.length > safeLimit
  };
}

export function compactConversation(conversation) {
  if (!conversation) return conversation;
  return {
    ...conversation,
    messages: (conversation.messages ?? []).filter(message => !message.payload?.intermediate || message.payload?.toolCalls?.length).map(message => ({
      ...message,
      payload: message.role === "tool"
        ? { toolName: message.payload?.toolName ?? null, toolCallId: message.payload?.toolCallId ?? null }
        : message.payload
    })),
    toolCalls: (conversation.toolCalls ?? []).map(call => ({
      id: call.id,
      actionId: call.id,
      conversationId: call.conversationId,
      messageId: call.messageId,
      name: call.name,
      version: call.version,
      risk: call.risk,
      status: call.status,
      preview: call.status === "pending" ? call.preview : { summary: call.preview?.summary ?? call.name },
      error: call.error,
      approvedAt: call.approvedAt,
      completedAt: call.completedAt,
      createdAt: call.createdAt,
      clientAction: call.result?.clientAction ?? null
    }))
  };
}
