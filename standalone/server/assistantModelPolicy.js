import { DEFAULT_CONTEXT_POLICY, DEFAULT_OUTPUT_POLICY, DEEP_REASONING_CONTEXT_POLICY, DEEP_REASONING_OUTPUT_POLICY, MODEL_POLICY_PRESETS } from '../shared/assistantModelPolicyDefaults.js';

function normalizedThinkingMode(profile) {
  return String(profile?.thinkingMode ?? (profile?.think ? "on" : "off")).trim().toLowerCase();
}

export function isDeepReasoningProfile(profile) {
  return Number(profile?.numCtx ?? 16384) >= 65536 && normalizedThinkingMode(profile) !== "off";
}

export function assistantModelPolicy(profile, configuration) {
  const deepReasoning = configuration ? Number(profile?.numCtx ?? 16384) >= configuration.modelPolicy.deepContextThreshold && (!configuration.modelPolicy.deepRequiresThinking || normalizedThinkingMode(profile) !== 'off') : isDeepReasoningProfile(profile);
  const preset = (configuration?.modelPolicy.presets ?? MODEL_POLICY_PRESETS)[deepReasoning ? 'deep' : 'standard'];
  return {
    deepReasoning,
    context: { ...preset.context, ...configuration?.modelPolicy?.context },
    output: { ...preset.output, ...configuration?.modelPolicy?.output }
  };
}

export const assistantDefaultModelPolicy = Object.freeze({
  context: DEFAULT_CONTEXT_POLICY,
  output: DEFAULT_OUTPUT_POLICY
});

export const assistantDeepReasoningModelPolicy = Object.freeze({
  context: DEEP_REASONING_CONTEXT_POLICY,
  output: DEEP_REASONING_OUTPUT_POLICY
});
