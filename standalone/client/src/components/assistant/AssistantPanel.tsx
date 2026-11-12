import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, Circle, CircleAlert, Cpu, Link2, Send, Settings2, Square, X, Trash2 } from "lucide-react";
import { canClearAssistantConversation,canCancelAssistantConversation } from '../../../../shared/assistantHistoryPolicy.js';
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ActivityIndicator } from "../ActivityIndicator";
import { OLLAMA_MODEL_PRESETS, cachedModelProfile, cachedSelectionStatus } from '../../../../shared/assistantModelPresets.js';
import { useAssistantStore } from "../../stores/assistantStore";
import { assistantApi, type AssistantSurface } from "./assistantApi";
import { ConnectionValueField } from '../ConnectionValueField.jsx';
import { applyAssistantClientAction, assistantConversationItems, assistantGpuStatus, assistantPanelPresentation, assistantTaskPlan } from "./assistantUiModel.js";
import { createAssistantScrollFollower } from './assistantScroll.js';

type Props = {
  workspaceId: string;
  surface: AssistantSurface;
  context: Record<string, unknown>;
  allowProfileAdmin?: boolean;
  compact?: boolean;
  surfaceLabel?: string;
  onClose?: () => void;
  onEditAgent?: () => void;
};

function AssistantMarkdown({ children }: { children: string }) {
  return (
    <div className="assistant-markdown" data-testid="assistant-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: linkChildren, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">{linkChildren}</a>
          )
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function ProfileSettings({ workspaceId, initiallyOpen = false }: { workspaceId: string; initiallyOpen?: boolean }) {
  const profiles = useAssistantStore(state => state.profiles);
  const activeProfile = useAssistantStore(state => state.activeProfile);
  const saveProfile = useAssistantStore(state => state.saveProfile);
  const testProfile = useAssistantStore(state => state.testProfile);
  const selectProfile = useAssistantStore(state => state.selectProfile);
  const workspaceContext = useAssistantStore(state => state.workspaceContext);
  const saveWorkspaceContext = useAssistantStore(state => state.saveWorkspaceContext);
  const deleteWorkspaceContext = useAssistantStore(state => state.deleteWorkspaceContext);
  const workspaceSkills = useAssistantStore(state => state.workspaceSkills);
  const saveWorkspaceSkill = useAssistantStore(state => state.saveWorkspaceSkill);
  const deleteWorkspaceSkill = useAssistantStore(state => state.deleteWorkspaceSkill);
  const [draft, setDraft] = useState({
    id: undefined as string | undefined,
    provider: 'ollama', baseUrlSource: 'value', baseUrlEnvironmentVariable: '',
    authMode: 'none', apiKey: '', apiKeySource: 'value', apiKeyEnvironmentVariable: '',
    tokenLimitParameter: 'max_tokens', sendSampling: true, reasoningEffort: '',
    timeoutMs: 600000, maxConcurrency: 1,
    displayName: "Local qwen3.6",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3.6:latest",
    numCtx: 16384,
    temperature: 0,
    seed: 42,
    think: false,
    thinkingMode: "off",
    keepAlive: "30m",
    expectedDigest: "07d35212591fc27746f0a317c975a6d68754fb38e9053d82e25f06057af28522"
  });
  const [contextDraft, setContextDraft] = useState({ title: "Workspace domain context", content: "" });
  const [skillDraft, setSkillDraft] = useState({ title: "", kind: "domain", content: "" });
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [cancelVersion,setCancelVersion]=useState(0);
  const [modelInfo,setModelInfo]=useState<{capabilities:string[];thinking:{values:(string|boolean)[];default?:string|boolean}|null}|null>(null);
  const [settingsError, setSettingsError] = useState("");
  useEffect(() => {
    if (!activeProfile) return;
    setDraft({ id: activeProfile.id, displayName: activeProfile.displayName,
      provider: activeProfile.provider ?? 'ollama', baseUrlSource: activeProfile.baseUrlSource ?? 'value', baseUrlEnvironmentVariable: activeProfile.baseUrlEnvironmentVariable ?? '',
      authMode: activeProfile.authMode ?? 'none', apiKey: '', apiKeySource: activeProfile.apiKeySource ?? 'value', apiKeyEnvironmentVariable: activeProfile.apiKeyEnvironmentVariable ?? '',
      tokenLimitParameter: activeProfile.tokenLimitParameter ?? 'max_tokens', sendSampling: activeProfile.sendSampling ?? true, reasoningEffort: activeProfile.reasoningEffort ?? '',
      timeoutMs: activeProfile.timeoutMs ?? 600000, maxConcurrency: activeProfile.maxConcurrency ?? 1,
      baseUrl: activeProfile.baseUrl, model: activeProfile.model, numCtx: activeProfile.numCtx ?? 16384,
      temperature: activeProfile.temperature ?? 0, seed: activeProfile.seed ?? 42,
      think: activeProfile.think ?? false, thinkingMode: activeProfile.thinkingMode ?? (activeProfile.think ? 'on' : 'off'),
      keepAlive: activeProfile.keepAlive ?? '30m', expectedDigest: activeProfile.expectedDigest ?? '' });
  }, [activeProfile?.id,cancelVersion]);
  const [models, setModels] = useState<{ name: string; digest?: string;size?:number }[]>([]);
  const [modelsLoaded,setModelsLoaded]=useState(false);
  const [modelSearch,setModelSearch]=useState('');
  useEffect(()=>{let canceled=false;setModelInfo(null);if(draft.provider==='ollama')assistantApi.inspectModel(draft.baseUrl,draft.model).then(value=>{if(!canceled)setModelInfo(value);}).catch(()=>{if(!canceled)setModelInfo(null);});return()=>{canceled=true;};},[draft.baseUrl,draft.model,draft.provider,cancelVersion]);
  const thinkingModes=modelInfo?.thinking?.values?.map(value=>value===true?'on':value===false?'off':String(value))??['off','on','low','medium','high'];
  const thinkingInvalid=Boolean(modelInfo?.thinking&&!thinkingModes.includes(draft.thinkingMode));
  const discoveryGeneration = useRef(0);
  useEffect(() => { discoveryGeneration.current++; setModels([]);setModelsLoaded(false); }, [draft.baseUrl,draft.provider,draft.authMode,draft.apiKey,draft.apiKeySource,draft.apiKeyEnvironmentVariable,draft.baseUrlSource,draft.baseUrlEnvironmentVariable]);
  useEffect(() => () => { discoveryGeneration.current++; }, []);
  function selectModel(model: string) {
    const installed = models.find(item => item.name === model);
    setDraft(current => ({ ...current, model, expectedDigest: installed?.digest ?? "" }));
  }
  async function settingsAction(work: () => Promise<unknown>) {
    if (settingsBusy) return;
    setSettingsBusy(true); setSettingsError("");
    try { await work(); } catch (error) { setSettingsError(error instanceof Error ? error.message : "Settings could not be saved."); }
    finally { setSettingsBusy(false); }
  }
  useEffect(() => {
    setContextDraft({
      title: workspaceContext?.title ?? "Workspace domain context",
      content: workspaceContext?.content ?? ""
    });
  }, [workspaceContext?.contentHash, workspaceId]);
  const gpu = assistantGpuStatus(activeProfile);
  const cacheStatus=cachedSelectionStatus(draft.model,draft.expectedDigest,models,modelsLoaded);
  return (
    <details className="assistant-profile-settings" data-testid="assistant-profile-settings" open={initiallyOpen || undefined}>
      <summary><Settings2 size={14} /> Agent model connection</summary>
      {profiles.length ? (
        <label>Active profile
          <select value={activeProfile?.id ?? ""} disabled={settingsBusy} onChange={event => void settingsAction(() => selectProfile(event.target.value))}>
            <option value="">Select profile</option>
            {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.displayName} / {profile.model}</option>)}
          </select>
        </label>
      ) : null}
      <fieldset className="creatio-settings-category"><legend>Connection</legend><div className="assistant-profile-grid">
        <label>Name<input data-testid="assistant-profile-name" value={draft.displayName} onChange={event => setDraft({ ...draft, displayName: event.target.value })} /></label>
        <label>Provider<select data-testid="assistant-profile-provider" value={draft.provider} onChange={event=>setDraft(current=>({...current,provider:event.target.value,baseUrlSource:'value',baseUrl:event.target.value==='openai-compatible'?'http://host.docker.internal:11434/v1/':'http://host.docker.internal:11434',expectedDigest:'',authMode:'none',apiKey:''}))}><option value="ollama">Ollama (native)</option><option value="openai-compatible">OpenAI-compatible</option></select></label>
        {draft.provider==='ollama'?<label>Endpoint<input data-testid="assistant-profile-endpoint" value={draft.baseUrl} onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} /></label>:<ConnectionValueField config={draft} name="baseUrl" label="API base URL" testId="assistant-profile-endpoint" onChange={patch=>setDraft(current=>({...current,...patch}))} />}
        {draft.provider==='openai-compatible'&&<>
          <label>Authentication<select data-testid="assistant-profile-auth" value={draft.authMode} onChange={event=>setDraft(current=>({...current,authMode:event.target.value,apiKey:''}))}><option value="none">None (local endpoint)</option><option value="bearer">API key (Bearer)</option><option value="api-key">API key (api-key header)</option></select></label>
          {draft.authMode !== 'none' && <ConnectionValueField config={draft} name="apiKey" label="API key" testId="assistant-profile-api-key" secret
            onChange={patch => setDraft(current => ({ ...current, ...patch }))}
            onReveal={async () => {
              if (!draft.id) return true;
              try {
                const result = await assistantApi.revealCredential(draft.id);
                setDraft(current => ({ ...current, apiKey: result.value }));
                return true;
              } catch (error) {
                setSettingsError(error instanceof Error ? error.message : 'Credential unavailable.');
                return false;
              }
            }} />}
          {activeProfile?.credentialReference&&draft.id===activeProfile.id&&draft.authMode!=='none'&&draft.apiKeySource==='value'&&<small>Saved key is retained if left blank. Enter a value to replace it.</small>}
        </>}
      </div></fieldset>
      <fieldset className="creatio-settings-category"><legend>Model and generation</legend><div className="assistant-profile-grid">
        {draft.provider==='openai-compatible'&&<>
          <label>Model / deployment<input data-testid="assistant-profile-model-name" value={draft.model} onChange={event=>setDraft(current=>({...current,model:event.target.value}))}/></label>
          <label>Output token parameter<select data-testid="assistant-profile-token-parameter" value={draft.tokenLimitParameter} onChange={event=>setDraft(current=>({...current,tokenLimitParameter:event.target.value}))}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
          <label>Reasoning effort<select data-testid="assistant-profile-reasoning" value={draft.reasoningEffort} onChange={event=>setDraft(current=>({...current,reasoningEffort:event.target.value}))}><option value="">Provider default (omit parameter)</option>{['none','low','medium','high'].map(value=><option key={value}>{value}</option>)}</select></label>
          <label className="model-sampling-toggle"><input type="checkbox" checked={draft.sendSampling} onChange={event=>setDraft(current=>({...current,sendSampling:event.target.checked}))}/> Send temperature and seed</label>
        </>}
        <label>{draft.provider==='ollama'?'Find cached model':'Find available model'}<input type="search" aria-label="Find cached model" value={modelSearch} onChange={event=>setModelSearch(event.target.value)}/></label>
        <label>{draft.provider==='ollama'?'Cached model':'Available models'}<select data-testid="assistant-profile-model" value={draft.model} onChange={event=>selectModel(event.target.value)}><option value={draft.model}>{draft.model}</option>{models.filter(model=>model.name!==draft.model&&model.name.toLowerCase().includes(modelSearch.toLowerCase())).map(model=><option key={model.name} value={model.name}>{model.name}{model.size?` / ${(model.size/1024**3).toFixed(1)} GiB`:''}</option>)}</select></label>
        <label>Context<input data-testid="assistant-profile-context" type="number" value={draft.numCtx} onChange={event => setDraft({ ...draft, numCtx: Number(event.target.value) })} /></label>
        <label>Request timeout (seconds)<input type="number" min={1} max={7200} value={draft.timeoutMs/1000} onChange={event=>setDraft(current=>({...current,timeoutMs:Number(event.target.value)*1000}))}/></label>
        {draft.provider==='ollama'&&<label>Thinking<select data-testid="assistant-profile-thinking" value={draft.thinkingMode} onChange={event => setDraft({ ...draft, thinkingMode: event.target.value, think: event.target.value !== "off" })}>{thinkingInvalid&&<option value={draft.thinkingMode}>{draft.thinkingMode} / unsupported by this model</option>}{thinkingModes.map(mode => <option key={mode} value={mode}>{mode}</option>)}</select></label>}
      </div>
      </fieldset>
      <p>Thinking is shown separately in Historia after the call finishes, never as the answer or automatic context. Changes apply to future executions. Context size is unchanged when selecting a model.</p>
      <p className="subtle-copy">{modelInfo?`Capabilities: ${modelInfo.capabilities.join(', ')||'not reported'}. ${modelInfo.thinking?'Thinking controls reported by Ollama.':'Thinking support is unknown; test this model before use.'}`:'Model capabilities unavailable; refresh models and test the connection.'}{modelInfo&&!modelInfo.capabilities.includes('tools')?' Native tool support is not confirmed.':''}</p>
      {thinkingInvalid&&<p role="status">Select a supported thinking mode before saving. This model may not permit thinking to be disabled.</p>}
      {draft.provider==='ollama'&&<><p className="subtle-copy">Pinned digest: <code>{draft.expectedDigest||'Not selected from cache'}</code></p>
      {cacheStatus.missing&&<p role="status">This model is no longer cached at this endpoint. Choose an installed model; no download will be attempted.</p>}
      {cacheStatus.digestChanged&&<p role="status">The cached tag now points to a different digest. <button type="button" onClick={()=>setDraft(current=>({...current,expectedDigest:cacheStatus.digest!}))}>Use refreshed digest</button></p>}
      <fieldset className="creatio-settings-category"><legend>Cached GPT-OSS profiles</legend><p>Select an installed model; no download is attempted.</p><div className="assistant-profile-actions">{OLLAMA_MODEL_PRESETS.map(preset=><button type="button" className="ghost-button" key={preset.model} data-testid={`assistant-preset-${preset.numCtx}`} disabled={settingsBusy||!models.some(item=>item.name===preset.model&&item.digest)} onClick={()=>setDraft(current=>({...current,...cachedModelProfile(preset.model,models)}))}>{preset.label}</button>)}</div></fieldset></>}
      {draft.provider==='openai-compatible'&&<p className="subtle-copy">Use the API base URL including /v1/ or /openai/v1/. In Docker, localhost is the container; use host.docker.internal for Ollama on this computer. Model discovery may be unavailable: enter the deployment name directly. Context is a client budget, not a remote allocation. Reasoning controls depend on the server.</p>}
      <div className="assistant-profile-actions">
        <button type="button" className="ghost-button" data-testid="assistant-profile-new" disabled={settingsBusy} onClick={() => setDraft(current => ({ ...current, id: undefined, displayName: 'New model connection', apiKey: '', expectedDigest: '' }))}>New profile</button>
        <button type="button" className="ghost-button" data-testid="assistant-profile-discover" disabled={settingsBusy} onClick={() => void settingsAction(async () => {
          const generation = ++discoveryGeneration.current;
          const result = await assistantApi.discoverModels(draft.baseUrl,draft);
          if (generation === discoveryGeneration.current) {setModels(result.models);setModelsLoaded(true);}
        })}>Refresh models</button>
        <button type="button" className="ghost-button" data-testid="assistant-profile-save" disabled={settingsBusy||(draft.provider==='ollama'&&(thinkingInvalid||cacheStatus.missing||cacheStatus.digestChanged))} onClick={() => void settingsAction(async()=>{await saveProfile({...draft,expectedUpdatedAt:draft.id===activeProfile?.id?activeProfile.updatedAt:undefined});setDraft(current=>({...current,apiKey:''}));})}>Save and select</button>
        <button type="button" className="ghost-button" disabled={settingsBusy} onClick={()=>{setDraft(current=>({...current,apiKey:''}));setCancelVersion(value=>value+1);setSettingsError('');}}>Cancel changes</button>
        {activeProfile ? <button type="button" className="ghost-button" disabled={settingsBusy} onClick={() => void settingsAction(() => testProfile(activeProfile.id))}>Test connection</button> : null}
      </div>
      {activeProfile?.capability ? (
        <div className="assistant-profile-capability" data-testid="assistant-profile-capability"
          data-gpu-residency={activeProfile.capability.gpuResidency ?? 0}
          data-context-length={activeProfile.capability.contextLength ?? 0}
          data-acceptance-ready={activeProfile.capability.acceptanceReady ? "1" : "0"}>
          <Cpu size={13} /> {activeProfile.provider==='openai-compatible'?(activeProfile.capability.toolCapable?'Connected / native tools verified':'Connected / tool support not verified'):`${gpu.loaded ? 'Loaded' : 'Installed'} / ${gpu.label}`}
        </div>
      ) : null}
      <details className="assistant-workspace-context" data-testid="assistant-workspace-context">
        <summary>Workspace notes</summary>
        <p>Optional terminology and schema notes. After saving, select this guide in a node's Additional context section. Notes cannot add tools, bypass approvals, or change security policy.</p>
        <label>Title<input data-testid="assistant-context-title" maxLength={120} value={contextDraft.title}
          onChange={event => setContextDraft({ ...contextDraft, title: event.target.value })} /></label>
        <label>Markdown guidance<textarea data-testid="assistant-context-content" maxLength={20_000} rows={7} value={contextDraft.content}
          placeholder="Describe domain terms, stream meanings, units, and analytical conventions for this workspace."
          onChange={event => setContextDraft({ ...contextDraft, content: event.target.value })} /></label>
        <div className="assistant-profile-actions">
          <button type="button" className="ghost-button" data-testid="assistant-context-save"
            disabled={settingsBusy || !contextDraft.content.trim()} onClick={() => void settingsAction(() => saveWorkspaceContext(contextDraft))}>Save context</button>
          {workspaceContext ? <button type="button" className="ghost-button" data-testid="assistant-context-clear"
            disabled={settingsBusy} onClick={() => void settingsAction(() => deleteWorkspaceContext())}>Clear</button> : null}
        </div>
      </details>
      <details className="assistant-workspace-context" data-testid="assistant-workspace-skills">
        <summary>Additional context guides</summary>
        <p>Optional Markdown guides for your terminology, business rules, or preferred workflows. These give the agent information, not permissions. Attach a saved guide in a node's Additional context section.</p>
        <label>Title<input data-testid="assistant-skill-title" maxLength={120} value={skillDraft.title}
          onChange={event => setSkillDraft({ ...skillDraft, title: event.target.value })} /></label>
        <label>Kind<select data-testid="assistant-skill-kind" value={skillDraft.kind}
          onChange={event => setSkillDraft({ ...skillDraft, kind: event.target.value })}>
          <option value="domain">Domain</option><option value="terminology">Terminology</option>
          <option value="workflow">Workflow</option><option value="preference">Preference</option>
        </select></label>
        <label>Markdown guide<textarea data-testid="assistant-skill-content" maxLength={20_000} rows={5} value={skillDraft.content}
          onChange={event => setSkillDraft({ ...skillDraft, content: event.target.value })} /></label>
        <button type="button" className="ghost-button" data-testid="assistant-skill-save"
          disabled={settingsBusy || !skillDraft.title.trim() || !skillDraft.content.trim()}
          onClick={() => void settingsAction(async () => { await saveWorkspaceSkill(skillDraft); setSkillDraft({ title: "", kind: "domain", content: "" }); })}>Add guide</button>
        {workspaceSkills.length ? <ul className="assistant-skill-list">
          {workspaceSkills.filter(skill => !String(skill.id).startsWith("legacy:")).map(skill => (
            <li key={skill.id} data-testid="assistant-skill-item" data-skill-id={skill.id} data-skill-version={skill.version}>
              <div><strong>{skill.title}</strong><span>{skill.kind} / v{skill.version}</span></div>
              <button type="button" className="ghost-button" disabled={settingsBusy} onClick={() => void settingsAction(() => deleteWorkspaceSkill(skill.id))}>Remove</button>
            </li>
          ))}
        </ul> : null}
      </details>
      {settingsBusy && <ActivityIndicator label="Updating settings" />}
      {settingsError && <p role="alert" data-testid="assistant-settings-error">{settingsError}</p>}
    </details>
  );
}

export function AssistantPanel({
  workspaceId,
  surface,
  context,
  allowProfileAdmin = false,
  compact = false,
  surfaceLabel,
  onClose,
  onEditAgent
}: Props) {
  const initialize = useAssistantStore(state => state.initialize);
  const conversation = useAssistantStore(state => state.conversation);
  const activeProfile = useAssistantStore(state => state.activeProfile);
  const loading = useAssistantStore(state => state.loading);
  const error = useAssistantStore(state => state.error);
  const send = useAssistantStore(state => state.send);
  const cancel = useAssistantStore(state => state.cancel);
  const clarify = useAssistantStore(state => state.clarify);
  const refresh = useAssistantStore(state => state.refresh);
  const clearConversation = useAssistantStore(state => state.clearConversation);
  const [confirmClear,setConfirmClear]=useState(false);
  const [input, setInput] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const scrollFollower = useRef(createAssistantScrollFollower());
  const presentation = assistantPanelPresentation(activeProfile, conversation, loading);
  const canCancel=canCancelAssistantConversation(conversation,loading);

  useEffect(() => { void initialize(workspaceId, surface); }, [initialize, surface, workspaceId]);
  useEffect(()=>{setInput('');setConfirmClear(false);},[workspaceId,conversation?.id]);
  useEffect(() => {
    const id = conversation?.id;
    if (!id) return undefined;
    const events = new EventSource(`/api/assistant/conversations/${id}/events`);
    const update = () => void refresh();
    ["assistant-message", "tool-call", "tool-completed", "tool-failed", "approval-required", "clarification-required", "clarification-resolved", "task-plan-created", "task-updated", "task-needs-attention", "answer-synthesis-started", "generation-completed", "generation-failed", "generation-interrupted"].forEach(name => events.addEventListener(name, update));
    events.addEventListener("client-action", event => {
      const action = JSON.parse((event as MessageEvent).data).action;
      const debugBridge = (window as any).__chronoscope_debug;
      applyAssistantClientAction(action, debugBridge);
    });
    return () => events.close();
  }, [conversation?.id, refresh]);

  const conversationItems = useMemo(() => assistantConversationItems(conversation), [conversation]);
  const taskPlan = useMemo(() => assistantTaskPlan(conversation), [conversation]);
  useLayoutEffect(() => { scrollFollower.current.reset(); }, [conversation?.id]);
  useLayoutEffect(() => {
    scrollFollower.current.follow(messagesRef.current);
    const frame = window.requestAnimationFrame(() => scrollFollower.current.follow(messagesRef.current));
    return () => window.cancelAnimationFrame(frame);
  }, [conversationItems, loading, conversation?.clarification?.id]);
  useEffect(() => {
    const element = messagesRef.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => scrollFollower.current.follow(element));
    });
    observer.observe(element);
    if (messagesContentRef.current) observer.observe(messagesContentRef.current);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, []);
  const submit = async () => {
    const value = input;
    setInput("");
    await send(value, context);
  };
  const visibleSurface = surfaceLabel ?? surface;
  const openHistoria = (actionId: string) => window.dispatchEvent(new CustomEvent("chronosql:open-historia", { detail: { actionId } }));

  return (
    <section className={`assistant-panel${compact ? " is-compact" : ""}`} data-testid={`assistant-panel-${surface}`}
      data-surface={surface} data-conversation-id={conversation?.id ?? ""} data-state={presentation.state}
      data-pending-approval-count={presentation.pendingCount} data-has-conversation={presentation.hasConversation ? "1" : "0"}
      data-active-profile-id={activeProfile?.id ?? ""} data-active-model={activeProfile?.model ?? ""}>
      <header>
        <div><Bot size={17} /><strong>Consilium AI Assistant</strong><span>{visibleSurface}</span></div>
        <div>
          {onEditAgent && <button type="button" className="ghost-button" data-testid="assistant-edit-agent" onClick={onEditAgent}><Settings2 size={14} /> Edit Agent</button>}
          <button type="button" className="ghost-button" data-testid="assistant-clear-chat" disabled={!canClearAssistantConversation(conversation,loading)} title="Clear chat after the agent finishes or is canceled" onClick={()=>setConfirmClear(true)}><Trash2 size={14}/> Clear chat</button>
          {loading ? <ActivityIndicator size={15} /> : null}
          {onClose ? (
            <button type="button" className="assistant-close-button" onClick={()=>{setInput('');setConfirmClear(false);onClose();}} aria-label="Close Consilium AI Assistant">
              <X size={16} />
            </button>
          ) : null}
        </div>
      </header>
      {confirmClear&&<div className="assistant-clear-confirm" role="group" aria-label="Confirm clear chat"><p>Start a new conversation? Previous messages remain in Historia until AI history is cleared. Agent definitions and model profiles are kept.</p><button type="button" onClick={()=>setConfirmClear(false)}>Cancel</button><button type="button" data-testid="assistant-clear-chat-confirm" disabled={!canClearAssistantConversation(conversation,loading)} onClick={()=>{setInput('');setConfirmClear(false);void clearConversation();}}>Clear conversation</button></div>}
      {allowProfileAdmin ? <ProfileSettings workspaceId={workspaceId} /> : (
        <div className="assistant-profile-summary"><Cpu size={13} /> {presentation.profileLabel}</div>
      )}
      <div className="assistant-context-strip" data-testid="assistant-context-strip">
        <span>{workspaceId}</span><span>{visibleSurface}</span>{context.activeRun ? <span>run attached</span> : null}
      </div>
      {taskPlan?.tasks.length ? (
        <section
          className="assistant-task-plan"
          data-testid="assistant-task-plan"
          data-turn-id={taskPlan.id}
          data-turn-status={taskPlan.status}
          data-completed-count={taskPlan.completedCount}
          data-task-count={taskPlan.totalCount}
        >
          <header><strong>Requested tasks</strong><span>{taskPlan.completedCount} of {taskPlan.totalCount} complete</span></header>
          <ol>
            {taskPlan.tasks.map((task: any) => (
              <li key={task.id} data-testid="assistant-task-item" data-task-id={task.id} data-task-status={task.status} data-task-surface={task.surface}
                data-attempt-count={task.attemptCount ?? 0} data-recovery-count={task.recoveryCount ?? 0} data-has-error={task.error ? "1" : "0"}>
                <span className="assistant-task-status-icon" aria-label={task.label}>
                  {task.status === "completed" ? <Check size={13} />
                    : task.status === "failed" || task.status === "rejected" || task.status === "canceled" ? <X size={13} />
                    : task.id === taskPlan.currentTaskId && (loading || conversation?.state==='generating') && ["active","executing","recovering","verifying"].includes(task.status) ? <ActivityIndicator size={13} />
                        : <Circle size={11} />}
                </span>
                <div><strong>{task.title}</strong><span>{task.label}{task.activity ? ` / ${task.activity}` : ""}</span>
                  {task.error ? <em data-testid="assistant-task-error">{task.error}</em> : null}</div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <div className="assistant-messages" aria-live="polite" ref={messagesRef} data-testid="assistant-messages"
        onScroll={event => scrollFollower.current.onScroll(event.currentTarget)}
        onWheel={event => { if (event.deltaY < 0) scrollFollower.current.detach(); }}
        onClickCapture={event => { if ((event.target as HTMLElement).closest('summary')) scrollFollower.current.detach(); }}>
        <div ref={messagesContentRef}>
        {conversationItems.map((item: any) => item.kind === "tool-activity" ? (
          <article key={item.id} className="assistant-message is-tool-activity" data-role="assistant" data-testid="assistant-tool-activity">
            <small>assistant activity</small>
            {item.thinking ? <details className="assistant-thinking" data-testid="assistant-thinking"><summary>Thinking...</summary><AssistantMarkdown>{item.thinking}</AssistantMarkdown></details> : null}
            {item.message.content ? <AssistantMarkdown>{item.message.content}</AssistantMarkdown> : null}
            <div className="assistant-tool-activity-list">
              {item.actions.map((action: any) => (
                <div key={action.actionId} className="assistant-tool-activity-item" data-action-id={action.actionId} data-tool-name={action.toolName} data-status={action.status}>
                  <div><strong>{action.explanation}</strong><span>{action.toolName} / {action.status}</span></div>
                  {!action.actionId.startsWith("requested-") ? (
                    <button type="button" data-testid="assistant-tool-historia-link" onClick={() => openHistoria(action.actionId)} title={`Open ${action.actionId} in Historia`} aria-label={`Open action ${action.actionId} in Historia`}>
                      <Link2 size={13} /><code>{action.actionId}</code>
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </article>
        ) : (
          <article key={item.id} className={`assistant-message is-${item.message.role}${item.message.pending ? " is-pending" : ""}`} data-role={item.message.role} data-pending={item.message.pending ? "1" : "0"}
            data-testid={item.message.payload?.finalAnswer ? "assistant-final-answer" : undefined}
            data-final-answer={item.message.payload?.finalAnswer ? "1" : "0"}
            data-answer-source={item.message.payload?.answerSource ?? ""}
            data-answer-validation={item.message.payload?.answerValidation ?? ""}
            data-answer-turn-id={item.message.payload?.turnId ?? ""}
            data-answer-evidence-count={item.message.payload?.evidenceCount ?? 0}>
            <small>{item.message.payload?.messageKind === 'progress' ? 'Assistant update' : item.message.role}</small>
            {item.message.payload?.providerThinking ? <details className="assistant-thinking" data-testid="assistant-thinking"><summary>Thinking...</summary><AssistantMarkdown>{item.message.payload.providerThinking}</AssistantMarkdown></details> : null}
            {item.message.role === "assistant"
              ? <AssistantMarkdown>{item.message.content}</AssistantMarkdown>
              : <p>{item.message.content}</p>}
          </article>
        ))}
        {loading ? (
          <article className="assistant-message is-processing" data-testid="assistant-processing-state" aria-live="polite">
            <ActivityIndicator size={15} /><div><strong>{presentation.processingTitle}</strong><span>{presentation.processingDetail}</span></div>
          </article>
        ) : null}
        {!conversation?.messages?.length ? <div className="assistant-empty">Ask about the query, selected trace, or analytical canvas.</div> : null}
        </div>
      </div>
      {conversation?.clarification ? (
        <section className="assistant-clarification" data-testid="assistant-clarification"
          data-clarification-id={conversation.clarification.id} data-round={conversation.clarification.round}>
          <AssistantMarkdown>{conversation.clarification.prompt}</AssistantMarkdown>
          {conversation.clarification.presentation?.kind === 'approval' && <div className="assistant-approval-explanation" data-testid="assistant-approval-explanation">
            <p><strong>Why:</strong> {conversation.clarification.presentation.reason}</p>
            <p><strong>Expected result:</strong> {conversation.clarification.presentation.expectedOutcome}</p>
            {conversation.clarification.presentation.repeatWarning && <p role="alert" data-testid="assistant-repeat-warning">{conversation.clarification.presentation.repeatWarning}</p>}
            <ul>{conversation.clarification.presentation.actions.map((action:any)=><li key={action.requestId}><code>{action.name}</code>{action.repeated?' / repeats a successful action':''}</li>)}</ul>
            <small>Only these exact prepared actions are approved. Full arguments and revision evidence are available in Historia.</small>
          </div>}
          {conversation.clarification.recommendation ? <p>Recommended: {conversation.clarification.recommendation}</p> : null}
          <div className="assistant-clarification-options">
            {conversation.clarification.options.map((option: string) => (
              <button key={option} type="button" className="ghost-button" onClick={() => void clarify(conversation.clarification.id, option)}>{conversation.clarification.presentation?.kind==='approval'?(option==='approve'?'Approve actions':option==='deny'?'Do not approve':option):option}</button>
            ))}
          </div>
          <label>{conversation.clarification.presentation?.kind==='approval'?'Feedback or alternative instructions (does not approve)':'Or clarify in your own words'}
            <textarea data-testid="assistant-clarification-response" rows={2}
              onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  const value = event.currentTarget.value;
                  event.currentTarget.value = "";
                  void clarify(conversation.clarification.id, value);
                }
              }} />
          </label>
        </section>
      ) : null}
      {error ? <div className="assistant-error"><CircleAlert size={14} /> {error}</div> : null}
      <footer>
        <textarea data-testid="assistant-message-input" value={input} onChange={event => setInput(event.target.value)} placeholder={`Ask Consilium AI in ${visibleSurface}...`}
          onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} />
        {canCancel ? <button type="button" className="ghost-button" onClick={()=>void cancel()} aria-label="Stop assistant" title="Cancel active or paused agent work"><Square size={15} /></button>
          : <button type="button" className="primary-button" disabled={!input.trim() || !presentation.canSend} onClick={() => void submit()} aria-label="Send to assistant"><Send size={15} /></button>}
      </footer>
    </section>
  );
}
