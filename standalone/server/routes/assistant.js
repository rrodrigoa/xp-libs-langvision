import { Router } from "express";
import { clearAssistantChat,clearWorkspaceAiHistory,clearWorkspaceJobAudit } from '../assistantHistory.js';
import { listAssistantExecutions, getAssistantExecution, assistantExecutionTrace, assistantExecutionEvents, assistantExecutionInvocations,assistantAttemptInspection } from '../assistantExecutions.js';
import { ASSISTANT_CAPABILITIES } from "../assistantCapabilities.js";
import { compactConversation, decodeAuditCursor, paginateAuditEntries, mergeRunAuditEvidence } from "../assistantAudit.js";
import {
  archiveConversation,
  createConversation,
  deleteAiProfile,
  deleteWorkspaceAiContext,
  deleteWorkspaceAiSkill,
  getAiProfile,
  getConversation,
  getWorkspaceAiContext,
  getWorkspaceAiProfile,
  getWorkspaceAuditEvent,
  getAssistantExecutionTrace,
  listWorkspaceAiSkills,
  latestContextSnapshot,
  listAiProfiles,
  listConversations,
  getWorkspaceToolCall,
  listWorkspaceToolCalls,
  listWorkspaceAuditEvents,
  saveAiProfile,
  modelConnectionForProfile,
  saveWorkspaceAiContext,
  saveWorkspaceAiSkill,
  selectWorkspaceAiProfile
} from "../assistantStore.js";
import { validateModelConnection } from '../modelConnection.js';

function conversationResponse(request, conversation) {
  return request.query.compact === "1" ? compactConversation(conversation) : conversation;
}

async function workspaceRuns(fetchImpl, serviceBaseUrl) {
  try {
    const response = await fetchImpl(new URL("/api/runs", serviceBaseUrl));
    if (!response.ok) return [];
    const payload = await response.json();
    return mergeRunAuditEvidence(payload.workspaceRuns, payload.activeRuns);
  } catch {
    return [];
  }
}

function sendError(response, error) {
  response.status(error.status ?? 400).json({ error: error.message ?? "Assistant request failed." });
}

function validateProfile(profile) {
  const connection = validateModelConnection(profile);
  if (!Number.isInteger(profile.timeoutMs ?? 120000) || (profile.timeoutMs ?? 120000) < 1000 || (profile.timeoutMs ?? 120000) > 7200000) throw new Error('Request timeout must be between 1 second and 2 hours.');
  if (!Number.isInteger(profile.maxConcurrency ?? 1) || (profile.maxConcurrency ?? 1) < 1 || (profile.maxConcurrency ?? 1) > 32) throw new Error('Invalid model concurrency limit.');
  if ((profile.numCtx ?? 16384) > 262144 || (profile.numCtx ?? 16384) < 2048) throw new Error('Context budget must be between 2,048 and 262,144 tokens.');
  if (connection.baseUrlSource === 'environment') {
    if (!profile.model?.trim()) throw new Error('A model or deployment name is required.');
    return { ...profile, ...connection, baseUrl: '', thinkingMode: profile.thinkingMode ?? 'off' };
  }
  let url;
  try {
    url = new URL(profile.baseUrl);
  } catch {
    throw new Error("Model API base URL must be a valid HTTP or HTTPS URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Ollama base URL must use HTTP or HTTPS and cannot contain credentials.");
  }
  if (!profile.model?.trim()) throw new Error("An Ollama model is required.");
  if ((profile.numCtx ?? 16384) > 262144 || (profile.numCtx ?? 16384) < 2048) {
    throw new Error("Ollama context must be between 2,048 and 262,144 tokens.");
  }
  const thinkingMode = String(profile.thinkingMode ?? (profile.think ? "on" : "off")).trim().toLowerCase();
  if (!["off", "on", "low", "medium", "high"].includes(thinkingMode)) {
    throw new Error("Ollama thinking mode must be off, on, low, medium, or high.");
  }
  return { ...profile, ...connection, thinkingMode, baseUrl: url.toString().replace(/\/$/, "") };
}

function discoveryConnection(body) {
  const saved = body.id ? getAiProfile(body.id) : null;
  // Credential references are server-owned; an unsaved form may replace, never spoof, one.
  const profile = validateProfile({ ...saved, ...body, model: body.model || 'discovery', credentialReference: saved?.credentialReference });
  const connection = modelConnectionForProfile(profile);
  if (body.apiKey) connection.apiKey = body.apiKey;
  return { profile, connection };
}

async function json(response) {
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `Service request failed with HTTP ${response.status}.`);
  return payload;
}

export function createAssistantRouter({ agent, fetchImpl = fetch, serviceBaseUrl }) {
  const router = Router();
  const isRunning=id=>Boolean(agent?.turnControllers?.has(id)||agent?.controllers?.has(id)||agent?.legacyAgent?.controllers?.has(id));
  router.post('/conversations/:conversationId/clear',(request,response)=>{
    try {
      if(request.body.confirmConversationId!==request.params.conversationId)throw new Error('Confirm the conversation to clear.');
      response.json(conversationResponse(request,clearAssistantChat(request.params.conversationId,String(request.body.workspaceId??'default'),isRunning)));
    }catch(error){sendError(response,error);}
  });
  router.post('/history/clear',async(request,response)=>{
    try {
      const {historyType,workspaceId='default',confirm}=request.body;
      if(!['ai','jobs'].includes(historyType)||confirm!==historyType)throw new Error('Confirm which history to clear: ai or jobs.');
      if(historyType==='ai')return response.json(clearWorkspaceAiHistory(String(workspaceId),isRunning));
      const result=await json(await fetchImpl(new URL('/api/runs/history/clear',serviceBaseUrl),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:'jobs'})}));
      response.json({...result,auditCleared:clearWorkspaceJobAudit(String(workspaceId))});
    }catch(error){sendError(response,error);}
  });

  router.get("/capabilities", (_request, response) => {
    response.json({
      capabilities: ASSISTANT_CAPABILITIES.map(({ execute, preview, revision, evidence, ...capability }) => capability)
    });
  });

  router.get("/profiles", (_request, response) => response.json({ profiles: listAiProfiles() }));

  router.post('/profiles/:profileId/credential', (request, response) => {
    try {
      response.set('Cache-Control', 'no-store');
      if (request.body.reveal !== true) throw new Error('Explicit reveal is required.');
      const profile = getAiProfile(request.params.profileId);
      if (!profile) return response.status(404).json({ error: 'Profile was not found.' });
      if (profile.apiKeySource === 'environment') throw new Error('Environment credentials are not returned to the browser.');
      response.json({ value: modelConnectionForProfile(profile).apiKey ?? '' });
    } catch (error) { sendError(response, error); }
  });

  // Discover cached models through the same gateway used for inference. Never pull weights.
  router.post("/models", async (request, response) => {
    try {
      const { profile, connection } = discoveryConnection(request.body ?? {});
      const compatible = profile.provider === 'openai-compatible';
      const available = await json(await fetchImpl(new URL(compatible ? '/api/ai/openai/models' : "/api/ai/ollama/models", serviceBaseUrl), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseAddress: profile.baseUrl, ...(compatible ? { connection } : {}) }), signal: AbortSignal.timeout(15000)
      }));
      response.json({ models: (available.models ?? []).map(model => ({
        name: model.name ?? model.model, digest: model.digest, size: model.size
      })).filter(model => typeof model.name === "string").sort((a, b) => a.name.localeCompare(b.name)) });
    } catch (error) { sendError(response, error); }
  });

  router.post('/models/inspect', async (request,response) => {
    try {
      const profile=validateProfile({baseUrl:request.body?.baseUrl,model:request.body?.model});
      const value=await json(await fetchImpl(new URL('/api/ai/ollama/show',serviceBaseUrl),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({baseAddress:profile.baseUrl,model:profile.model}),signal:AbortSignal.timeout(15000)}));
      response.json({capabilities:value.capabilities??[],thinking:value.thinking??null});
    } catch(error) { sendError(response,error); }
  });

  router.post("/profiles", (request, response) => {
    try {
      response.status(201).json(saveAiProfile(validateProfile(request.body ?? {})));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.put("/profiles/:profileId", (request, response) => {
    try {
      const existing = getAiProfile(request.params.profileId);
      if (!existing) return response.status(404).json({ error: "Profile was not found." });
      response.json(saveAiProfile(validateProfile({ ...existing, ...request.body, id: request.params.profileId })));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.delete("/profiles/:profileId", (request, response) => {
    response.status(deleteAiProfile(request.params.profileId) ? 204 : 404).end();
  });

  router.post("/profiles/:profileId/test", async (request, response) => {
    try {
      const profile = getAiProfile(request.params.profileId);
      if (!profile) return response.status(404).json({ error: "Profile was not found." });
      if (profile.provider === 'openai-compatible') {
        const token = 'chronus_connection_probe';
        const result = await json(await fetchImpl(new URL('/api/ai/chat', serviceBaseUrl), { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ baseAddress: profile.baseUrl, connection: modelConnectionForProfile(profile), model: profile.model,
            messages: [{ role: 'user', content: 'Call chronus_connection_probe with value "ok". Do not answer in prose.' }],
            tools: [{ type: 'function', function: { name: token, description: 'Read-only connection test, no product actions.', parameters: { type: 'object', properties: { value: { type: 'string', enum: ['ok'] } }, required: ['value'] } } }],
            options: { num_predict: 512, temperature: 0, seed: 42 } }), signal: AbortSignal.timeout(profile.timeoutMs ?? 120000) }));
        const calls = result.message?.toolCalls ?? result.message?.tool_calls ?? [];
        const toolCapable = calls.some(call => call.function?.name === token && (typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments)?.value === 'ok');
        return response.json(saveAiProfile({ ...profile, capability: { connected: true, toolCapable, acceptanceReady: toolCapable, testedAt: new Date().toISOString() } }));
      }
      const body = JSON.stringify({ baseAddress: profile.baseUrl });
      const [available, running] = await Promise.all([
        json(await fetchImpl(new URL("/api/ai/ollama/models", serviceBaseUrl), { method: "POST", headers: { "content-type": "application/json" }, body })),
        json(await fetchImpl(new URL("/api/ai/ollama/processes", serviceBaseUrl), { method: "POST", headers: { "content-type": "application/json" }, body }))
      ]);
      const installed = available.models?.find(model => model.name === profile.model || model.model === profile.model) ?? null;
      const loaded = running.models?.find(model => model.name === profile.model || model.model === profile.model) ?? null;
      const loadedSize = Number(loaded?.size ?? 0);
      const loadedVram = Number(loaded?.sizeVram ?? loaded?.size_vram ?? 0);
      const loadedContext = loaded?.contextLength ?? loaded?.context_length ?? null;
      const gpuResidency = loadedSize > 0 ? loadedVram / loadedSize : 0;
      const digestMatches = !profile.expectedDigest || profile.expectedDigest === (installed?.digest ?? loaded?.digest);
      const contextMatches = !loadedContext || loadedContext === profile.numCtx;
      const modelCapabilities = installed?.capabilities ?? loaded?.capabilities ?? [];
      const toolCapable = modelCapabilities.includes("tools");
      const capability = {
        connected: true,
        installed: Boolean(installed),
        loaded: Boolean(loaded),
        gpuResidency,
        digest: installed?.digest ?? loaded?.digest ?? null,
        digestMatches,
        contextLength: loadedContext,
        contextMatches,
        capabilities: modelCapabilities,
        toolCapable,
        acceptanceReady: Boolean(installed && loaded) && gpuResidency >= 0.9 && digestMatches && contextMatches && toolCapable
      };
      response.json(saveAiProfile({ ...profile, capability }));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get("/workspace/:workspaceId/profile", (request, response) => {
    response.json({ profile: getWorkspaceAiProfile(request.params.workspaceId) });
  });

  router.get("/workspace/:workspaceId/context-document", (request, response) => {
    response.json({ document: getWorkspaceAiContext(request.params.workspaceId) });
  });

  router.put("/workspace/:workspaceId/context-document", (request, response) => {
    try {
      response.json({ document: saveWorkspaceAiContext(request.params.workspaceId, request.body ?? {}) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.delete("/workspace/:workspaceId/context-document", (request, response) => {
    deleteWorkspaceAiContext(request.params.workspaceId);
    response.status(204).end();
  });

  router.get("/workspace/:workspaceId/skills", (request, response) => {
    response.json({ skills: listWorkspaceAiSkills(request.params.workspaceId, { enabledOnly: request.query.all !== "1" }) });
  });

  router.post("/workspace/:workspaceId/skills", (request, response) => {
    try {
      response.status(201).json({ skill: saveWorkspaceAiSkill(request.params.workspaceId, request.body ?? {}) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.put("/workspace/:workspaceId/skills/:skillId", (request, response) => {
    try {
      response.json({ skill: saveWorkspaceAiSkill(request.params.workspaceId, { ...request.body, id: request.params.skillId }) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.delete("/workspace/:workspaceId/skills/:skillId", (request, response) => {
    response.status(deleteWorkspaceAiSkill(request.params.workspaceId, request.params.skillId) ? 204 : 404).end();
  });

  router.put("/workspace/:workspaceId/profile", (request, response) => {
    try {
      if (!getAiProfile(request.body.profileId)) return response.status(404).json({ error: "Profile was not found." });
      response.json({ profile: selectWorkspaceAiProfile(request.params.workspaceId, request.body.profileId) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get("/conversations", (request, response) => {
    response.json({ conversations: listConversations(request.query.workspaceId ?? "default").map(conversation => conversationResponse(request, conversation)) });
  });

  router.post("/conversations", (request, response) => {
    response.status(201).json(conversationResponse(request, createConversation({
      workspaceId: request.body.workspaceId ?? "default",
      title: request.body.title,
      surface: request.body.surface
    })));
  });

  router.get("/conversations/:conversationId", (request, response) => {
    const conversation = getConversation(request.params.conversationId);
    response.status(conversation ? 200 : 404).json(conversation ? conversationResponse(request, conversation) : { error: "Conversation was not found." });
  });

  router.delete("/conversations/:conversationId", (request, response) => {
    archiveConversation(request.params.conversationId);
    response.status(204).end();
  });

  router.get("/conversations/:conversationId/context", (request, response) => {
    response.json({ context: latestContextSnapshot(request.params.conversationId) });
  });

  router.post("/conversations/:conversationId/messages", async (request, response) => {
    try {
      response.json(conversationResponse(request, await agent.submit({
        conversationId: request.params.conversationId,
        content: request.body.content,
        surface: request.body.surface ?? "creatio",
        context: request.body.context ?? {}
      })));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post("/conversations/:conversationId/cancel", (request, response) => {
    response.json({ canceled: agent.cancel(request.params.conversationId) });
  });

  router.post("/clarifications/:clarificationId/respond", async (request, response) => {
    try {
      if (typeof agent.clarify !== "function") {
        return response.status(409).json({ error: "Clarification resume requires the LangGraph assistant runtime." });
      }
      const value = String(request.body?.response ?? "").trim();
      if (!value) return response.status(400).json({ error: "A clarification response is required." });
      response.json(conversationResponse(request, await agent.clarify(request.params.clarificationId, value)));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get("/conversations/:conversationId/events", (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    const emitter = agent.emitter(request.params.conversationId);
    const listener = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    emitter.on("event", listener);
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15000);
    request.on("close", () => {
      clearInterval(heartbeat);
      emitter.off("event", listener);
    });
  });

  router.get('/executions',(request,response)=>{try{response.json(listAssistantExecutions(String(request.query.workspaceId??'default'),request.query));}catch(error){sendError(response,error);}});
  router.get('/executions/:id/invocations',(request,response)=>{try{response.json(assistantExecutionInvocations(String(request.query.workspaceId??'default'),request.params.id,request.query));}catch(error){sendError(response,error);}});
  router.get('/executions/:id/attempts/:nodeId',(request,response)=>{try{const value=assistantAttemptInspection(String(request.query.workspaceId??'default'),request.params.id,request.params.nodeId);response.status(value?200:404).json(value??{error:'Attempt not found.'});}catch(error){sendError(response,error);}});
  router.get('/executions/:id/events',(request,response)=>{try{response.json(assistantExecutionEvents(String(request.query.workspaceId??'default'),request.params.id,request.query));}catch(error){sendError(response,error);}});
  router.get('/executions/:id',(request,response)=>{try{const execution=getAssistantExecution(String(request.query.workspaceId??'default'),request.params.id);response.status(execution?200:404).json(execution??{error:'Execution not found.'});}catch(error){sendError(response,error);}});
  router.get("/audit", async (request, response) => {
    try {
      const workspaceId = String(request.query.workspaceId ?? "default");
      if(request.query.historyType==='ai')return response.json({workspaceId,historyType:'ai',...listAssistantExecutions(workspaceId,{cursor:request.query.cursor,limit:request.query.limit})});
      const limit = Math.max(5, Math.min(50, Number(request.query.limit) || 30));
      const cursor = decodeAuditCursor(request.query.cursor);
      const historyType = String(request.query.historyType ?? 'all');
      if (!['all', 'jobs', 'ai'].includes(historyType)) return response.status(400).json({ error: 'History type must be jobs, ai, or all.' });
      const [runs, toolCalls, auditEvents] = await Promise.all([
        historyType === 'ai' ? [] : workspaceRuns(fetchImpl, serviceBaseUrl),
        Promise.resolve(historyType === 'jobs' ? [] : listWorkspaceToolCalls(workspaceId, { limit: limit + 1, before: cursor })),
        Promise.resolve(listWorkspaceAuditEvents(workspaceId, { limit: limit + 1, before: cursor, historyType }))
      ]);
      response.json({ workspaceId, historyType, ...paginateAuditEntries({ toolCalls, runs, auditEvents, cursor, limit, historyType }) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/audit/:actionId/trace', (request, response) => {
    try {
      const workspaceId=String(request.query.workspaceId??'default');
      const trace = assistantExecutionTrace(workspaceId,request.params.actionId,{after:request.query.after,limit:request.query.limit}) ?? getAssistantExecutionTrace(workspaceId, request.params.actionId, { after: request.query.after, limit: request.query.limit });
      if (!trace) return response.status(404).json({ error: 'No workflow execution is linked to this activity.' });
      response.json(trace);
    } catch (error) { sendError(response, error); }
  });

  router.get("/audit/:actionId", async (request, response) => {
    try {
      const workspaceId = String(request.query.workspaceId ?? "default");
      const actionId = request.params.actionId;
      const execution=getAssistantExecution(workspaceId,actionId);
      if(execution)return response.json(execution);
      const auditEvent = getWorkspaceAuditEvent(workspaceId, actionId);
      if (auditEvent) {
        response.json({
          id: `audit:${auditEvent.id}`,
          actionId: auditEvent.id,
          kind: auditEvent.kind,
          title: auditEvent.title,
          summary: auditEvent.summary,
          status: auditEvent.status,
          surface: auditEvent.surface,
          metadata: auditEvent.metadata,
          createdAt: auditEvent.createdAt
        });
        return;
      }
      const toolCall = getWorkspaceToolCall(workspaceId, actionId);
      if (toolCall) {
        response.json({
          id: `tool:${toolCall.id}`,
          actionId: toolCall.id,
          kind: "assistant-tool",
          title: toolCall.name,
          status: toolCall.status,
          risk: toolCall.risk,
          surface: toolCall.surface,
          arguments: toolCall.arguments,
          preview: toolCall.preview,
          result: toolCall.result,
          error: toolCall.error,
          expectedRevision: toolCall.expectedRevision,
          approvedAt: toolCall.approvedAt,
          completedAt: toolCall.completedAt,
          createdAt: toolCall.createdAt
        });
        return;
      }
      const runs = await workspaceRuns(fetchImpl, serviceBaseUrl);
      const run = runs.find(item => item.runId === actionId);
      response.status(run ? 200 : 404).json(run
        ? { id: `run:${run.runId}`, actionId: run.runId, kind: "run", title: run.displayName ?? run.runId, run }
        : { error: `Historia action '${actionId}' was not found.` });
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
