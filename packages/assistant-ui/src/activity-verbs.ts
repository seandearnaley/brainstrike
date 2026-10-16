import {
  denormalizeNativeToolName,
  HOST_META_TOOL_ID,
  type HostMetaToolId,
  NATIVE_TOOL_ID,
  type NativeToolId,
} from '@brainstrike/assistant-contract';
import type { ManageCanvasInput } from '@brainstrike/assistant-contract/native-tool-schemas';
import { SUBAGENT_DELEGATION_TOOL_PREFIX } from '@brainstrike/assistant-contract/personas';
import { personaLabelForToolName } from './subagent-persona-label';

/**
 * Every verb family, as a single source of truth (BST-1685): `VerbFamily` is
 * derived from this tuple rather than declared as a parallel union, so a
 * test iterating families (`activity-step-icons.test.tsx`) can import the
 * runtime list instead of hand-maintaining its own copy that could drift
 * from the type.
 */
export const VERB_FAMILIES = [
  'ask',
  'call',
  'canvas',
  'delegate',
  'edit',
  'memory',
  'other',
  'read',
  'run',
  'search',
  'skill',
  'tasks',
  'tools',
  'web',
  'worktree',
] as const;

export type VerbFamily = (typeof VERB_FAMILIES)[number];

/**
 * Whether the resting summary folds this verb's distinct targets into a file
 * count, and from which count. Set ONLY on verbs whose target IS a file —
 * never inferred from the family, since `read` also covers directory listings,
 * artifact reads and context reads ("Listed 2 files" was the defect).
 * `'always'` counts from one ("Edited 1 file": an edit names its file even
 * alone); `'plural'` counts only from two ("Read 2 files", but a single read
 * stays the bare "Read").
 */
export type ActivityFileCountMode = 'always' | 'plural';

export interface ActivityVerb {
  /** Present participle while the step runs: "Reading". */
  readonly active: string;
  /** Set only on file-targeted verbs; see `ActivityFileCountMode`. */
  readonly countsFiles?: ActivityFileCountMode;
  /** Past tense once it settled: "Read". */
  readonly done: string;
  /** Icon/colour family for the step row (phase 3) and summary grouping. */
  readonly family: VerbFamily;
  /**
   * Set on the generic fallbacks ("Calling server.tool", "Using x"), whose
   * wording already carries the tool id — so a row must not repeat the id as
   * its target chip (it would read "Called legacy.echo · legacy.echo").
   */
  readonly namesTool?: true;
  /**
   * The action as it was asked for, neither running nor done: "Run skill
   * script". A call that never ran (declined or blocked) and an approval,
   * which names the action it asks for, read this form.
   */
  readonly request: string;
  /**
   * The argument that names the step's target chip. Absent: the generic
   * reading (`extractPrimaryArg`'s priority keys, then the first string). A
   * key: that argument alone. `null`: the arguments name no target at all —
   * they carry content (working memory's markdown, a canvas's HTML), which is
   * never a target.
   */
  readonly targetArg?: string | null;
}

interface VerbOptions {
  readonly countsFiles?: ActivityFileCountMode;
  readonly namesTool?: true;
  readonly targetArg?: string | null;
}

const verb = (
  active: string,
  done: string,
  request: string,
  family: VerbFamily,
  options: VerbOptions = {}
): ActivityVerb => Object.freeze({ active, done, family, request, ...options });

/** A fallback verb that spells the tool id itself (see `ActivityVerb.namesTool`). */
const namingVerb = (
  active: string,
  done: string,
  request: string,
  family: VerbFamily
): ActivityVerb => verb(active, done, request, family, { namesTool: true });

/** A verb whose target is a file, so the resting summary folds a file count. */
const fileVerb = (
  active: string,
  done: string,
  request: string,
  family: VerbFamily,
  countsFiles: ActivityFileCountMode
): ActivityVerb => verb(active, done, request, family, { countsFiles });

/**
 * One entry per native tool id. The table is total over `NATIVE_TOOL_IDS`
 * (pinned by activity-verbs.test.ts), so adding a native tool without a verb
 * fails the suite instead of silently reading "Using brainstrike.x".
 *
 * `NATIVE_TOOL_IDS` includes the `brainstrike.*` desktop ids plus the three
 * Mastra-native Agent Skills ids (`skill`, `skill_read`, `skill_search`,
 * deliberately unprefixed — see native-tools/definitions/skill.ts).
 *
 * `manageCanvas` here is the reading before its call's action is known (a
 * streaming input); {@link verbForTool} reads the action once it is.
 */
export const TOOL_VERBS: Readonly<Record<NativeToolId, ActivityVerb>> = Object.freeze({
  [NATIVE_TOOL_ID.askUser]: verb('Asking', 'Asked', 'Ask', 'ask'),
  [NATIVE_TOOL_ID.browserGetPageText]: verb(
    'Reading page text',
    'Read page text',
    'Read page text',
    'web'
  ),
  [NATIVE_TOOL_ID.browserNavigate]: verb('Opening', 'Opened', 'Open', 'web'),
  [NATIVE_TOOL_ID.browserReadPage]: verb('Reading page', 'Read page', 'Read page', 'web'),
  [NATIVE_TOOL_ID.deleteWorkspaceFile]: fileVerb('Deleting', 'Deleted', 'Delete', 'edit', 'always'),
  [NATIVE_TOOL_ID.executeCommand]: verb('Running', 'Ran', 'Run', 'run'),
  [NATIVE_TOOL_ID.findWorkspaceSymbol]: verb('Inspecting', 'Inspected', 'Inspect', 'search'),
  [NATIVE_TOOL_ID.globWorkspace]: verb('Finding files', 'Found files', 'Find files', 'search'),
  [NATIVE_TOOL_ID.grepSearch]: verb('Searching', 'Searched', 'Search', 'search'),
  [NATIVE_TOOL_ID.hybridSearch]: verb('Searching', 'Searched', 'Search', 'search'),
  [NATIVE_TOOL_ID.inspectCommandSessions]: verb(
    'Inspecting sessions',
    'Inspected sessions',
    'Inspect sessions',
    'run'
  ),
  [NATIVE_TOOL_ID.listEmbeddingSpaces]: verb(
    'Listing embedding spaces',
    'Listed embedding spaces',
    'List embedding spaces',
    'search'
  ),
  [NATIVE_TOOL_ID.listWorkspaceContext]: verb(
    'Listing context',
    'Listed context',
    'List context',
    'read'
  ),
  [NATIVE_TOOL_ID.listWorktrees]: verb(
    'Listing worktrees',
    'Listed worktrees',
    'List worktrees',
    'worktree'
  ),
  [NATIVE_TOOL_ID.lspInspect]: verb('Inspecting', 'Inspected', 'Inspect', 'search'),
  [NATIVE_TOOL_ID.manageCanvas]: verb(
    'Managing canvas',
    'Managed canvas',
    'Manage canvas',
    'canvas',
    {
      targetArg: null,
    }
  ),
  [NATIVE_TOOL_ID.manageCommandSession]: verb('Running', 'Ran', 'Run', 'run'),
  [NATIVE_TOOL_ID.manageTaskList]: verb('Updating tasks', 'Updated tasks', 'Update tasks', 'tasks'),
  [NATIVE_TOOL_ID.manageWorktree]: verb(
    'Updating worktree',
    'Updated worktree',
    'Update worktree',
    'worktree'
  ),
  [NATIVE_TOOL_ID.queryDiagnostics]: verb('Inspecting', 'Inspected', 'Inspect', 'search'),
  [NATIVE_TOOL_ID.queryEmbeddingSpace]: verb('Searching', 'Searched', 'Search', 'search'),
  [NATIVE_TOOL_ID.readToolOutputArtifact]: verb(
    'Reading output',
    'Read output',
    'Read output',
    'read'
  ),
  [NATIVE_TOOL_ID.readWorkspaceContext]: verb(
    'Reading context',
    'Read context',
    'Read context',
    'read'
  ),
  [NATIVE_TOOL_ID.readWorkspaceDirectory]: verb('Listing', 'Listed', 'List', 'read'),
  [NATIVE_TOOL_ID.readWorkspaceFile]: fileVerb('Reading', 'Read', 'Read', 'read', 'plural'),
  [NATIVE_TOOL_ID.renameWorkspaceFile]: fileVerb('Renaming', 'Renamed', 'Rename', 'edit', 'always'),
  [NATIVE_TOOL_ID.runPython]: verb('Running', 'Ran', 'Run', 'run'),
  [NATIVE_TOOL_ID.runSkillScript]: verb(
    'Running skill script',
    'Ran skill script',
    'Run skill script',
    'skill'
  ),
  [NATIVE_TOOL_ID.skill]: verb('Activating skill', 'Activated skill', 'Activate skill', 'skill'),
  [NATIVE_TOOL_ID.skillRead]: verb(
    'Reading skill file',
    'Read skill file',
    'Read skill file',
    'skill'
  ),
  [NATIVE_TOOL_ID.skillSearch]: verb(
    'Searching skills',
    'Searched skills',
    'Search skills',
    'skill'
  ),
  [NATIVE_TOOL_ID.stringReplaceWorkspaceFile]: fileVerb(
    'Editing',
    'Edited',
    'Edit',
    'edit',
    'always'
  ),
  [NATIVE_TOOL_ID.submitPlan]: verb('Proposing plan', 'Proposed plan', 'Propose plan', 'ask'),
  [NATIVE_TOOL_ID.webExtract]: verb('Fetching', 'Fetched', 'Fetch', 'web'),
  [NATIVE_TOOL_ID.webSearch]: verb(
    'Searching the web',
    'Searched the web',
    'Search the web',
    'web'
  ),
  [NATIVE_TOOL_ID.writeWorkspaceFile]: fileVerb('Editing', 'Edited', 'Edit', 'edit', 'always'),
});

/**
 * The host's own model-facing tools beside its native catalog (tool
 * discovery and working memory), by their contract ids. Working memory's
 * argument is the memory's whole markdown, and listing takes no target, so
 * neither names one; a search names its query and a load the tool it loads.
 */
const HOST_META_VERBS: Readonly<Record<HostMetaToolId, ActivityVerb>> = Object.freeze({
  [HOST_META_TOOL_ID.listAvailableTools]: verb(
    'Listing tools',
    'Listed tools',
    'List tools',
    'tools',
    {
      targetArg: null,
    }
  ),
  [HOST_META_TOOL_ID.loadTool]: verb('Loading tool', 'Loaded tool', 'Load tool', 'tools', {
    targetArg: 'toolName',
  }),
  [HOST_META_TOOL_ID.searchTools]: verb(
    'Searching tools',
    'Searched tools',
    'Search tools',
    'tools',
    {
      targetArg: 'query',
    }
  ),
  [HOST_META_TOOL_ID.updateWorkingMemory]: verb(
    'Updating memory',
    'Updated memory',
    'Update memory',
    'memory',
    { targetArg: null }
  ),
});

type CanvasAction = ManageCanvasInput['action'];

/**
 * A canvas call by its `action`, total over the contract's action union: a
 * create names the canvas's title; a list, update or rewrite names no target —
 * the canvas id is opaque and the HTML is content.
 */
const CANVAS_ACTION_VERBS: Readonly<Record<CanvasAction, ActivityVerb>> = Object.freeze({
  create: verb('Creating canvas', 'Created canvas', 'Create canvas', 'canvas', {
    targetArg: 'title',
  }),
  list: verb('Listing canvases', 'Listed canvases', 'List canvases', 'canvas', { targetArg: null }),
  rewrite: verb('Updating canvas', 'Updated canvas', 'Update canvas', 'canvas', {
    targetArg: null,
  }),
  update: verb('Updating canvas', 'Updated canvas', 'Update canvas', 'canvas', { targetArg: null }),
});

function isNativeToolId(name: string): name is NativeToolId {
  return Object.hasOwn(TOOL_VERBS, name);
}

function isHostMetaToolId(name: string): name is HostMetaToolId {
  return Object.hasOwn(HOST_META_VERBS, name);
}

/** A canvas call's own `action` argument, once it has streamed and names a known action. */
function readCanvasAction(args: unknown): CanvasAction | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return;
  }
  const action: unknown = (args as Record<string, unknown>)['action'];
  return typeof action === 'string' && Object.hasOwn(CANVAS_ACTION_VERBS, action)
    ? (action as CanvasAction)
    : undefined;
}

function nativeVerb(id: NativeToolId, args: unknown): ActivityVerb {
  const action = id === NATIVE_TOOL_ID.manageCanvas ? readCanvasAction(args) : undefined;
  return action === undefined ? TOOL_VERBS[id] : CANVAS_ACTION_VERBS[action];
}

/**
 * Verb for any tool call the thread can carry: native ids (dotted or the
 * Mastra-sanitized underscore form, read by the call's own arguments where
 * the action decides the wording), the host's meta tools, `agent-<persona>`
 * delegations, MCP tools (`server.tool`, which contain a dot but never the
 * `brainstrike.` prefix), and anything else — which reads honestly as "Using
 * <name>" rather than a guess.
 */
export function verbForTool(toolName: string, args?: unknown): ActivityVerb {
  const dotted = denormalizeNativeToolName(toolName);
  if (isNativeToolId(dotted)) {
    return nativeVerb(dotted, args);
  }
  if (isHostMetaToolId(toolName)) {
    return HOST_META_VERBS[toolName];
  }
  if (toolName.startsWith(SUBAGENT_DELEGATION_TOOL_PREFIX)) {
    const label = personaLabelForToolName(toolName);
    return verb(
      `Delegating to ${label}`,
      `Delegated to ${label}`,
      `Delegate to ${label}`,
      'delegate'
    );
  }
  if (toolName.includes('.') && !toolName.startsWith('brainstrike.')) {
    return namingVerb(`Calling ${toolName}`, `Called ${toolName}`, `Call ${toolName}`, 'call');
  }
  return namingVerb(`Using ${toolName}`, `Used ${toolName}`, `Use ${toolName}`, 'other');
}
