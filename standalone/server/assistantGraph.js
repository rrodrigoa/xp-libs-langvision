import { Command } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { randomUUID } from 'node:crypto';
import { beginAssistantExecution } from './assistantExecutions.js';
import { cancelExecutionSpans } from './assistantSpans.js';
import { compilePrimitiveAgent } from './primitiveAgentRuntime.js';
import { createPrimitiveAdapters, savePrimitiveRun, primitiveRun } from './primitiveAgentAdapters.js';
import { activeAssistantWorkflow, addMessage, assistantCheckpointDbPath, assistantDebugDatabase, createAssistantTurn, getAssistantClarification, getAssistantTurn, getConversation, getWorkspaceAiProfile, getAiProfile, recordWorkspaceAuditEvent, setAssistantTurnStatus, setConversationState } from './assistantStore.js';
import { assistantModelPolicy } from './assistantModelPolicy.js';
import { ensureGraphKnowledge } from './assistantGraphConfiguration.js';
import { activeBudget, configuredMinutes } from './assistantDeadlines.js';
import { primitiveWorkflows } from '../shared/primitiveAgentModel.js';
export const DEFAULT_ASSISTANT_RUNTIME = 'langgraph';
function terminalStateForConversation(conversation) {
  if (!conversation) return "failed";
  if (["awaiting-approval", "awaiting-clarification", "interrupted", "failed", "needs-attention"].includes(conversation.state)) {
    return conversation.state === "needs-attention" ? "blocked" : conversation.state;
  }
  const latestTurn = conversation.turns?.at(-1);
  if (latestTurn?.status === "canceled") return "canceled";
  if (latestTurn?.status === "failed") return "failed";
  const hasAnswer = conversation.messages?.some(message => message.payload?.finalAnswer && message.payload?.turnId === latestTurn?.id);
  return hasAnswer ? "answered" : conversation.state === "idle" ? "answered" : conversation.state;
}

export class AssistantLangGraphRuntime {
  constructor({ toolHost, contextBroker, fetchImpl = fetch, serviceBaseUrl, checkpointer = null, terminal, research }) {
    this.toolHost = toolHost;
    this.terminal = terminal;
    this.research = research;
    this.contextBroker = contextBroker;
    this.fetchImpl = fetchImpl;
    this.serviceBaseUrl = serviceBaseUrl;
    this.mode = 'langgraph';
    this.turnControllers = new Map();
    this.executionControllers = new Map();
    this.modelActivity = new Map();
    this.nodeActivity = new Map();
    this.checkpointer = checkpointer ?? SqliteSaver.fromConnString(assistantCheckpointDbPath());
  }
  emitter(id) { return this.toolHost.emitter(id); }
  emit(id, type, payload = {}) { return this.toolHost.emit(id, type, payload); }
  activity(id) { return this.modelActivity.get(id) ?? null; }
  activeNode(id) { return this.nodeActivity.get(id) ?? null; }
  budget(executionId, definition, profile, controller) {
    const coding = primitiveWorkflows(definition).some(([, workflow]) => workflow.nodes.some(node => node.settings?.toolNames?.includes('workspace.run')));
    const limit = coding ? configuredMinutes(process.env.LANGVISION_CODING_ACTIVE_MINUTES, 60)
      : assistantModelPolicy(profile).output.turnTimeoutMs;
    return activeBudget(assistantDebugDatabase(), executionId, limit, controller);
  }
  cancel(conversationId) {
    const controller = this.turnControllers.get(conversationId);
    controller?.abort(new Error('Agent execution canceled.'));
    if (this.modelActivity.delete(conversationId)) this.emit(conversationId, 'model-activity', { activity: null });
    const executionId = getConversation(conversationId)?.messages.findLast(message => message.role === 'user')?.id;
    if (executionId) cancelExecutionSpans(executionId);
    if (executionId) void this.terminal?.closeExecution(executionId, 'execution-canceled');
    if (executionId) void this.research?.cleanupTurn?.(executionId);
    return this.toolHost.cancel(conversationId) || Boolean(controller);
  }
  buildGraph(definition) {
    if (definition?.schemaVersion !== 5) throw new Error('Only Consilium Primitive definitions are executable. Historical staged definitions remain read-only.');
    return compilePrimitiveAgent(definition, createPrimitiveAdapters({ definition, fetchImpl: this.fetchImpl,
      serviceBaseUrl: this.serviceBaseUrl, toolHost: this.toolHost, emit: (id, type, value) => this.emit(id, type, value),
      onNodeActivity: (id, activity) => {
        if (activity) this.nodeActivity.set(id, activity);
        else this.nodeActivity.delete(id);
        this.emit(id, 'node-activity', { activity });
      },
      onModelActivity: (id, activity) => {
        if (activity) this.modelActivity.set(id, activity);
        else this.modelActivity.delete(id);
        this.emit(id, 'model-activity', { activity });
      } }), { checkpointer: this.checkpointer });
  }
  graphConfig(threadId) { return { configurable: { thread_id: threadId } }; }
  async submit({ conversationId, content, surface, context }) {
    if (this.turnControllers.has(conversationId)) throw Object.assign(new Error('This conversation already has an active execution. Wait for cancellation to finish before submitting another request.'), { status: 409 });
    const conversation = getConversation(conversationId);
    if (!conversation) throw new Error(`Conversation '${conversationId}' was not found.`);
    const controller = new AbortController();
    this.turnControllers.set(conversationId, controller);
    let deadline;
    try {
    const workflow = typeof this.contextBroker?.getCatalog === 'function' ? await ensureGraphKnowledge(this.contextBroker, conversation.workspaceId) : activeAssistantWorkflow(conversation.workspaceId);
    const profile = workflow.definition.profileId ? getAiProfile(workflow.definition.profileId) : getWorkspaceAiProfile(conversation.workspaceId);
    controller.signal.throwIfAborted();
    const userMessage = addMessage(conversationId, "user", content, surface, { graphRuntime: this.mode, workflowId: workflow.id, workflowVersion: workflow.version });
    const turn = createAssistantTurn({conversationId,userMessageId:userMessage.id,originalRequest:content,tasks:[]});
    beginAssistantExecution({executionId:userMessage.id,workspaceId:conversation.workspaceId,conversationId,userMessageId:userMessage.id,request:content,createdAt:userMessage.createdAt});
    recordWorkspaceAuditEvent({ workspaceId: conversation.workspaceId, kind: 'agent-workflow', title: 'Agent turn started', summary: workflow.definition.name,
      status: 'started', surface: 'ai', signature: `${userMessage.id}:start`, metadata: { conversationId, userMessageId: userMessage.id, workflowId: workflow.id, workflowVersion: workflow.version } });
    setConversationState(conversationId, 'generating', surface);
    this.emit(conversationId, "assistant-message", { message: userMessage });
    this.executionControllers.set(userMessage.id, controller);
    try {
    savePrimitiveRun(userMessage.id, conversationId, workflow.definition);
    deadline = this.budget(userMessage.id, workflow.definition, profile, controller);
    const output = await this.buildGraph(workflow.definition).invoke({
      entry: { request: content, workspaceId: conversation.workspaceId, workspace: Object.fromEntries(Object.entries(context ?? {}).filter(([key]) => !key.startsWith('agent'))) },
      variables: {}, steps: 0,
      identity: { conversationId, userMessageId: userMessage.id, turnId: turn?.id, workspaceId: conversation.workspaceId, surface,
        graphVersion: `${workflow.id}@${workflow.version}`, defaultProfile: profile,
        profiles: Object.fromEntries([workflow.definition, workflow.definition.queryTranslation, workflow.definition.executionWorkflow, workflow.definition.synthesisWorkflow].filter(Boolean)
          .flatMap(graph => [graph.profileId, ...graph.nodes.map(node => node.settings?.profileId)]).filter(Boolean).map(id => [id, getAiProfile(id)])) }
    }, { ...this.graphConfig(userMessage.id), recursionLimit: workflow.definition.maxSteps + 5, signal: controller.signal });
    const current = getConversation(conversationId);
    const terminal = terminalStateForConversation(current);
    recordWorkspaceAuditEvent({ workspaceId: conversation.workspaceId, kind: 'agent-workflow', title: 'Agent turn result', summary: terminal,
      status: terminal === 'answered' ? 'completed' : terminal, surface: 'ai', signature: `${userMessage.id}:result`,
      metadata: { conversationId, userMessageId: userMessage.id, workflowId: workflow.id, workflowVersion: workflow.version, terminalState: terminal } });
    if (output?.__interrupt__) return getConversation(conversationId);
    if (getConversation(conversationId)?.state === 'generating') throw new Error('The saved graph reached End without publishing an answer or recording an interruption. Connect a completion operation.');
    return getConversation(conversationId);
    } catch (error) {
      if (controller.signal.aborted) {
        const ownsExecution = this.turnControllers.get(conversationId) === controller;
        cancelExecutionSpans(userMessage.id);
        if (ownsExecution) setConversationState(conversationId, 'interrupted', surface);
        if(turn)setAssistantTurnStatus(turn.id,'interrupted');
        addMessage(conversationId, 'assistant', `${controller.signal.reason?.message ?? 'Agent execution canceled.'} Completed actions will not be replayed.`, surface, { canceled: true, userMessageId: userMessage.id, workflowId: workflow.id, workflowVersion: workflow.version });
        if (ownsExecution) this.emit(conversationId, 'generation-interrupted');
        return getConversation(conversationId);
      }
      const detail = String(error.message).slice(0, 2000).replace(/(SharedAccessKey|Password|ApiKey|Bearer)(\s*[=: ]\s*)[^;\s"']+/gi, '$1$2[redacted]');
      const message = workflow.definition.schemaVersion === 5 ? `The configured agent workflow failed: ${detail}\nCompleted actions will not be replayed. Inspect the failed node in Historia, then revise its prompt, bindings or actions and retry.` : 'Consilium could not complete this agent workflow. No completed action will be replayed automatically. Review Historia and retry or revise the agent definition.';
      setConversationState(conversationId, 'failed', surface);
      if(turn)setAssistantTurnStatus(turn.id,'failed');
      addMessage(conversationId, 'assistant', message, surface, { error: true, userMessageId: userMessage.id, workflowId: workflow.id, workflowVersion: workflow.version });
      recordWorkspaceAuditEvent({ workspaceId: conversation.workspaceId, kind: 'agent-workflow', title: 'Agent workflow failed', summary: message, status: 'failed', surface, signature: userMessage.id, metadata: { conversationId, userMessageId: userMessage.id, workflowId: workflow.id, version: workflow.version, errorType: error.name } });
      this.emit(conversationId, 'generation-failed', { error: message });
      return getConversation(conversationId);
    } finally {
      this.executionControllers.delete(userMessage.id);
      if (getConversation(conversationId)?.clarification?.status !== 'pending') {
        await this.terminal?.closeExecution(userMessage.id);
        await this.research?.cleanupTurn?.(userMessage.id);
      }
    }
    } catch (error) {
      const canceled = controller.signal.aborted;
      const userMessage = addMessage(conversationId, 'user', content, surface);
      const message = canceled ? 'Agent execution canceled before planning.' : 'Consilium could not initialize the saved agent definition. Review Historia and retry.';
      const ownsExecution = this.turnControllers.get(conversationId) === controller;
      if (ownsExecution) setConversationState(conversationId, canceled ? 'interrupted' : 'failed', surface);
      addMessage(conversationId, 'assistant', message, surface, { canceled, error: !canceled, userMessageId: userMessage.id });
      recordWorkspaceAuditEvent({ workspaceId: conversation.workspaceId, kind: 'agent-workflow', title: canceled ? 'Agent execution canceled' : 'Agent initialization failed', summary: message, status: canceled ? 'canceled' : 'failed', surface, signature: userMessage.id, metadata: { conversationId, userMessageId: userMessage.id, errorType: canceled ? null : error.name } });
      if (ownsExecution) this.emit(conversationId, canceled ? 'generation-interrupted' : 'generation-failed', { error: canceled ? null : message });
      return getConversation(conversationId);
    } finally {
      try { deadline?.(); }
      finally { if (this.turnControllers.get(conversationId) === controller) this.turnControllers.delete(conversationId); }
    }
  }

  async resumeExecution(conversationId, userMessageId, work) {
    if (this.turnControllers.has(conversationId)) throw Object.assign(new Error('This conversation already has an active execution.'), { status: 409 });
    const controller = new AbortController();
    this.turnControllers.set(conversationId, controller); this.executionControllers.set(userMessageId, controller);
    try { return await work(controller); }
    catch (error) {
      if (!controller.signal.aborted) throw error;
      const ownsExecution = this.turnControllers.get(conversationId) === controller;
      cancelExecutionSpans(userMessageId);
      if (ownsExecution) setConversationState(conversationId, 'interrupted');
      const conversation = getConversation(conversationId);
      const turn = conversation.turns?.find(item => item.userMessageId === userMessageId);
      if (turn) setAssistantTurnStatus(turn.id, 'interrupted');
      addMessage(conversationId, 'assistant', `${controller.signal.reason?.message ?? 'Agent execution canceled.'} Completed actions will not be replayed.`, conversation.currentSurface, { canceled: true, userMessageId, turnId: turn?.id });
      if (ownsExecution) this.emit(conversationId, 'generation-interrupted');
      return getConversation(conversationId);
    } finally {
      if (this.turnControllers.get(conversationId) === controller) this.turnControllers.delete(conversationId);
      this.executionControllers.delete(userMessageId);
      if (getConversation(conversationId)?.clarification?.status !== 'pending') {
        await this.terminal?.closeExecution(userMessageId);
        await this.research?.cleanupTurn?.(userMessageId);
      }
    }
  }

  async clarify(clarificationId, response) {
    const clarification = getAssistantClarification(clarificationId);
    if (!clarification || clarification.status !== "pending") throw new Error("The clarification is no longer pending.");
    const turn = getAssistantTurn(clarification.turnId);
    return this.resumeExecution(clarification.conversationId, turn.userMessageId, async controller => {
    const primitive = primitiveRun(turn.userMessageId);
    if (primitive) {
      const finishBudget = this.budget(turn.userMessageId, primitive.definition, getWorkspaceAiProfile(getConversation(clarification.conversationId).workspaceId), controller);
      try {
      controller.signal.throwIfAborted();
      await this.buildGraph(primitive.definition).invoke(new Command({ resume: String(response ?? '').trim() }), {
        ...this.graphConfig(turn.userMessageId), recursionLimit: primitive.definition.maxSteps + 5, signal: controller.signal
      });
      } catch (error) {
        controller.signal.throwIfAborted();
        setConversationState(clarification.conversationId, 'failed'); setAssistantTurnStatus(turn.id, 'failed');
        const content = `The resumed agent workflow failed. ${String(error.message).slice(0, 2000).replace(/(SharedAccessKey|Password|ApiKey|Bearer)(\s*[=: ]\s*)[^;\s"']+/gi, '$1$2[redacted]')}\nInspect the failed node in Historia. Completed actions will not be replayed.`;
        addMessage(clarification.conversationId, 'assistant', content, getConversation(clarification.conversationId).currentSurface, { error: true, turnId: turn.id, userMessageId: turn.userMessageId });
        this.emit(clarification.conversationId, 'generation-failed', { error: content });
      } finally { finishBudget(); }
      return getConversation(clarification.conversationId);
    }
    throw new Error('This historical staged execution is retired and cannot resume. Start a new turn using Consilium Primitive.');
    });
  }
}
export function createAssistantRuntime(options) {
  const mode = options.mode ?? process.env.CHRONOSQL_ASSISTANT_RUNTIME ?? DEFAULT_ASSISTANT_RUNTIME;
  if (mode !== 'langgraph') throw new Error('Only the primitive LangGraph runtime is supported.');
  return new AssistantLangGraphRuntime(options);
}
export const assistantGraphContract = {
  version: 'consilium-primitive-v5', defaultMode: DEFAULT_ASSISTANT_RUNTIME,
  states: ['start', 'llm', 'tool', 'data', 'human', 'workflow', 'end'],
  terminalStates: ['answered', 'awaiting-approval', 'awaiting-clarification', 'blocked', 'canceled', 'failed', 'interrupted']
};
