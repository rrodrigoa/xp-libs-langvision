import { useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import { jsonBreadcrumbs,indexJsonDocument,jsonCursorPath } from '../../../../shared/agentJsonIndex.js';
import { agentDesignRequest } from './agentDesignApi.js';
import { ActivityIndicator } from '../ActivityIndicator';
import { ensureWorkspaceEditorTheme,WORKSPACE_EDITOR_THEME } from '../editorPresentation.js';
import { parseJsonText } from '../../../../shared/agentWaterfall.js';
import { jsonSearchRanges,localJsonMatches } from '../../../../shared/agentJsonSearch.js';

let configured=false;
function configureJson() {
  if(configured)return;configured=true;
  monaco.languages.register({id:'agent-json'});
  monaco.languages.setMonarchTokensProvider('agent-json',{tokenizer:{root:[[/"(?:[^"\\]|\\.)*"\s*(?=:)/,'key'],[/"(?:[^"\\]|\\.)*"/,'string'],[/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/,'number'],[/\b(?:true|false|null)\b/,'keyword'],[/[{}\[\]]/,'delimiter.bracket']]}});
  monaco.languages.setLanguageConfiguration('agent-json',{brackets:[['{','}'],['[',']']]});
  monaco.languages.registerFoldingRangeProvider('agent-json',{provideFoldingRanges(model){try{return indexJsonDocument(model.getValue(),{utf8:false}).filter(item=>['array','object'].includes(item.type)).map(item=>({start:model.getPositionAt(item.start).lineNumber,end:model.getPositionAt(item.start+item.length-1).lineNumber})).filter(item=>item.end>item.start);}catch{return [];}}});
}

const editorPositions=new Map();
function FormattedValue({ value, text,onPathChange,onSelection,editorApi,identity,search='',onSearchChange }) {
  const host = useRef(null);
  const instance=useRef(null),searchState=useRef({matches:[],index:0,decorations:[]});
  const serialized=text??JSON.stringify(value,null,2)??'undefined';
  const isJson=text===undefined&&value!==undefined;
  useEffect(() => {
    configureJson();
    ensureWorkspaceEditorTheme();
    const model = monaco.editor.createModel(serialized, isJson ? 'agent-json' : 'plaintext');
    const editor = monaco.editor.create(host.current, { model, theme:WORKSPACE_EDITOR_THEME,readOnly: true, domReadOnly:true, automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, folding: true, showFoldingControls:'always', lineNumbers:'on', wordWrap: 'on', fontSize: 12, contextmenu: false,stickyScroll:{enabled:true} });
    instance.current={model,editor};
    const indexed=isJson?indexJsonDocument(model.getValue(),{utf8:false}):[];
    const cursor=editor.onDidChangeCursorPosition(event=>onPathChange?.(jsonCursorPath(indexed,model.getOffsetAt(event.position))));
    const scroll=editor.onDidScrollChange(()=>{const line=editor.getVisibleRanges()[0]?.startLineNumber;if(line)onPathChange?.(jsonCursorPath(indexed,model.getOffsetAt({lineNumber:line,column:1})));});
    const selection=editor.onDidChangeCursorSelection(()=>onSelection?.(model.getValueInRange(editor.getSelection())));
    const selectMatch=(delta=0)=>{const state=searchState.current;if(!state.matches.length)return;state.index=(state.index+delta+state.matches.length)%state.matches.length;const range=state.matches[state.index].range;editor.setSelection(range);editor.revealRangeInCenter(range);onSearchChange?.({count:state.matches.length,index:state.index+1});};
    if(editorApi)editorApi.current={findNext(delta){selectMatch(delta);},reveal(path){const item=indexed.find(item=>item.path===path);if(item){const pos=model.getPositionAt(item.start);editor.setPosition(pos);editor.revealPositionInCenter(pos);editor.focus();}}};
    const saved=identity?editorPositions.get(identity):null;
    if(saved)editor.restoreViewState(saved);else if(isJson)void editor.getAction('editor.foldAll')?.run();
    return () => {if(identity){editorPositions.delete(identity);editorPositions.set(identity,editor.saveViewState());while(editorPositions.size>50)editorPositions.delete(editorPositions.keys().next().value);}cursor.dispose();scroll.dispose();selection.dispose();instance.current=null;searchState.current={matches:[],index:0,decorations:[]};editor.dispose(); model.dispose();if(editorApi)editorApi.current=null;};
  }, [serialized,isJson,onPathChange,onSelection,identity]);
  useEffect(()=>{
    const current=instance.current;if(!current)return;
    const matches=search?current.model.findMatches(search,false,false,false,null,false):[];
    const decorations=current.editor.deltaDecorations(searchState.current.decorations,matches.map(match=>({range:match.range,options:{inlineClassName:'ai-json-search-match',overviewRuler:{color:'#d6aa40',position:monaco.editor.OverviewRulerLane.Full}}})));
    searchState.current={matches,index:0,decorations};onSearchChange?.({count:matches.length,index:matches.length?1:0});
    if(matches.length){current.editor.setSelection(matches[0].range);current.editor.revealRangeInCenter(matches[0].range);}
  },[search,serialized,onSearchChange]);
  return <div className="ai-json-editor" ref={host} data-testid="ai-json-formatted" />;
}

function localValue(value, path) {
  let current=value;
  for(const crumb of jsonBreadcrumbs(path).slice(1)) {
    if(current===null||typeof current!=='object'||!Object.hasOwn(current,crumb.label))return undefined;
    current=current[crumb.label];
  }
  return current;
}
const childPath=(path,key)=>`${path}/${String(key).replace(/~/g,'~0').replace(/\//g,'~1')}`;
function MatchText({text,query}) {
  const ranges=jsonSearchRanges(text,query),parts=[];let offset=0;
  for(const range of ranges){parts.push(text.slice(offset,range.start),<mark key={range.start}>{text.slice(range.start,range.end)}</mark>);offset=range.end;}parts.push(text.slice(offset));return <>{parts}</>;
}
function ExpandableProperty({child,value,artifact,workspaceId}) {
  const [open,setOpen]=useState(false);
  return <details className="ai-json-expand" onToggle={event=>setOpen(event.currentTarget.open)}><summary aria-label={`Expand ${child.key}`}>Expand</summary>{open&&<JsonInspector value={value} workspaceId={workspaceId} artifact={artifact} initialPath={child.path}/>}</details>;
}

export function JsonInspector({ value, workspaceId, artifact, initialPath='' }) {
  const [path,setPath]=useState(initialPath),[after,setAfter]=useState(0),[textOffset,setTextOffset]=useState(0),[page,setPage]=useState(null),[error,setError]=useState(''),[formatted,setFormatted]=useState(true),[interpret,setInterpret]=useState(false),[query,setQuery]=useState('');
  const editorApi=useRef(null),[selection,setSelection]=useState(''),[selectionValue,setSelectionValue]=useState(null),[selectionError,setSelectionError]=useState(''),[full,setFull]=useState(false);
  const [cursorPath,setCursorPath]=useState('');
  const [searchResult,setSearchResult]=useState({count:0,index:0});
  const remote=Boolean(artifact),selected=remote?page?.value:localValue(value,path);
  const [delayedQuery,setDelayedQuery]=useState('');
  useEffect(()=>{const timer=setTimeout(()=>setDelayedQuery(query),200);return()=>clearTimeout(timer);},[query]);
  const serverQuery=formatted&&page?.path===path&&Object.hasOwn(page??{},'value')?'':delayedQuery;
  const navigate=next=>{setPath(next);setAfter(0);setTextOffset(0);setInterpret(false);setQuery('');setCursorPath('');setFull(false);setSelectionValue(null);setSelectionError('');};
  useEffect(()=>{navigate(initialPath);setPage(null);},[artifact?.id,initialPath]);
  useEffect(()=>{
    if(!remote)return;
    const controller=new AbortController();setError('');
    agentDesignRequest(`/debug/artifacts/${encodeURIComponent(artifact.id)}/value?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}&after=${after}&textOffset=${textOffset}&query=${encodeURIComponent(serverQuery)}&editor=true&full=${full}`,{signal:controller.signal})
      .then(result=>{if(!controller.signal.aborted)setPage(result);}).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return()=>controller.abort();
  },[remote,workspaceId,artifact?.id,path,after,textOffset,serverQuery,full]);
  const current=remote&&page?.path!==path?null:page;
  const keys=selected!==null&&typeof selected==='object'?Object.keys(selected).filter(key=>key.toLowerCase().includes(query.toLowerCase())):[];
  const localMatches=!remote&&query&&!formatted?localJsonMatches(selected,query,path):null;
  const children=remote?current?.children??[]:localMatches?localMatches.slice(after,after+50):keys.slice(after,after+50).map(key=>({path:childPath(path,key),key,type:selected[key]===null?'null':Array.isArray(selected[key])?'array':typeof selected[key],value:selected[key]}));
  const next=remote?current?.nextCursor:after+50<(localMatches?.length??keys.length)?after+50:null;
  let parsed;
  if(typeof selected==='string'){try{parsed=JSON.parse(selected);}catch{/* Keep non-JSON strings as text. */}}
  return <section className="ai-json-inspector" data-testid="ai-json-inspector" data-json-path={path} data-complete={remote?String(current?.complete??false):undefined}>
    <nav aria-label="JSON path" className="ai-json-breadcrumbs">{jsonBreadcrumbs(path+(formatted?cursorPath:'')).map(crumb=><button key={crumb.path} onClick={()=>{if(formatted&&editorApi.current&&(crumb.path===path||crumb.path.startsWith(path+'/')))editorApi.current.reveal(crumb.path.slice(path.length));else navigate(crumb.path);}} title={crumb.path||'/'}>{crumb.label||'(empty key)'}</button>)}</nav>
    <label className="ai-json-search">Find in JSON<input aria-label="Find JSON property" title="Search all field names and values" type="search" value={query} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();editorApi.current?.findNext(event.shiftKey?-1:1);}if(event.key==='Escape')setQuery('');}} onChange={event=>{setQuery(event.target.value);setAfter(0);}}/></label>
    {query&&formatted&&(!remote||Object.hasOwn(current??{},'value'))&&<div className="ai-json-actions"><span role="status" data-testid="ai-json-match-count">{searchResult.count?`${searchResult.index} of ${searchResult.count} matches`:'No matches'}</span><button disabled={!searchResult.count} onClick={()=>editorApi.current?.findNext(-1)}>Previous match</button><button disabled={!searchResult.count} onClick={()=>editorApi.current?.findNext(1)}>Next match</button><button onClick={()=>setQuery('')}>Clear search</button></div>}
    <div className="ai-json-actions"><button onClick={()=>void navigator.clipboard.writeText(path+(formatted?cursorPath:'')).catch(error=>setError(error.message))}>Copy path</button><button disabled={remote&&!Object.hasOwn(current??{},'value')} onClick={()=>void navigator.clipboard.writeText(JSON.stringify(formatted?localValue(selected,cursorPath):selected,null,2)??'undefined').catch(error=>setError(error.message))}>Copy value</button><button aria-pressed={formatted} onClick={()=>{setFormatted(value=>!value);setCursorPath('');}}>{formatted?'Tree':'Formatted JSON'}</button>{parsed!==undefined&&<button aria-pressed={interpret} onClick={()=>setInterpret(value=>!value)}>Open string as JSON</button>}</div>
    {interpret&&<JsonInspector value={parsed}/>}
    <div className="ai-json-actions"><button disabled={!selection.trim()} onClick={()=>{const result=parseJsonText(selection);if(result.error){setSelectionError(result.error);return;}setSelectionError('');setSelectionValue({value:result.value});}}>Format selection as JSON</button>{selectionError&&<span role="status">{selectionError}</span>}</div>
    {selectionValue&&<section role="region" aria-label="Parsed JSON selection" data-testid="ai-json-parsed-selection"><button onClick={()=>setSelectionValue(null)}>Back to original</button><JsonInspector value={selectionValue.value}/></section>}
    {error?<p role="status">{error}</p>:remote&&!current?<ActivityIndicator label="Loading captured value"/>:formatted&&remote&&!Object.hasOwn(current??{},'value')&&current?.type==='string'?<><p>This string exceeds automatic loading size. Load the complete value to inspect it without splitting its JSON representation.</p><button onClick={()=>setFull(true)}>Load complete value ({Number(current.bytes).toLocaleString()} bytes)</button></>:<>
      {formatted&&(!remote||Object.hasOwn(current??{},'value'))?<FormattedValue value={selected} onPathChange={setCursorPath} onSelection={setSelection} editorApi={editorApi} identity={artifact?`${artifact.id}:${path}`:undefined} search={query} onSearchChange={setSearchResult}/>:<>
        {children.length?<ul className="ai-json-properties">{children.map(child=><li key={child.path}><button onClick={()=>{navigate(child.path);setFormatted(true);}} data-json-path={child.path}><strong><MatchText text={query?child.path:child.key||'(empty key)'} query={query}/></strong><span>{child.type}{child.count!=null&&['object','array'].includes(child.type)?` / ${child.count} items`:''}</span></button>{child.type==='object'||child.type==='array'?<ExpandableProperty child={child} value={value} artifact={artifact} workspaceId={workspaceId}/>:Object.hasOwn(child,'value')&&<code><MatchText text={JSON.stringify(child.value)} query={query}/></code>}</li>)}</ul>:query?<p>No matches.</p>:current?.text!==undefined?<><FormattedValue text={current.text}/><span>Serialized text bytes from {current.textOffset}</span>{current.nextTextOffset!==null&&<button onClick={()=>setTextOffset(current.nextTextOffset)}>Next text section</button>}{textOffset>0&&<button onClick={()=>setTextOffset(0)}>First text section</button>}</>:<FormattedValue value={selected}/>}
        {formatted&&remote&&!Object.hasOwn(current??{},'value')&&children.length>0&&<p>Select a property to format its complete value. This collection is loaded in pages.</p>}
        {formatted&&remote&&!Object.hasOwn(current??{},'value')&&<button onClick={()=>setFull(true)}>Load complete value ({Number(current?.bytes??0).toLocaleString()} bytes)</button>}
      </>}
      <div className="ai-json-actions">{after>0&&<button onClick={()=>setAfter(Math.max(0,after-50))}>Previous properties</button>}{next!=null&&<button data-testid="ai-json-next" onClick={()=>setAfter(next)}>Next properties</button>}</div>
    </>}
  </section>;
}
