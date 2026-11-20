import { useEffect,useRef,useState } from 'react';
import dagre from 'dagre';
import { CompositionFlow } from '../CompositionFlow.jsx';
import { AgentNode } from './AgentGraphNode.jsx';
import { presentAgentEdges,agentWorkflowCallTarget } from './agentGraphPresentation.js';

const nodeTypes={agent:AgentNode};
export const workflowKey=purpose=>({conversation:'assistant','query-translation':'queryTranslation','tool-execution':'executionWorkflow','answer-synthesis':'synthesisWorkflow'}[purpose]??purpose??'assistant');

export function AgentExecutionGraph({bundle,attempt,attempts,onSelect,onEdge,view,onView}) {
  const [flow,setFlow]=useState(null);
  const host=useRef(null);
  const graph=bundle?.purpose?bundle:view==='assistant'?bundle:bundle?.[view];
  const graphKey=`${view}:${graph?.nodes.map(node=>node.id).join('|')}`;
  const [layout,setLayout]=useState(null);
  function arrange() {
    if(!graph)return;
    const geometry=new dagre.graphlib.Graph();geometry.setGraph({rankdir:'LR',nodesep:50,ranksep:100});geometry.setDefaultEdgeLabel(()=>({}));
    for(const node of graph.nodes)geometry.setNode(node.id,{width:260,height:200});
    for(const edge of graph.edges)if(geometry.hasNode(edge.source)&&geometry.hasNode(edge.target))geometry.setEdge(edge.source,edge.target);
    dagre.layout(geometry);
    setLayout({key:graphKey,positions:Object.fromEntries(graph.nodes.map(node=>{const point=geometry.node(node.id);return [node.id,{x:point.x-130,y:point.y-100}];}))});
  }
  useEffect(()=>{arrange();},[graphKey]);
  useEffect(()=>{
    if(!flow||!graph)return;
    let frame,canceled=false;
    const focus=()=>{
      if(canceled)return;
      const id=attempt?.metadata.nodeId,node=id?flow.getInternalNode(id):null,expected=layout?.key===graphKey?layout.positions[id]:null;
      if(flow.getNodes().some(node=>!flow.getInternalNode(node.id)?.measured?.width)||node&&expected&&(node.position.x!==expected.x||node.position.y!==expected.y)){frame=requestAnimationFrame(focus);return;}
      if(node&&host.current){const bounds=host.current.getBoundingClientRect(),position=node.internals.positionAbsolute;void flow.setViewport({x:bounds.width/2-position.x-node.measured.width/2,y:bounds.height/2-position.y-node.measured.height/2,zoom:1},{duration:150});}
      else void flow.fitView({padding:.15,maxZoom:1,duration:150});
    };
    frame=requestAnimationFrame(focus);return()=>{canceled=true;cancelAnimationFrame(frame);};
  },[flow,graphKey,layout,attempt?.attemptId]);
  if(!graph)return <p>Pinned workflow unavailable.</p>;
  const instances=attempts.filter(item=>(!attempt?.metadata.invocationId||item.metadata.invocationId===attempt.metadata.invocationId)&&workflowKey(item.metadata.subgraph??item.metadata.workflowId)===(bundle?.purpose?workflowKey(bundle.purpose):view));
  const positions=layout?.key===graphKey?layout.positions:{};
  const points=graph.nodes.map(node=>positions[node.id]??node.position??{x:0,y:0});
  const entry={x:Math.min(0,...points.map(point=>point.x)),y:points[0]?.y??0},exit={x:Math.max(600,...points.map(point=>point.x)),y:points.at(-1)?.y??0};
  const nodes=[...(graph.schemaVersion===5?[]:[{id:'__start__',type:'agent',position:{x:entry.x-310,y:entry.y},data:{label:'Start'}}]),...graph.nodes.map((node,index)=>{
    const calls=instances.filter(item=>item.metadata.nodeId===node.id),target=agentWorkflowCallTarget(node);
    return {...node,type:'agent',position:positions[node.id]??node.position??{x:index*310,y:0},selected:attempt?.metadata.nodeId===node.id,data:{...node,workflowTarget:bundle[target]?target:null,workflowName:bundle[target]?.name,openWorkflow:onView,executionStatus:calls.length?`${calls.length} attempt(s) / ${calls.at(-1).status}`:null}};
  }),...(graph.schemaVersion===5?[]:[{id:'__end__',type:'agent',position:{x:exit.x+310,y:exit.y},data:{label:'End'}}])];
  const traversed=new Set(instances.map(item=>`${item.metadata.nodeId}|${item.metadata.transition}|${item.metadata.nextNodeId}`));
  return <section data-testid="ai-execution-graph"><div className="ai-json-actions"><label>Executed workflow<select value={view} onChange={event=>onView(event.target.value)}>{['assistant','queryTranslation','executionWorkflow','synthesisWorkflow'].filter(key=>key==='assistant'||bundle[key]).map(key=><option key={key} value={key}>{key==='assistant'?bundle.name:bundle[key].name}</option>)}</select></label><button className="ghost-button" onClick={()=>void flow?.fitView({padding:.15,duration:200})}>Fit graph</button><button className="ghost-button" title="Arrange the inspection view without modifying the saved graph" onClick={arrange}>Auto layout</button></div>
    <div ref={host} className="ai-historical-graph" data-focus-node={attempt?.metadata.nodeId??''}><CompositionFlow key={view} onInit={setFlow} nodes={nodes} nodeTypes={nodeTypes} edges={presentAgentEdges(graph,{traversed,selectedId:attempt?.metadata.edgeId})} nodesDraggable={false} nodesConnectable={false} autoPanOnNodeFocus={false} deleteKeyCode={null} minZoom={.1} maxZoom={1.6}
      onNodeClick={(_event,node)=>{const choices=instances.filter(item=>item.metadata.nodeId===node.id);if(choices.length)onSelect(choices.at(-1),instances);}}
      onEdgeClick={(_event,edge)=>onEdge({edge,attempts:instances.filter(item=>item.metadata.nodeId===edge.source&&item.metadata.transition===(graph.schemaVersion===5?edge.id:edge.condition))})}/></div>
    {attempt&&<div className="ai-json-actions">{instances.filter(item=>item.metadata.nodeId===attempt.metadata.nodeId).map((item,index)=><button key={item.attemptId} aria-pressed={item.attemptId===attempt.attemptId} onClick={()=>onSelect(item,instances)}>Attempt {index+1} / {item.status}</button>)}</div>}
  </section>;
}
