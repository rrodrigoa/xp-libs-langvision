export const DEFAULT_CONTEXT_POLICY = Object.freeze({
  searchLimit: 6,
  retrievalLimit: 6,
  recentMessages: 16,
  clampDepth: 5,
  stringCharacters: 2000,
  arrayItems: 30,
  objectEntries: 60,
  catalogIndexCharacters: 7000,
  relevantSectionsCharacters: 8000,
  retrievedKnowledgeCharacters: 8000,
  capabilityCharacters: 9000,
  productRegistryCharacters: 7000,
  activeContextCharacters: 12000
});

export const DEEP_REASONING_CONTEXT_POLICY = Object.freeze({
  searchLimit: 12,
  retrievalLimit: 12,
  recentMessages: 32,
  clampDepth: 8,
  stringCharacters: 12000,
  arrayItems: 120,
  objectEntries: 160,
  catalogIndexCharacters: 24000,
  relevantSectionsCharacters: 96000,
  retrievedKnowledgeCharacters: 96000,
  capabilityCharacters: 72000,
  productRegistryCharacters: 48000,
  activeContextCharacters: 72000
});

export const DEFAULT_OUTPUT_POLICY = Object.freeze({
  planner: 1536,
  decisionReview: 768,
  action: 1024,
  outcomeReview: 768,
  synthesis: 2048,
  turnTimeoutMs: 5 * 60 * 1000
});

export const DEEP_REASONING_OUTPUT_POLICY = Object.freeze({
  planner: 8192,
  decisionReview: 4096,
  action: 8192,
  outcomeReview: 4096,
  synthesis: 8192,
  turnTimeoutMs: 30 * 60 * 1000
});


export const MODEL_POLICY_PRESETS = { standard: { context: DEFAULT_CONTEXT_POLICY, output: DEFAULT_OUTPUT_POLICY }, deep: { context: DEEP_REASONING_CONTEXT_POLICY, output: DEEP_REASONING_OUTPUT_POLICY } };
