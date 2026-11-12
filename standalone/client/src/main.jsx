import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentDesigner } from './components/assistant/AgentDesigner.jsx';
import { AssistantPanel } from './components/assistant/AssistantPanel.tsx';
import { AgentExecutionTrace } from './components/assistant/AgentExecutionTrace.jsx';
import { HistoriaSplit } from './components/assistant/HistoriaSplit.jsx';
import './styles.css';
import './shell.css';

const workspaceId = 'default';
const read = async (path, method = 'GET', value) => {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? 'Request failed.');
  return payload;
};
function Historia() {
  const [entries, setEntries] = useState([]), [cursor, setCursor] = useState(null);
  const [selected, setSelected] = useState(null), [error, setError] = useState('');
  async function load(after = null) {
    try {
      const result = await read('/api/assistant/executions?workspaceId=default' + (after ? '&cursor=' + encodeURIComponent(after) : ''));
      setEntries(current => after ? [...current, ...result.entries] : result.entries);
      setCursor(result.nextCursor);
      setSelected(current => current ?? result.entries[0]?.actionId ?? null);
    } catch (failure) { setError(failure.message); }
  }
  useEffect(() => { void load(); }, []);
  return <section className="lv-history"><header className="workspace-toolbar"><h2>Historia</h2><button onClick={() => load()}>Refresh</button></header>
    {error && <p role="alert">{error}</p>}
    <HistoriaSplit className="lv-history-split">
      <aside aria-label="Agent turns">{entries.map(entry => <button type="button" key={entry.id} aria-pressed={selected === entry.actionId}
        onClick={() => setSelected(entry.actionId)}><strong>{entry.title}</strong><small>{entry.status} · {entry.createdAt}</small></button>)}
        {cursor && <button onClick={() => load(cursor)}>Load older turns</button>}{!entries.length && <p>No agent turns yet.</p>}</aside>
      <article>{selected && <AgentExecutionTrace key={selected} workspaceId={workspaceId} actionId={selected} />}</article>
    </HistoriaSplit>
  </section>;
}
function Connections({ onUpdated }) {
  const [connections, setConnections] = useState([]);
  const [form, setForm] = useState({ id: '', url: '', tools: [], tokenEnv: '', enabled: false });
  const [message, setMessage] = useState('');
  async function list() { setConnections(await read('/api/mcp-connections')); }
  useEffect(() => { void list().catch(error => setMessage(error.message)); }, []);
  const update = event => setForm({ ...form, [event.target.name]: event.target.value });
  return <section className="lv-settings"><h2>MCP connections</h2>
    <p>Connect an HTTP MCP server and allowlist the exact tools this instance may use. All external tool calls require local approval.</p>
    <label>Saved connection<select value={connections.some(item => item.id === form.id) ? form.id : ''} onChange={event => setForm(connections.find(item => item.id === event.target.value) ?? { id: '', url: '', tools: [], tokenEnv: '', enabled: false })}>
      <option value="">New connection</option>{connections.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
    <label>Connection ID<input name="id" value={form.id} onChange={update} /></label>
    <label>MCP endpoint<input name="url" value={form.url} onChange={update} /></label>
    <label>Bearer token environment variable<input name="tokenEnv" value={form.tokenEnv} onChange={update} placeholder="LANGVISION_SECRET_MCP_TOKEN" /></label>
    <label>Allowed tool names, comma separated<input value={form.tools.join(',')} onChange={event => setForm({ ...form, tools: event.target.value.split(',') })} /></label>
    <label><input type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} /> Trust and enable this endpoint</label>
    <div className="lv-actions"><button onClick={async () => {
      try {
        const saved = await read('/api/mcp-connections', 'PUT', { ...form, tools: form.tools.map(tool => tool.trim()).filter(Boolean) });
        setForm(saved); await list(); setMessage('Connection saved. Refresh tools to use the allowlist.'); onUpdated();
      } catch (error) { setMessage(error.message); }
    }}>Save connection</button><button onClick={async () => {
      try {
        const result = await read('/api/mcp-connections/' + encodeURIComponent(form.id) + '/discover', 'POST', {});
        setMessage('Discovered: ' + result.available.join(', ') + '. Enabled: ' + (result.enabled.join(', ') || 'none') + '.'); onUpdated();
      } catch (error) { setMessage(error.message); }
    }}>Refresh tools</button></div><p role="status">{message}</p>
  </section>;
}
function Packages({ onImported }) {
  const [agents, setAgents] = useState([]), [selected, setSelected] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => { read('/api/assistant/workflows?workspaceId=default').then(value => {
    setAgents(value.workflows); setSelected(value.activeId ?? '');
  }).catch(error => setStatus(error.message)); }, []);
  return <section className="lv-settings"><h2>Agent packages</h2>
    <p>Export the graph and non-secret resources as one file. Imports create inactive drafts with disabled MCP endpoints.</p>
    <label>Agent<select value={selected} onChange={event => setSelected(event.target.value)}>
      {agents.map(item => <option key={item.id} value={item.id}>{item.definition.name}</option>)}</select></label>
    {selected && <a download href={'/api/agent-packages/' + encodeURIComponent(selected)}>Download agent package</a>}
    <label>Import package<input type="file" accept=".json,application/json" onChange={async event => {
      const file = event.target.files[0]; if (!file) return;
      try {
        if (file.size > 4 * 1024 * 1024) throw new Error('Package exceeds the 4 MiB limit.');
        const result = await read('/api/agent-packages', 'POST', JSON.parse(await file.text()));
        setStatus('Draft imported. Bind a local model and enable only trusted MCP endpoints before activation.');
        onImported(result.id);
      } catch (error) { setStatus(error.message); }
      finally { event.target.value = ''; }
    }} /></label><p role="status">{status}</p>
  </section>;
}
function App() {
  const [tab, setTab] = useState('Agent Editor'), [chat, setChat] = useState(true);
  const [inspection, setInspection] = useState(null), [revision, setRevision] = useState(0);
  const updated = () => setRevision(value => value + 1);
  useEffect(() => {
    const inspect = event => { setInspection(event.detail); setTab('Agent Editor'); };
    window.addEventListener('consilium-inspect-execution', inspect);
    return () => window.removeEventListener('consilium-inspect-execution', inspect);
  }, []);
  return <main className="lv-shell"><header className="lv-header"><h1>LangVision</h1>
    <nav aria-label="Workspace">{['Agent Editor', 'Historia', 'MCP connections', 'Packages'].map(item => <button key={item}
      aria-pressed={tab === item} onClick={() => { setTab(item); setInspection(null); }}>{item}</button>)}</nav>
    <button onClick={() => setChat(value => !value)} aria-expanded={chat}>Agent chat</button></header>
    <div className={chat ? 'lv-content lv-with-chat' : 'lv-content'}>
      <div className="lv-workspace">
        {tab === 'Agent Editor' && <AgentDesigner key={revision} workspaceId={workspaceId} inspection={inspection}
          onInspectionClose={() => setInspection(null)} onClose={() => setTab('Historia')} />}
        {tab === 'Historia' && <Historia />}
        {tab === 'MCP connections' && <Connections onUpdated={updated} />}
        {tab === 'Packages' && <Packages onImported={id => { localStorage.setItem('consilium-designer-default', id); updated(); }} />}
      </div>
      <aside className="lv-chat" hidden={!chat}><AssistantPanel workspaceId={workspaceId} surface="ai" context={{}}
        allowProfileAdmin onClose={() => setChat(false)} onEditAgent={() => { setInspection(null); setTab('Agent Editor'); }} /></aside>
    </div>
  </main>;
}
createRoot(document.getElementById('root')).render(<App />);
