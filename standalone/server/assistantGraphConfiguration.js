import { activeAssistantWorkflow } from './assistantStore.js';

export async function ensureGraphKnowledge(_broker, workspaceId) {
  return activeAssistantWorkflow(workspaceId);
}
