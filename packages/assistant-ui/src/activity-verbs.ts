import {
  denormalizeNativeToolName,
  HOST_META_TOOL_ID,
  type HostMetaToolId,
  isNativeToolId,
  NATIVE_TOOL_ID,
  NATIVE_TOOL_REGISTRIES,
  type NativeToolActivity,
  type NativeToolId,
  type VerbFamily,
} from '@brainstrike/assistant-contract';
import type { ManageCanvasInput } from '@brainstrike/assistant-contract/native-tool-schemas';
import { SUBAGENT_DELEGATION_TOOL_PREFIX } from '@brainstrike/assistant-contract/personas';
import { personaLabelForToolName } from './subagent-persona-label';

/**
 * How a step reads in the activity trace. A native tool's verb is the
 * `activity` its own definition declares; everything here adds the readings
 * of calls outside the catalog.
 */
export interface ActivityVerb extends NativeToolActivity {
  /**
   * Set on the generic fallbacks ("Calling server.tool", "Using x"), whose
   * wording already carries the tool id — so a row must not repeat the id as
   * its target chip (it would read "Called legacy.echo · legacy.echo").
   */
  readonly namesTool?: true;
}

interface VerbOptions {
  readonly namesTool?: true;
  readonly targetArg?: string | readonly string[] | null;
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

/**
 * The host's own model-facing tools beside its native catalog (tool
 * discovery), by their contract ids. Listing takes no target; a search names
 * its query and a load the tool it loads.
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
  // The exact-selection tool takes one name or, in its batch form, several.
  [HOST_META_TOOL_ID.loadTool]: verb('Loading tool', 'Loaded tool', 'Load tool', 'tools', {
    targetArg: ['toolName', 'toolNames'],
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
  return action === undefined
    ? NATIVE_TOOL_REGISTRIES.byId[id].activity
    : CANVAS_ACTION_VERBS[action];
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
