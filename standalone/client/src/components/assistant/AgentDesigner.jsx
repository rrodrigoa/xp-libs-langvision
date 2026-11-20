import { useEffect, useState } from 'react';
import { useAssistantStore } from '../../stores/assistantStore';
import { agentDesignRequest } from './agentDesignApi.js';
import { PrimitiveAgentDesigner } from './PrimitiveAgentDesigner.jsx';
import { AgentExecutionTrace } from './AgentExecutionTrace.jsx';
import { ActivityIndicator } from '../ActivityIndicator';
import { ComponentSettingsDialog } from '../ComponentSettingsDialog';

export function AgentDesigner({ workspaceId, onClose, inspection, onInspectionClose }) {
  const [catalog, setCatalog] = useState(null), [draft, setDraft] = useState(null);
  const [error, setError] = useState(''), [clone, setClone] = useState(null);
  const profiles = useAssistantStore(state => state.profiles);
  const conversationId = useAssistantStore(state => state.conversation?.id);
  const [live, setLive] = useState(null);
  useEffect(() => {
    if (!conversationId) return;
    const events = new EventSource(`/api/assistant/conversations/${encodeURIComponent(conversationId)}/events`);
    events.addEventListener('node-activity', event => setLive(JSON.parse(event.data).activity));
    return () => { events.close(); setLive(null); };
  }, [conversationId]);
  const initialize = useAssistantStore(state => state.initialize);
  useEffect(() => { void initialize(workspaceId, 'creatio'); }, [workspaceId, initialize]);
  useEffect(() => {
    const controller = new AbortController();
    agentDesignRequest(`/workflows?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal }).then(value => {
      let remembered;
      try { remembered = localStorage.getItem(`consilium-designer-${workspaceId}`); } catch { /* Optional preference. */ }
      if (remembered === 'consilium-primitive' && value.activeId === 'langvision-coding-agent') remembered = null;
      setCatalog(value);
      setDraft(value.workflows.find(item => item.id === remembered) ?? value.workflows.find(item => item.id === value.activeId));
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [workspaceId]);
  const select = item => {
    setDraft(item);
    try { localStorage.setItem(`consilium-designer-${workspaceId}`, item.id); } catch { /* Optional preference. */ }
  };
  if (inspection) return <section className="ai-design-page" data-testid="ai-agent-inspection">
    <header className="workspace-toolbar"><h2>Consilium / Execution inspection</h2><button onClick={onInspectionClose}>Return to working draft</button><button onClick={onClose}>Back to Historia</button></header>
    <p>Read-only pinned execution. Historical definitions and evidence are preserved.</p>
    <AgentExecutionTrace workspaceId={workspaceId} actionId={inspection.actionId} initialSelection={inspection} editorMode onClone={workflow => setClone(workflow)} />
    {clone && <ComponentSettingsDialog surfaceLabel="Consilium" title="Clone inspected revision" onClose={() => setClone(null)}>
      <p>Replace the saved working draft with revision {clone.version}? The active version and historical run remain unchanged. Retired staged revisions are read-only.</p>
      <button onClick={() => setClone(null)}>Cancel</button><button data-testid="ai-clone-inspected-confirm" onClick={async () => {
        try {
          const source = catalog.workflows.find(item => item.id === clone.id);
          if (!source) throw new Error('This historical agent is retired or deleted; its evidence remains inspectable.');
          const saved = await agentDesignRequest(`/workflows/${encodeURIComponent(source.id)}/versions/${clone.version}/clone`, { method: 'POST', body: { workspaceId, expectedDraftVersion: source.draftVersion ?? 0 } });
          select({ ...saved, version: source.version }); setClone(null); onInspectionClose();
        } catch (error) { setError(error.message); }
      }}>Clone to working draft</button>{error && <p role="alert">{error}</p>}
    </ComponentSettingsDialog>}
  </section>;
  if (error) return <p role="alert">{error}</p>;
  if (!draft || !catalog) return <ActivityIndicator label="Loading agent" />;
  return <PrimitiveAgentDesigner key={draft.id} workspaceId={workspaceId} draft={draft} catalog={catalog} profiles={profiles} live={live?.graphVersion?.startsWith(draft.id + '@') ? live : null} onDraft={setDraft} onCatalog={setCatalog} onSelect={select} onClose={onClose} />;
}
