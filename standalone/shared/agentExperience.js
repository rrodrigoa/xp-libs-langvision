import { HISTORY_TOOLS, HISTORY_INSTRUCTIONS, INITIAL_HISTORY_INSTRUCTIONS } from './agentHistoryProtocol.js';
import { AUTHORING_INSTRUCTIONS, PRE_EXPRESSION_AUTHORING_INSTRUCTIONS } from './agentExecutionGuidance.js';
import {RESEARCH_INSTRUCTIONS,WEB_TOOL_NAMES} from './agentResearch.js';
import {TOOL_RECOVERY_INSTRUCTIONS} from './agentToolRecovery.js';
export const PROGRESS_TOOL = 'agent.report_progress';
const INITIAL_PROGRESS_GUIDANCE = `Before acting on a request, call agent.report_progress with a short public summary and the distinct customer outcomes as tasks with stable IDs. Preparatory reads are steps, not separate customer outcomes. Report progress when evidence arrives, when a task changes, and before requesting a mutation. Keep completed tasks in the list. Reference real successful tool observations for completed outcomes. Include nextAction with exact name and arguments, reason, expectedOutcome and question before an approval-backed action. After a successful action, reuse its runId and results; do not repeat it unless the user actually requested repetition. If repetition is needed, explain why the previous result cannot be used. Use concise findings and next steps, never private chain-of-thought. Finish only when each outcome is completed or explicitly explained as blocked/canceled. Never use the user's question as proof of product state or compiler behavior. Workspace canvas generatedSql is authoring metadata, not compiler truth.`;
const PREVIOUS_PROGRESS_GUIDANCE = `${INITIAL_PROGRESS_GUIDANCE}
Call agent.report_progress as a native tool, using exactly its schema. Minimal initial arguments: {"summary":"I will inspect the selected input.","tasks":[{"id":"fields","title":"List observed input fields","status":"active"}]}. Do not add description to a task. Omit optional nextAction entirely when no approval-backed action is imminent; do not send null or a placeholder action. After a successful observation, update the SAME task ID using {"summary":"The input fields are available.","tasks":[{"id":"fields","title":"List observed input fields","status":"completed","evidenceReferences":["ACTUAL_SUCCESSFUL_REQUEST_ID"]}]}, replacing the placeholder with the observation's real requestId. For an unavailable outcome use status blocked and a reason explaining the actual failure. Then call finish_step separately. Its evidenceReferences are an array of actual request ID strings, not objects.`;
export const PROGRESS_GUIDANCE = `${PREVIOUS_PROGRESS_GUIDANCE}
Publish ALL currently identifiable requested outcomes together in the FIRST report, before any product action. For a request to update SQL, start it and inspect ten outputs, show three tasks immediately: update (active), start (pending), inspect (pending). Do not reveal the original request's tasks one by one as you reach them. Subsequent tasks arrays are complete plan snapshots, not a single-task patch: preserve unchanged tasks and stable IDs. Investigation may add, reorder or remove outcomes. Explain each revision in planChangeReason; when removing an outcome, omit it from the new snapshot and provide that reason. Removed outcomes remain recorded in Historia but leave the current checklist. This revision rule supersedes the earlier instruction against dropping tasks: unexplained removal is still invalid. Do not mark unexecuted outcomes complete.`;
export const APPROVAL_GUIDANCE = `Write a clear approval question for the exact prepared actions. Explain why they are needed for the user's request and what result is expected. Identify the draft/run/view in readable terms, but do not expose secrets, fingerprints, internal revision JSON or raw argument dumps. Prior successful actions are authoritative: if an action is repeated, say that it already succeeded, explain why another execution is requested, and ask explicitly whether to repeat it. Do not imply that approval already exists. Return JSON with question, reason, expectedOutcome. This text does not authorize or change actions.`;
const text = { type: 'string', minLength: 1, maxLength: 1200 };
export const PROGRESS_CAPABILITY = { name: PROGRESS_TOOL, risk: 'read', version: 1,
  description: 'Publish a brief user-visible progress update and update the request outcomes checklist. This is public explanation, not private reasoning and not evidence that product actions succeeded. Use stable task IDs; include nextAction rationale before asking approval.',
  schema: { type: 'object', required: ['summary'], additionalProperties: false, properties: {
    summary: text,
    currentTaskId: {type:['string','null'],description:'Stable ID of the ONE task being executed now; null when none is executing. Other not-started tasks should be pending.'},
    planChangeReason: { ...text, description: 'Explain investigation-driven changes to the plan. Required when removing a previously listed outcome.' },
    tasks: { type: 'array', maxItems: 20, items: { type: 'object', required: ['id', 'title', 'status'], additionalProperties: false, properties: {
      id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$', description: 'Stable outcome identifier. Reuse it in later reports.' }, title: { ...text, description: 'User-facing outcome title, not a description field.' },
      status: { type: 'string', enum: ['pending', 'active', 'completed', 'blocked', 'canceled'], description: 'Required current outcome status.' },
      evidenceReferences: { type: 'array', description: 'Required for completed outcomes: actual successful product observation requestId strings. Never invent IDs.', items: { type: 'string' } }, reason: { type: 'string', maxLength: 1200, description: 'Required explanation for blocked or canceled outcomes.' }
    } } },
    nextAction: { type: 'object', description: 'Omit entirely unless an approval-backed product action is imminent. Never send null or a placeholder action.', required: ['name', 'arguments', 'reason', 'expectedOutcome', 'question'], additionalProperties: false,
      properties: { name: text, arguments: { type: 'object' }, reason: text, expectedOutcome: text, question: text } }
  } } };

// Explicit upgrade: callers save a new revision. Never mutate historical/pinned definitions.
export function upgradeAgentExperience(source, { jsonFieldSection, caseSection, enableResearch = false, languageSections = [], enableToolRecovery = false, refreshCatalogSections = false } = {}) {
  const definition = structuredClone(source), changes = [];
  if (definition.schemaVersion !== 5) throw new Error('Only primitive definitions can be upgraded.');
  if (jsonFieldSection && !(definition.resources?.skills??[]).some(skill=>skill.id===jsonFieldSection.id)) {
    definition.resources ??= {}; definition.resources.skills ??= [];
    definition.resources.skills.push({id:jsonFieldSection.id,title:jsonFieldSection.title,description:jsonFieldSection.guidance,body:JSON.stringify(jsonFieldSection),version:Number(jsonFieldSection.version)||1,references:[]});
    changes.push(`resources/${jsonFieldSection.id}: validated nested JSON field skill`);
  }
  if(caseSection && !(definition.resources?.skills??[]).some(skill=>skill.id===caseSection.id)) {
    definition.resources??={};definition.resources.skills??=[];
    definition.resources.skills.push({id:caseSection.id,title:caseSection.title,description:caseSection.guidance,body:JSON.stringify(caseSection),version:1,references:[]});changes.push(`resources/${caseSection.id}: validated CASE skill`);
  }
  for(const section of languageSections){
    definition.resources??={};definition.resources.skills??=[];
    const existing=definition.resources.skills.find(skill=>skill.id===section.id);
    if(existing){
      if(refreshCatalogSections&&existing.body!==JSON.stringify(section)){
        existing.body=JSON.stringify(section);existing.version=Number(section.version)||1;
        existing.description=section.guidance;changes.push(`resources/${section.id}: explicit catalog refresh; previous body retained in prior immutable revision`);
      }
      continue;
    }
    definition.resources.skills.push({id:section.id,title:section.title,description:section.guidance,body:JSON.stringify(section),version:Number(section.version)||1,references:[]});
    changes.push(`resources/${section.id}: validated language skill`);
  }
  for (const [id, graph] of [['assistant', definition], ['executionWorkflow', definition.executionWorkflow]]) {
    if (!graph) continue;
    if(graph.maxSteps===100){graph.maxSteps=600;changes.push(`${id}: bounded 600-step budget`);}
    for (const node of graph.nodes) {
      if (node.operationVersion !== 2) continue;
      if(enableToolRecovery&&node.handler==='llm'&&node.settings.toolContractInstructions===undefined){node.settings.toolContractInstructions=TOOL_RECOVERY_INSTRUCTIONS;changes.push(`${id}/${node.id}: editable authoritative tool recovery and analytics evidence`);}
      if(enableResearch && ['llm','tool'].includes(node.handler)) {
        for(const name of WEB_TOOL_NAMES)if(!node.settings.toolNames.includes(name)){node.settings.toolNames.push(name);changes.push(`${id}/${node.id}: ${name}`);}
        if(node.handler==='llm'){
          if(node.settings.researchInstructions===undefined){node.settings.researchInstructions=RESEARCH_INSTRUCTIONS;changes.push(`${id}/${node.id}: editable research and analytics verification`);}
          if(node.settings.planExemptTools===undefined){node.settings.planExemptTools=node.settings.toolNames.filter(name=>/^(web\.|skills\.|language\.|tools\.)/.test(name));changes.push(`${id}/${node.id}: explicit pre-plan discovery`);}
        }
      }
      if(node.handler==='llm') {
        if(node.settings.maxModelCalls===20){node.settings.maxModelCalls=100;changes.push(`${id}/${node.id}: 100 total model calls`);}
        if(node.settings.maxNoProgressCalls===undefined){node.settings.maxNoProgressCalls=12;changes.push(`${id}/${node.id}: 12-call progress window`);}
        if(node.settings.authoringInstructions===undefined){node.settings.authoringInstructions=AUTHORING_INSTRUCTIONS;changes.push(`${id}/${node.id}: editable SQL formatting and task-focus instructions`);}
        else if(enableToolRecovery&&node.settings.authoringInstructions===PRE_EXPRESSION_AUTHORING_INSTRUCTIONS){node.settings.authoringInstructions=AUTHORING_INSTRUCTIONS;changes.push(`${id}/${node.id}: current scalar aggregate guidance`);}
      }
      if (['llm','tool'].includes(node.handler) && node.settings.toolNames?.length) for (const tool of HISTORY_TOOLS) if (!node.settings.toolNames.includes(tool.name)) {
        node.settings.toolNames.push(tool.name); changes.push(`${id}/${node.id}: ${tool.name}`);
      }
      if (node.handler==='llm' && node.settings.toolNames?.some(name=>name.startsWith('history.')) && node.settings.historyInstructions===undefined) {
        node.settings.historyInstructions=HISTORY_INSTRUCTIONS; changes.push(`${id}/${node.id}: editable chronological history instructions`);
      }
      else if (node.handler==='llm' && node.settings.historyInstructions===INITIAL_HISTORY_INSTRUCTIONS) {
        node.settings.historyInstructions=HISTORY_INSTRUCTIONS; changes.push(`${id}/${node.id}: consult history before clarification`);
      }
      if (['llm', 'tool'].includes(node.handler) && node.settings.toolNames?.length && !node.settings.toolNames.includes(PROGRESS_TOOL)) {
        node.settings.toolNames.push(PROGRESS_TOOL); changes.push(`${id}/${node.id}: progress capability`);
      }
      if (node.handler === 'llm' && node.settings.toolNames?.includes(PROGRESS_TOOL)) {
        if (node.settings.progressInstructions === undefined) { node.settings.progressInstructions = PROGRESS_GUIDANCE; changes.push(`${id}/${node.id}: editable progress instructions`); }
        else if ([INITIAL_PROGRESS_GUIDANCE, PREVIOUS_PROGRESS_GUIDANCE].includes(node.settings.progressInstructions)) { node.settings.progressInstructions = PROGRESS_GUIDANCE; changes.push(`${id}/${node.id}: complete initial plan and editable plan revisions`); }
        if (node.settings.requirePlan === undefined) { node.settings.requirePlan = id === 'assistant'; changes.push(`${id}/${node.id}: declared plan policy`); }
      }
      if (node.handler === 'human' && node.settings.kind === 'approval' && node.settings.questionMode === undefined) {
        node.settings.questionMode = 'model'; node.settings.questionInstructions = APPROVAL_GUIDANCE;
        changes.push(`${id}/${node.id}: model-written approval question`);
      }
    }
    for(const edge of graph.edges)if(enableResearch&&edge.evidencePolicy==='required'){
      edge.evidenceChecks??=[];
      if(!edge.evidenceChecks.some(c=>c.whenObserved==='creatio.update_sql')){
        edge.evidenceChecks.push({whenObserved:'creatio.update_sql',afterTool:'creatio.update_sql',toolName:'creatio.inspect_draft',checks:[{path:'observation.result.definition.sql',operator:'present'}]},
          {whenObserved:'creatio.update_sql',afterTool:'creatio.inspect_draft',toolName:'creatio.compile_draft',referenceTool:'creatio.inspect_draft',checks:[{path:'observation.result.success',operator:'equals',value:true},{path:'observation.result.validatedSql',operator:'equals',expectedPath:'reference.result.definition.sql'}]});
        changes.push(`${id}/${edge.id}: compiled SQL must match persisted draft read-back`);
      }
    }
    for (const edge of graph.edges) if (edge.evidencePolicy === 'required' && edge.contextEvidencePaths === undefined) {
      edge.contextEvidencePaths = []; changes.push(`${id}/${edge.id}: explicit allowed context evidence`);
    }
  }
  return { definition, changes };
}
