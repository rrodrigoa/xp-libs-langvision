export function pendingAssistantApprovals(conversation) {
  return (conversation?.toolCalls ?? []).filter(call => call.status === "pending");
}

export function scrollAssistantMessagesToBottom(element) {
  if (!element) return false;
  element.scrollTop = element.scrollHeight;
  return true;
}

export function assistantToolMessagePresentation(message, toolCalls = []) {
  const actionId = message?.payload?.toolCallId ?? null;
  const tool = actionId ? toolCalls.find(call => call.id === actionId) : null;
  const toolName = message?.payload?.toolName ?? tool?.name ?? "assistant tool";
  return {
    actionId,
    toolName,
    status: tool?.status ?? (message?.content?.includes("failed") ? "failed" : "completed"),
    label: `${toolName} · ${tool?.status ?? "completed"}`
  };
}

function readableToolName(toolName) {
  const [surface, operation = "tool action"] = String(toolName ?? "assistant tool").split(".", 2);
  const action = operation.replaceAll("_", " ");
  return `${action.charAt(0).toUpperCase()}${action.slice(1)} in ${surface || "the workspace"}.`;
}

export function assistantConversationItems(conversation) {
  const messages = conversation?.messages ?? [];
  const toolCalls = conversation?.toolCalls ?? [];
  const groupedToolCallIds = new Set();
  const items = [];
  const thinkingMessages=messages.filter(message=>message.payload?.messageKind==='model-activity');
  const thoughtsFor=message=>message.payload?.providerThinking ?? thinkingMessages.find(thought=>thought.payload.toolCalls?.some(call=>call.id===message.payload?.requestId))?.payload.providerThinking;

  for (const message of messages) {
    if(message.payload?.messageKind==='model-activity' && message.payload.toolCalls?.some(call=>messages.some(other=>other.payload?.requestId===call.id))) continue;
    const calls = toolCalls.filter(call => call.messageId === message.id);
    const requestedTools = message.role === "assistant" && Array.isArray(message.payload?.toolCalls);
    if (requestedTools || calls.length > 0) {
      const fallbackCalls = requestedTools
        ? message.payload.toolCalls.map((call, index) => ({
            id: `requested-${message.id}-${index}`,
            name: call?.function?.name ?? "assistant tool",
            status: "requested",
            preview: null
          }))
        : [];
      const actions = (calls.length > 0 ? calls : fallbackCalls).map(call => {
        groupedToolCallIds.add(call.id);
        return {
          actionId: call.id,
          toolName: call.name,
          status: call.status ?? "requested",
          error: call.status === 'failed' ? call.error : undefined,
          explanation: call.preview?.summary ?? readableToolName(call.name)
        };
      });
      items.push({ kind: "tool-activity", id: message.id, message, actions, thinking:thoughtsFor(message) });
      continue;
    }

    if (message.role === "tool" && groupedToolCallIds.has(message.payload?.toolCallId)) {
      continue;
    }
    if (message.role === "tool" && toolCalls.some(call => call.id === message.payload?.toolCallId)) {
      continue;
    }
    items.push({ kind: "message", id: message.id, message });
  }

  return items;
}

const ASSISTANT_TASK_LABELS = {
  pending: "Pending",
  active: "In progress",
  "awaiting-approval": "Waiting for approval",
  "awaiting-clarification": "Waiting for clarification",
  executing: "In progress",
  verifying: "Verifying",
  recovering: "Retrying",
  canceled: "Canceled",
  completed: "Completed",
  failed: "Failed",
  'needs-attention': 'Blocked',
  rejected: "Rejected"
};

export function assistantTaskPlan(conversation) {
  const turns = conversation?.turns ?? [];
  const turn = turns.at(-1);
  if (!turn) return null;
  const tasks = (turn.tasks ?? []).filter(task => task.status !== 'removed').map(task => ({
    ...task,
    label: ASSISTANT_TASK_LABELS[task.status] ?? task.status,
    activity: task.recoveryCount > 0
      ? `${task.recoveryCount} recover${task.recoveryCount === 1 ? "y" : "ies"} / ${task.attemptCount ?? 0} action attempts`
      : task.attemptCount > 0 ? `${task.attemptCount} action attempt${task.attemptCount === 1 ? "" : "s"}` : null
  }));
  return {
    ...turn,
    tasks,
    currentTaskId: turn.currentTaskId ?? (tasks.filter(task=>task.status==='active').length===1?tasks.find(task=>task.status==='active').id:null),
    completedCount: tasks.filter(task => task.status === "completed").length,
    totalCount: tasks.length
  };
}

export function appendOptimisticUserMessage(conversation, content, surface, id) {
  if (!conversation || !content?.trim()) return conversation;
  return {
    ...conversation,
    messages: [
      ...(conversation.messages ?? []),
      {
        id,
        role: "user",
        content: content.trim(),
        surface,
        pending: true,
        createdAt: new Date().toISOString()
      }
    ]
  };
}

export function applyAssistantClientAction(action, debugBridge, actionTarget = globalThis) {
  if (action?.type === "surface.commandResult" && action.surface && action.command) {
    actionTarget?.dispatchEvent?.(new CustomEvent("chronosql:surface-command-result", { detail: action }));
    return true;
  }
  // Legacy actions remain readable for conversations created before command reconciliation.
  if (action?.type === "speculum.selectEvent" && action.eventId) {
    actionTarget?.dispatchEvent?.(new CustomEvent("chronosql:surface-command-result", {
      detail: { type: "surface.commandResult", surface: "speculum", command: "selection.event", eventId: action.eventId, recenter: action.recenter }
    }));
    return true;
  }
  if (action?.type === "speculum.selectNode" && action.nodeId) {
    actionTarget?.dispatchEvent?.(new CustomEvent("chronosql:surface-command-result", {
      detail: { type: "surface.commandResult", surface: "speculum", command: "selection.node", nodeId: action.nodeId }
    }));
    return true;
  }
  if (action?.type === "run.activate" && action.runDbPath) {
    actionTarget?.dispatchEvent?.(new CustomEvent("chronosql:assistant-run-activated", { detail: action }));
    return true;
  }
  if (action?.type === "workspace.commandResult" && action.command) {
    actionTarget?.dispatchEvent?.(new CustomEvent("chronosql:workspace-command-result", { detail: action }));
    return true;
  }
  if (action?.type === "figura.refresh") {
    actionTarget?.dispatchEvent?.(new CustomEvent("chronosql:surface-command-result", {
      detail: { type: "surface.commandResult", surface: "figura", command: "refresh", panelId: action.panelId }
    }));
    return true;
  }
  return false;
}

export function assistantToolSurface(toolName, fallback = "creatio") {
  const surface = String(toolName ?? "").split(".", 1)[0];
  return ["creatio", "speculum", "figura", "historia"].includes(surface) ? surface : fallback;
}

export function assistantGpuStatus(profile) {
  const residency = Number(profile?.capability?.gpuResidency ?? 0);
  return {
    loaded: Boolean(profile?.capability?.loaded),
    residency,
    acceptable: Boolean(profile?.capability?.loaded) && residency >= 0.9,
    label: `${Math.round(residency * 100)}% GPU`
  };
}

export function assistantPanelPresentation(profile, conversation, loading) {
  const pendingCount = pendingAssistantApprovals(conversation).length;
  const latestTurn = conversation?.turns?.at?.(-1);
  const synthesizing = latestTurn?.status === "synthesizing";
  return {
    state: synthesizing ? "synthesizing" : loading ? "working" : conversation?.state ?? "idle",
    canSend: Boolean(profile) && !loading,
    pendingCount,
    hasConversation: Boolean(conversation?.id),
    profileLabel: profile ? `${profile.displayName} / ${profile.model}` : "Configure Ollama",
    processingTitle: synthesizing ? "Preparing grounded answer" : "Consilium is working",
    processingDetail: synthesizing
      ? "Checking the response against verified product evidence."
      : "Grounding your request and selecting the safest available action."
  };
}

export function assistantSurfaceForWorkspaceTab(activeTab) {
  if (activeTab === "scope") return "speculum";
  if (activeTab === "plot") return "figura";
  return "creatio";
}

export function assistantSurfaceLabel(activeTab) {
  if (activeTab === "scope") return "Speculum";
  if (activeTab === "plot") return "Figura";
  if (activeTab === "runs") return "Historia";
  return "Creatio";
}

export function shouldApplyAssistantMutation(detail, surface) {
  return detail?.surface === surface
    && typeof detail?.toolName === "string"
    && detail.toolName.startsWith(`${surface}.`);
}
