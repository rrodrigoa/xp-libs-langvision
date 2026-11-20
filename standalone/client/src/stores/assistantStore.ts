import { create } from "zustand";
import { assistantApi, type AssistantSurface } from "../components/assistant/assistantApi";
import { appendOptimisticUserMessage, applyAssistantClientAction, assistantToolSurface } from "../components/assistant/assistantUiModel.js";

type AssistantState = {
  workspaceId?: string;
  surface: AssistantSurface;
  profiles: any[];
  activeProfile?: any;
  workspaceContext?: any;
  workspaceSkills: any[];
  conversation?: any;
  context?: any;
  loading: boolean;
  respondingClarificationId?: string;
  error?: string;
  initialize: (workspaceId: string, surface: AssistantSurface) => Promise<void>;
  refresh: () => Promise<void>;
  send: (content: string, context: any) => Promise<void>;
  cancel: () => Promise<void>;
  clearConversation: () => Promise<void>;
  clarify: (clarificationId: string, response: string) => Promise<void>;
  saveProfile: (profile: any) => Promise<any>;
  deleteProfile: (id: string) => Promise<void>;
  testProfile: (profileId: string) => Promise<void>;
  selectProfile: (profileId: string) => Promise<void>;
  saveWorkspaceContext: (document: { title: string; content: string }) => Promise<void>;
  deleteWorkspaceContext: () => Promise<void>;
  saveWorkspaceSkill: (skill: any) => Promise<void>;
  deleteWorkspaceSkill: (skillId: string) => Promise<void>;
};

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

let conversationEpoch = 0;
let refreshQueued = false;
let refreshInFlight: Promise<void> | undefined;

export const useAssistantStore = create<AssistantState>((set, get) => ({
  surface: "creatio",
  profiles: [],
  workspaceSkills: [],
  loading: false,
  async initialize(workspaceId, surface) {
    if (get().workspaceId === workspaceId && get().conversation) {
      set({ surface });
      return;
    }
    const epoch = ++conversationEpoch;
    set({ workspaceId, surface, conversation: undefined, loading: true, error: undefined });
    try {
      const [profileResult, profileList, conversations, workspaceContextResult, workspaceSkillsResult] = await Promise.all([
        assistantApi.getWorkspaceProfile(workspaceId),
        assistantApi.listProfiles(),
        assistantApi.listConversations(workspaceId),
        assistantApi.getWorkspaceContext(workspaceId),
        assistantApi.listWorkspaceSkills(workspaceId)
      ]);
      const conversation = conversations.conversations[0] ?? await assistantApi.createConversation(workspaceId, surface);
      if (epoch !== conversationEpoch || get().workspaceId !== workspaceId) return;
      set({ profiles: profileList.profiles, activeProfile: profileResult.profile, workspaceContext: workspaceContextResult.document, workspaceSkills: workspaceSkillsResult.skills, conversation, loading: false });
    } catch (error) {
      if (epoch === conversationEpoch) set({ error: message(error), loading: false });
    }
  },
  async refresh() {
    if (!get().conversation?.id) return;
    refreshQueued = true;
    if (!refreshInFlight) refreshInFlight = (async () => {
      try {
        while (refreshQueued) {
          refreshQueued = false;
          const id = get().conversation?.id;
          const epoch = conversationEpoch;
          if (!id) return;
          const [conversation, context] = await Promise.all([assistantApi.getConversation(id), assistantApi.context(id).catch(() => null)]);
          if (epoch === conversationEpoch && get().conversation?.id === id) {
            const responding = get().respondingClarificationId;
            const current = responding && conversation.clarification?.id === responding
              ? { ...conversation, clarification: null, state: 'generating' } : conversation;
            set({ conversation: current, ...(context ? { context: context.context } : {}) });
          }
        }
      } finally { refreshInFlight = undefined; }
    })();
    await refreshInFlight;
  },
  async send(content, context) {
    const conversation = get().conversation;
    if (!conversation || get().loading || !content.trim()) return;
    const epoch = ++conversationEpoch;
    const pendingId = `pending-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set({
      conversation: appendOptimisticUserMessage(conversation, content, get().surface, pendingId),
      loading: true,
      error: undefined
    });
    try {
      await assistantApi.sendMessage(conversation.id, content.trim(), get().surface, context);
      if (epoch === conversationEpoch) { ++conversationEpoch; set({ loading: false }); }
    } catch (error) {
      if (epoch === conversationEpoch) set({ error: message(error), loading: false });
    }
    if (get().conversation?.id === conversation.id) void get().refresh().catch(() => {});
  },
  async cancel() {
    const id = get().conversation?.id;
    if (!id) return;
    const epoch = ++conversationEpoch;
    set({ loading: true });
    try {
      await assistantApi.cancel(id);
    } catch(error) { if (epoch === conversationEpoch) set({ error: message(error) }); }
    finally {
      if (epoch === conversationEpoch) {
        set({ loading: false, respondingClarificationId: undefined });
        void get().refresh().catch(() => {});
      }
    }
  },
  async clearConversation() {
    const previous=get().conversation,workspaceId=get().workspaceId;
    if(!previous||!workspaceId||get().loading)return;
    ++conversationEpoch;
    set({loading:true,error:undefined});
    try {
      const conversation=await assistantApi.clearConversation(workspaceId,previous.id);
      if(get().workspaceId===workspaceId&&get().conversation?.id===previous.id)set({conversation,context:undefined,loading:false});
    }catch(error){if(get().workspaceId===workspaceId)set({error:message(error),loading:false});}
  },
  async clarify(clarificationId, response) {
    if (!response.trim()) return;
    const conversation = get().conversation;
    if (get().loading || conversation?.clarification?.id !== clarificationId) return;
    const epoch = ++conversationEpoch;
    set({ loading: true, error: undefined, respondingClarificationId: clarificationId, conversation: { ...conversation, clarification: null, state: 'generating' } });
    try {
      await assistantApi.clarify(clarificationId, response.trim());
      if (epoch === conversationEpoch) { ++conversationEpoch; set({ respondingClarificationId: undefined, loading: false }); }
    } catch (error) {
      if (epoch === conversationEpoch) set({ conversation, respondingClarificationId: undefined, error: message(error), loading: false });
    }
    if (get().conversation?.id === conversation.id) void get().refresh().catch(() => {});
  },
  async saveProfile(profile) {
    const saved = await assistantApi.saveProfile(profile);
    const profiles = (await assistantApi.listProfiles()).profiles;
    set({ profiles });
    if (get().activeProfile?.id === saved.id) set({ activeProfile: saved });
    return saved;
  },
  async deleteProfile(id) {
    const response = await fetch('/api/assistant/profiles/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error((await response.json()).error ?? 'Could not delete connection.');
    const workspaceId = get().workspaceId;
    set({ profiles: (await assistantApi.listProfiles()).profiles, activeProfile: workspaceId ? (await assistantApi.getWorkspaceProfile(workspaceId)).profile : undefined });
  },
  async testProfile(profileId) {
    const tested = await assistantApi.testProfile(profileId);
    set({ profiles: get().profiles.map(profile => profile.id === profileId ? tested : profile), activeProfile: get().activeProfile?.id === profileId ? tested : get().activeProfile });
  },
  async selectProfile(profileId) {
    if (!get().workspaceId) return;
    const result = await assistantApi.selectProfile(get().workspaceId!, profileId);
    set({ activeProfile: result.profile });
  },
  async saveWorkspaceContext(document) {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return;
    const result = await assistantApi.saveWorkspaceContext(workspaceId, document);
    set({ workspaceContext: result.document, workspaceSkills: (await assistantApi.listWorkspaceSkills(workspaceId)).skills, error: undefined });
  },
  async deleteWorkspaceContext() {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return;
    await assistantApi.deleteWorkspaceContext(workspaceId);
    set({ workspaceContext: undefined, workspaceSkills: (await assistantApi.listWorkspaceSkills(workspaceId)).skills, error: undefined });
  },
  async saveWorkspaceSkill(skill) {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return;
    await assistantApi.saveWorkspaceSkill(workspaceId, skill);
    set({ workspaceSkills: (await assistantApi.listWorkspaceSkills(workspaceId)).skills, error: undefined });
  },
  async deleteWorkspaceSkill(skillId) {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return;
    await assistantApi.deleteWorkspaceSkill(workspaceId, skillId);
    set({ workspaceSkills: (await assistantApi.listWorkspaceSkills(workspaceId)).skills, error: undefined });
  }
}));
