import {
  denormalizeNativeToolName,
  NATIVE_TOOL_ID,
  type NativeToolId,
} from '@brainstrike/assistant-contract';
import { SUBAGENT_DELEGATION_TOOL_PREFIX } from '@brainstrike/assistant-contract/personas';
import { personaLabelForToolName } from './subagent-persona-label';

export type VerbFamily =
  | 'ask'
  | 'call'
  | 'canvas'
  | 'delegate'
  | 'edit'
  | 'other'
  | 'read'
  | 'run'
  | 'search'
  | 'skill'
  | 'tasks'
  | 'web'
  | 'worktree';

export interface ActivityVerb {
  /** Present participle while the step runs: "Reading". */
  readonly active: string;
  /** Past tense once it settled: "Read". */
  readonly done: string;
  /** Icon/colour family for the step row (phase 3) and summary grouping. */
  readonly family: VerbFamily;
}

const verb = (active: string, done: string, family: VerbFamily): ActivityVerb =>
  Object.freeze({ active, done, family });

/**
 * One entry per native tool id. The table is total over `NATIVE_TOOL_IDS`
 * (pinned by activity-verbs.test.ts), so adding a native tool without a verb
 * fails the suite instead of silently reading "Using brainstrike.x".
 *
 * `NATIVE_TOOL_IDS` includes 36 `brainstrike.*` desktop ids plus the three
 * Mastra-native Agent Skills ids (`skill`, `skill_read`, `skill_search`,
 * deliberately unprefixed — see native-tools/definitions/skill.ts) — 39
 * entries total.
 */
export const TOOL_VERBS: Readonly<Record<NativeToolId, ActivityVerb>> = Object.freeze({
  [NATIVE_TOOL_ID.askUser]: verb('Asking', 'Asked', 'ask'),
  [NATIVE_TOOL_ID.browserGetPageText]: verb('Reading page text', 'Read page text', 'web'),
  [NATIVE_TOOL_ID.browserNavigate]: verb('Opening', 'Opened', 'web'),
  [NATIVE_TOOL_ID.browserReadPage]: verb('Reading page', 'Read page', 'web'),
  [NATIVE_TOOL_ID.deleteWorkspaceFile]: verb('Deleting', 'Deleted', 'edit'),
  [NATIVE_TOOL_ID.executeCommand]: verb('Running', 'Ran', 'run'),
  [NATIVE_TOOL_ID.findWorkspaceSymbol]: verb('Inspecting', 'Inspected', 'search'),
  [NATIVE_TOOL_ID.globWorkspace]: verb('Finding files', 'Found files', 'search'),
  [NATIVE_TOOL_ID.grepSearch]: verb('Searching', 'Searched', 'search'),
  [NATIVE_TOOL_ID.hybridSearch]: verb('Searching', 'Searched', 'search'),
  [NATIVE_TOOL_ID.inspectCommandSessions]: verb('Inspecting sessions', 'Inspected sessions', 'run'),
  [NATIVE_TOOL_ID.listEmbeddingSpaces]: verb(
    'Listing embedding spaces',
    'Listed embedding spaces',
    'search'
  ),
  [NATIVE_TOOL_ID.listWorkspaceContext]: verb('Listing context', 'Listed context', 'read'),
  [NATIVE_TOOL_ID.listWorktrees]: verb('Listing worktrees', 'Listed worktrees', 'worktree'),
  [NATIVE_TOOL_ID.lspInspect]: verb('Inspecting', 'Inspected', 'search'),
  [NATIVE_TOOL_ID.manageCanvas]: verb('Updating canvas', 'Updated canvas', 'canvas'),
  [NATIVE_TOOL_ID.manageCommandSession]: verb('Running', 'Ran', 'run'),
  [NATIVE_TOOL_ID.manageTaskList]: verb('Updating tasks', 'Updated tasks', 'tasks'),
  [NATIVE_TOOL_ID.manageWorktree]: verb('Updating worktree', 'Updated worktree', 'worktree'),
  [NATIVE_TOOL_ID.queryDiagnostics]: verb('Inspecting', 'Inspected', 'search'),
  [NATIVE_TOOL_ID.queryEmbeddingSpace]: verb('Searching', 'Searched', 'search'),
  [NATIVE_TOOL_ID.querySelf]: verb('Querying history', 'Queried history', 'search'),
  [NATIVE_TOOL_ID.readToolOutputArtifact]: verb('Reading output', 'Read output', 'read'),
  [NATIVE_TOOL_ID.readWorkspaceContext]: verb('Reading context', 'Read context', 'read'),
  [NATIVE_TOOL_ID.readWorkspaceDirectory]: verb('Listing', 'Listed', 'read'),
  [NATIVE_TOOL_ID.readWorkspaceFile]: verb('Reading', 'Read', 'read'),
  [NATIVE_TOOL_ID.renameWorkspaceFile]: verb('Renaming', 'Renamed', 'edit'),
  [NATIVE_TOOL_ID.runPython]: verb('Running', 'Ran', 'run'),
  [NATIVE_TOOL_ID.runSkillScript]: verb('Running skill script', 'Ran skill script', 'skill'),
  [NATIVE_TOOL_ID.skill]: verb('Activating skill', 'Activated skill', 'skill'),
  [NATIVE_TOOL_ID.skillRead]: verb('Reading skill file', 'Read skill file', 'skill'),
  [NATIVE_TOOL_ID.skillSearch]: verb('Searching skills', 'Searched skills', 'skill'),
  [NATIVE_TOOL_ID.stringReplaceWorkspaceFile]: verb('Editing', 'Edited', 'edit'),
  [NATIVE_TOOL_ID.submitPlan]: verb('Proposing plan', 'Proposed plan', 'ask'),
  [NATIVE_TOOL_ID.updateWorkspaceContextSelection]: verb(
    'Updating context',
    'Updated context',
    'read'
  ),
  [NATIVE_TOOL_ID.updateWorkspaceTapestrySelections]: verb(
    'Updating selections',
    'Updated selections',
    'read'
  ),
  [NATIVE_TOOL_ID.webExtract]: verb('Fetching', 'Fetched', 'web'),
  [NATIVE_TOOL_ID.webSearch]: verb('Searching the web', 'Searched the web', 'web'),
  [NATIVE_TOOL_ID.writeWorkspaceFile]: verb('Editing', 'Edited', 'edit'),
});

function isNativeToolId(name: string): name is NativeToolId {
  return Object.hasOwn(TOOL_VERBS, name);
}

/**
 * Verb for any tool name the thread can carry: native ids (dotted or the
 * Mastra-sanitized underscore form), `agent-<persona>` delegations, MCP tools
 * (`server.tool`, which contain a dot but never the `brainstrike.` prefix), and
 * anything else — which reads honestly as "Using <name>" rather than a guess.
 */
export function verbForTool(toolName: string): ActivityVerb {
  const dotted = denormalizeNativeToolName(toolName);
  if (isNativeToolId(dotted)) {
    return TOOL_VERBS[dotted];
  }
  if (toolName.startsWith(SUBAGENT_DELEGATION_TOOL_PREFIX)) {
    const label = personaLabelForToolName(toolName);
    return verb(`Delegating to ${label}`, `Delegated to ${label}`, 'delegate');
  }
  if (toolName.includes('.') && !toolName.startsWith('brainstrike.')) {
    return verb(`Calling ${toolName}`, `Called ${toolName}`, 'call');
  }
  return verb(`Using ${toolName}`, `Used ${toolName}`, 'other');
}
