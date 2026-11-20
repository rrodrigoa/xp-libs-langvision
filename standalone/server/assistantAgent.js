import { EventEmitter } from 'node:events';
import { captureToolArtifact } from './assistantDebugTrace.js';
import { addMessage, updateToolCall, cancelAssistantConversationWork, setConversationState } from './assistantStore.js';

// Registered tool mechanics only. Strategy, routing and recovery belong to saved primitive graphs.
export class ConsiliumToolHost {
  constructor({ contextBroker, fetchImpl = fetch, serviceBaseUrl, nodeBaseUrl }) {
    this.contextBroker = contextBroker;
    this.fetchImpl = fetchImpl;
    this.serviceBaseUrl = serviceBaseUrl;
    this.nodeBaseUrl = nodeBaseUrl;
    this.events = new Map();
  }

  emitter(conversationId) {
    if (!this.events.has(conversationId)) this.events.set(conversationId, new EventEmitter());
    return this.events.get(conversationId);
  }

  emit(conversationId, type, payload = {}) {
    this.emitter(conversationId).emit("event", { type, conversationId, at: new Date().toISOString(), ...payload });
  }

  cancel(conversationId) {
    const canceledRows = cancelAssistantConversationWork(conversationId);
    setConversationState(conversationId, "interrupted");
    this.emit(conversationId, "generation-interrupted");
    return canceledRows > 0;
  }

  async executeTool(toolCall, capability, args, execution, surface) {
    captureToolArtifact(toolCall,'tool-input',{toolCallId:toolCall.id,name:capability.name,args,expectedRevision:toolCall.expectedRevision,approvedAt:toolCall.approvedAt,status:toolCall.status});
    try {
      const result = await capability.execute(args, execution, toolCall);
      if (capability.name.startsWith('terminal.') && result?.ok === false) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      captureToolArtifact(toolCall,'tool-result',{toolCallId:toolCall.id,name:capability.name,result});
      updateToolCall(toolCall.id, "completed", { result });
      addMessage(
        toolCall.conversationId,
        "tool",
        `Used ${capability.name}. Action ${toolCall.id}.`,
        surface,
        { toolName: capability.name, toolCallId: toolCall.id, modelContent: JSON.stringify(result) });
      this.emit(toolCall.conversationId, "tool-completed", { toolCallId: toolCall.id });
      if (result?.clientAction) this.emit(toolCall.conversationId, "client-action", { action: result.clientAction });
      return { ok: true, result };
    } catch (error) {
      captureToolArtifact(toolCall,'tool-error',{toolCallId:toolCall.id,name:capability.name,code:error.code,message:error.message,stack:error.stack});
      updateToolCall(toolCall.id, "failed", { error: error.message });
      addMessage(
        toolCall.conversationId,
        "tool",
        `${capability.name} failed. Action ${toolCall.id}.`,
        surface,
        { toolName: capability.name, toolCallId: toolCall.id, modelContent: JSON.stringify({ error: error.message }) });
      this.emit(toolCall.conversationId, "tool-failed", { toolCallId: toolCall.id, error: error.message });
      return { ok: false, error };
    }
  }

  executionContext(signal) {
    return {
      fetchImpl: this.fetchImpl,
      serviceBaseUrl: this.serviceBaseUrl,
      nodeBaseUrl: this.nodeBaseUrl,
      signal
    };
  }
}
