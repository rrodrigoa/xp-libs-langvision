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
  error?: string;
  initialize: (workspaceId: string, surface: AssistantSurface) => Promise<void>;
  refresh: () => Promise<void>;
  send: (content: string, context: any) => Promise<void>;
  cancel: () => Promise<void>;
  clearConversation: () => Promise<void>;
  clarify: (clarificationId: string, response: string) => Promise<void>;
  saveProfile: (profile: any) => Promise<void>;
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
    set({ workspaceId, surface, loading: true, error: undefined });
    try {
      const [profileResult, profileList, conversations, workspaceContextResult, workspaceSkillsResult] = await Promise.all([
        assistantApi.getWorkspaceProfile(workspaceId),
        assistantApi.listProfiles(),
        assistantApi.listConversations(workspaceId),
        assistantApi.getWorkspaceContext(workspaceId),
        assistantApi.listWorkspaceSkills(workspaceId)
      ]);
      const conversation = conversations.conversations[0] ?? await assistantApi.createConversation(workspaceId, surface);
      if (get().workspaceId !== workspaceId) return;
      set({ profiles: profileList.profiles, activeProfile: profileResult.profile, workspaceContext: workspaceContextResult.document, workspaceSkills: workspaceSkillsResult.skills, conversation, loading: false });
    } catch (error) {
      set({ error: message(error), loading: false });
    }
  },
  async refresh() {
    const id = get().conversation?.id;
    if (!id) return;
    const [conversation, context] = await Promise.all([assistantApi.getConversation(id), assistantApi.context(id)]);
    if(get().conversation?.id===id)set({ conversation, context: context.context, error: undefined });
  },
  async send(content, context) {
    const conversation = get().conversation;
    if (!conversation || !content.trim()) return;
    const pendingId = `pending-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set({
      conversation: appendOptimisticUserMessage(conversation, content, get().surface, pendingId),
      loading: true,
      error: undefined
    });
    try {
      set({ conversation: await assistantApi.sendMessage(conversation.id, content.trim(), get().surface, context), loading: false });
    } catch (error) {
      try {
        await get().refresh();
      } catch {
        // Keep the optimistic request visible when the server cannot be reached.
      }
      set({ error: message(error), loading: false });
    }
  },
  async cancel() {
    const id = get().conversation?.id;
    try {
      if (id) await assistantApi.cancel(id);
      await get().refresh();
    }catch(error){set({error:message(error)});}
  },
  async clearConversation() {
    const previous=get().conversation,workspaceId=get().workspaceId;
    if(!previous||!workspaceId||get().loading)return;
    set({loading:true,error:undefined});
    try {
      const conversation=await assistantApi.clearConversation(workspaceId,previous.id);
      if(get().workspaceId===workspaceId&&get().conversation?.id===previous.id)set({conversation,context:undefined,loading:false});
    }catch(error){if(get().workspaceId===workspaceId)set({error:message(error),loading:false});}
  },
  async clarify(clarificationId, response) {
    if (!response.trim()) return;
    set({ loading: true, error: undefined });
    try {
      set({ conversation: await assistantApi.clarify(clarificationId, response.trim()), loading: false });
    } catch (error) {
      set({ error: message(error), loading: false });
    }
  },
  async saveProfile(profile) {
    const saved = await assistantApi.saveProfile(profile);
    const profiles = (await assistantApi.listProfiles()).profiles;
    set({ profiles });
    if (get().workspaceId) await get().selectProfile(saved.id);
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
