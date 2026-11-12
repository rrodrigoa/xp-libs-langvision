export type AssistantSurface = "creatio" | "speculum" | "figura";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/assistant${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(payload?.error ?? `Assistant request failed with HTTP ${response.status}.`);
  return payload as T;
}

export const assistantApi = {
  revealCredential: (id:string) => request<{value:string}>(`/profiles/${encodeURIComponent(id)}/credential`, { method: 'POST', body: JSON.stringify({ reveal: true }) }),
  inspectModel: (baseUrl:string,model:string) => request<{capabilities:string[];thinking:{values:(string|boolean)[];default?:string|boolean}|null}>("/models/inspect",{method:"POST",body:JSON.stringify({baseUrl,model})}),
  discoverModels: (baseUrl: string, connection: Record<string, unknown> = {}) => request<{ models: { name: string; digest?: string; size?: number }[] }>("/models", {
    method: "POST", body: JSON.stringify({ ...connection, baseUrl })
  }),
  listProfiles: () => request<{ profiles: any[] }>("/profiles"),
  saveProfile: (profile: any) => request<any>(profile.id ? `/profiles/${profile.id}` : "/profiles", {
    method: profile.id ? "PUT" : "POST", body: JSON.stringify(profile)
  }),
  testProfile: (profileId: string) => request<any>(`/profiles/${profileId}/test`, { method: "POST" }),
  selectProfile: (workspaceId: string, profileId: string) => request<any>(`/workspace/${encodeURIComponent(workspaceId)}/profile`, {
    method: "PUT", body: JSON.stringify({ profileId })
  }),
  getWorkspaceProfile: (workspaceId: string) => request<any>(`/workspace/${encodeURIComponent(workspaceId)}/profile`),
  getWorkspaceContext: (workspaceId: string) => request<any>(`/workspace/${encodeURIComponent(workspaceId)}/context-document`),
  saveWorkspaceContext: (workspaceId: string, document: { title: string; content: string }) => request<any>(`/workspace/${encodeURIComponent(workspaceId)}/context-document`, {
    method: "PUT", body: JSON.stringify(document)
  }),
  deleteWorkspaceContext: (workspaceId: string) => request<void>(`/workspace/${encodeURIComponent(workspaceId)}/context-document`, { method: "DELETE" }),
  listWorkspaceSkills: (workspaceId: string) => request<{ skills: any[] }>(`/workspace/${encodeURIComponent(workspaceId)}/skills?all=1`),
  saveWorkspaceSkill: (workspaceId: string, skill: any) => request<any>(skill.id
    ? `/workspace/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(skill.id)}`
    : `/workspace/${encodeURIComponent(workspaceId)}/skills`, {
    method: skill.id ? "PUT" : "POST", body: JSON.stringify(skill)
  }),
  deleteWorkspaceSkill: (workspaceId: string, skillId: string) => request<void>(`/workspace/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(skillId)}`, { method: "DELETE" }),
  listConversations: (workspaceId: string) => request<{ conversations: any[] }>(`/conversations?workspaceId=${encodeURIComponent(workspaceId)}&compact=1`),
  createConversation: (workspaceId: string, surface: AssistantSurface) => request<any>("/conversations?compact=1", {
    method: "POST", body: JSON.stringify({ workspaceId, surface })
  }),
  getConversation: (conversationId: string) => request<any>(`/conversations/${conversationId}?compact=1`),
  sendMessage: (conversationId: string, content: string, surface: AssistantSurface, context: any) => request<any>(`/conversations/${conversationId}/messages?compact=1`, {
    method: "POST", body: JSON.stringify({ content, surface, context })
  }),
  cancel: (conversationId: string) => request<any>(`/conversations/${conversationId}/cancel`, { method: "POST" }),
  clearConversation: (workspaceId:string,conversationId:string) => request<any>(`/conversations/${conversationId}/clear?compact=1`,{method:'POST',body:JSON.stringify({workspaceId,confirmConversationId:conversationId})}),
  clearHistory: (workspaceId:string,historyType:string) => request<any>('/history/clear',{method:'POST',body:JSON.stringify({workspaceId,historyType,confirm:historyType})}),
  clarify: (clarificationId: string, response: string) => request<any>(`/clarifications/${clarificationId}/respond?compact=1`, {
    method: "POST", body: JSON.stringify({ response })
  }),
  context: (conversationId: string) => request<any>(`/conversations/${conversationId}/context`),
  audit: (workspaceId: string, cursor?: string, limit = 30, historyType = 'all') => request<any>(
    `/audit?workspaceId=${encodeURIComponent(workspaceId)}&limit=${limit}&historyType=${encodeURIComponent(historyType)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  auditDetail: (workspaceId: string, actionId: string) => request<any>(
    `/audit/${encodeURIComponent(actionId)}?workspaceId=${encodeURIComponent(workspaceId)}`)
};
