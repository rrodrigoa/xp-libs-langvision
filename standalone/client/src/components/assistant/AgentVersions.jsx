import { useEffect, useState } from 'react';
import { ComponentSettingsDialog } from '../ComponentSettingsDialog';
import { ActivityIndicator } from '../ActivityIndicator';
import { agentDesignRequest } from './agentDesignApi.js';

export function AgentVersions({ workspaceId, agentId, draftVersion, onClose, onClone, onActivate }) {
  const [data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const path=`/workflows/${encodeURIComponent(agentId)}/versions`;
  useEffect(()=>{
    const controller=new AbortController();
    agentDesignRequest(`${path}?workspaceId=${encodeURIComponent(workspaceId)}`,{signal:controller.signal}).then(setData).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return ()=>controller.abort();
  },[path,workspaceId]);
  async function act(work) {
    setBusy(true);setError('');
    try {await work();setData(await agentDesignRequest(`${path}?workspaceId=${encodeURIComponent(workspaceId)}`));}
    catch(error){setError(error.message);}finally{setBusy(false);}
  }
  return <ComponentSettingsDialog surfaceLabel="Consilium" title="Workflow versions" onClose={busy?()=>{}:onClose}>
    <h3>Workflow versions</h3>
    <p>Each immutable agent revision includes all four workflows and their bindings. Activation switches them together; running turns keep their original revision. Clone a revision into the working draft to edit it.</p>
    <p>Cloning replaces the saved working draft. Deleted revisions disappear from this list, but their pinned execution history is retained.</p>
    {!data&&!error&&<ActivityIndicator label="Loading versions"/>}
    <div className="ai-version-list" data-testid="ai-version-list">{data?.versions.map(item=><VersionRow key={item.version} item={item} busy={busy} onRename={label=>act(()=>agentDesignRequest(`${path}/${item.version}`,{method:'PATCH',body:{workspaceId,label,expectedRevision:item.revision}}))}
      onDelete={()=>act(()=>agentDesignRequest(`${path}/${item.version}`,{method:'DELETE',body:{workspaceId,expectedRevision:item.revision}}))}
      onClone={()=>act(async()=>{const draft=await agentDesignRequest(`${path}/${item.version}/clone`,{method:'POST',body:{workspaceId,expectedDraftVersion:draftVersion}});onClone(draft);onClose();})}
      onActivate={()=>act(async()=>{const version=await agentDesignRequest(`${path}/${item.version}/activate`,{method:'POST',body:{workspaceId,expectedActive:data.active}});onActivate(version);})}/>)}</div>
    {error&&<p role="alert">{error}</p>}<button onClick={onClose} disabled={busy}>Done</button>
  </ComponentSettingsDialog>;
}
function VersionRow({item,busy,onRename,onDelete,onClone,onActivate}) {
  const [label,setLabel]=useState(item.label),[confirm,setConfirm]=useState(null);
  useEffect(()=>setLabel(item.label),[item.label]);
  return <section className="creatio-settings-category" data-testid={`ai-version-${item.version}`}>
    <h4>v{item.version}{item.active?' / Active':''}</h4>
    <label>Version name<input value={label} maxLength={100} onChange={event=>setLabel(event.target.value)}/></label>
    <p>{item.workflows.map(workflow=>workflow.name).join(' / ')}</p>
    <div className="ai-design-dialog-actions">
      <button disabled={busy||!label.trim()||label===item.label} onClick={()=>onRename(label)}>Rename</button>
      <button disabled={busy} onClick={()=>setConfirm('clone')}>Clone to draft</button>
      <button disabled={busy||item.active} onClick={()=>setConfirm('activate')}>Activate</button>
      <button disabled={busy||item.active} title={item.active?'Active versions cannot be deleted':undefined} onClick={()=>setConfirm('delete')}>Delete</button>
    </div>
    {confirm&&<div role="group" aria-label={`Confirm ${confirm}`}><p>{confirm==='clone'?'Replace the saved working draft with this revision?':confirm==='activate'?'Use this revision for new turns?':'Remove this version from the list? Historical executions are retained.'}</p><button disabled={busy} onClick={()=>setConfirm(null)}>Cancel</button><button disabled={busy} onClick={()=>{setConfirm(null);(confirm==='clone'?onClone:confirm==='activate'?onActivate:onDelete)();}}>Confirm {confirm}</button></div>}
  </section>;
}
