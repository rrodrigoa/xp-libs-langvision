export const OLLAMA_MODEL_PRESETS = Object.freeze([
  { model:'gpt-oss-120b-16k:latest',label:'GPT-OSS 120B / 16K',numCtx:16384,thinkingMode:'high' },
  { model:'gpt-oss-120b-32k:latest',label:'GPT-OSS 120B / 32K',numCtx:32768,thinkingMode:'high' }
]);

export function cachedModelProfile(model,installed) {
  const preset=OLLAMA_MODEL_PRESETS.find(item=>item.model===model);
  const cached=installed.find(item=>item.name===model);
  if(!preset||!cached?.digest)throw new Error('Load installed models first. This preset never downloads a model.');
  return {id:undefined,displayName:preset.label,model,numCtx:preset.numCtx,thinkingMode:preset.thinkingMode,
    think:true,temperature:0,seed:42,keepAlive:'30m',expectedDigest:cached.digest};
}

export function cachedSelectionStatus(model,digest,installed,loaded) {
  const cached=installed.find(item=>item.name===model);
  return {missing:Boolean(loaded&&!cached),digestChanged:Boolean(loaded&&cached?.digest&&digest&&cached.digest!==digest),digest:cached?.digest??null};
}
