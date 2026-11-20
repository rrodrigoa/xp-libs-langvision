import { CircleDot, Bot, Wrench, UserRoundCheck, GitBranch, BookOpen, Undo2 } from 'lucide-react';
import { AGENT_GRAPH_ROLES } from './agentGraphPresentation.js';

export const agentRoleIcons = { boundary: CircleDot, model: Bot, tool: Wrench, human: UserRoundCheck, decision: GitBranch, knowledge: BookOpen };

export function AgentGraphLegend({ compact = false }) {
  return <div className={`ai-graph-legend${compact ? ' is-compact' : ''}`} aria-label="Agent graph legend" data-testid="ai-graph-legend">
    {Object.entries(AGENT_GRAPH_ROLES).map(([role, item]) => {
      const Icon = agentRoleIcons[role];
      return <span key={role} data-role={role} title={item.description}><Icon size={13} aria-hidden="true" />{item.label}</span>;
    })}
    <span data-role="loop" title="A return connection to an earlier step in the control flow. Layout changes do not alter this classification."><Undo2 size={13} aria-hidden="true" /><i aria-hidden="true" />Loop</span>
  </div>;
}
