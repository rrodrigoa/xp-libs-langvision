export function canClearAssistantConversation(conversation, loading = false) {
  return !loading && Boolean(conversation) && !conversation.archived
    && ['idle','failed','interrupted','canceled'].includes(conversation.state)
    && !(conversation.toolCalls ?? []).some(call => ['pending','executing'].includes(call.status));
}

export function canCancelAssistantConversation(conversation,loading=false) {
  return loading||Boolean(conversation&&!conversation.archived&&['generating','synthesizing','awaiting-approval','awaiting-clarification','needs-attention'].includes(conversation.state));
}
