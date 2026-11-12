import { Handle, Position } from '@xyflow/react';
import { Settings2, Play, Flag, Network, Wrench } from 'lucide-react';
import { PRIMITIVE_TYPES } from '../../../../shared/primitiveAgentModel.js';
import { agentNodeRole, agentNodeCanRequestTools, AGENT_GRAPH_ROLES } from './agentGraphPresentation.js';
import { agentRoleIcons } from './AgentGraphLegend.jsx';
import { memo } from 'react';

export const AgentNode=memo(function AgentNode({data,id,selected}) {
  const role=agentNodeRole({id,handler:data.handler}),Icon=id==='__start__'?Play:id==='__end__'?Flag:agentRoleIcons[role],requestsTools=agentNodeCanRequestTools(data);
  return <article className={`universum-pipeline-node ai-agent-node ai-graph-node nopan${selected?' is-selected':''}${data.diagnostics?.length?' is-invalid':''}`} data-role={role} data-can-request-tools={String(requestsTools)} data-diagnostic-count={data.diagnostics?.length??0} data-testid={`ai-agent-node-${id}`}>
    {id!=='__start__'&&<Handle type="target" position={Position.Left}/>}
    <header className="ai-agent-node-drag-handle"><Icon className="ai-graph-role-icon" size={16}/><strong>{data.label}</strong>{data.edit&&<button className="nodrag nopan" aria-label={`Edit ${data.label}`} onClick={event=>{event.stopPropagation();data.edit();}}><Settings2 size={15}/><span>Edit</span></button>}</header>
    <p>{data.description??PRIMITIVE_TYPES.find(item=>item.id===data.handler)?.description??'Workflow boundary'}</p>
    {data.workflowTarget&&<button className="ghost-button ai-workflow-call nodrag nopan" data-testid={`ai-workflow-call-${id}`} aria-label={`Open called workflow: ${data.workflowName}`} onClick={event=>{event.stopPropagation();data.openWorkflow(data.workflowTarget);}}><Network size={14}/>Calls {data.workflowName}</button>}
    {data.diagnostics?.length>0&&<small className="ai-node-diagnostic" title={data.diagnostics.join('\n')}>! Configuration needs attention</small>}
    {data.settings&&<div className="ai-agent-node-summary" title={data.settings.systemPrompt??data.settings.instructions}>{data.settings.systemPrompt||data.settings.instructions?'Instructions':data.handler==='llm'?'Prompt required':'Configured operation'}{data.settings.skillIds?.length?` / ${data.settings.skillIds.length} guide(s)`:''}{data.handler==='tools'?` / ${data.settings.tools?.length??0} tools`:''}{data.handler==='approval_gate'?data.settings.approvalMode==='all-tools'?' / Approve every tool':' / Approve mutations':''}</div>}
    {data.executionStatus&&<strong data-testid="ai-graph-attempt-status">{data.executionStatus}</strong>}
    <footer><span className="ai-graph-role-label" title={AGENT_GRAPH_ROLES[role].description}>{AGENT_GRAPH_ROLES[role].label}</span>{requestsTools?<span className="ai-graph-tool-badge"><Wrench size={12}/>Tools</span>:data.handler&&<code>{data.handler}</code>}</footer>
    {id!=='__end__'&&<Handle type="source" position={Position.Right}/>}
  </article>;
});
