import type { PartState } from '@assistant-ui/react';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  CHILD_RUN_USAGE_DATA_NAME,
  CONTEXT_BREAKDOWN_DATA_NAME,
  SHELL_OUTPUT_DATA_NAME,
} from '@brainstrike/assistant-contract';
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_SUSPEND_DATA_NAME } from '@brainstrike/assistant-contract/tool-suspend';
import { isAlwaysVisibleRunEvent } from './assistant-run-event-derivation';

/**
 * The one synthetic group key the assistant message renders through
 * `MessagePrimitive.GroupedParts`. Adjacent parts that map to it coalesce into
 * one activity group (today's "Worked for Ns · N steps" panel).
 */
export const ACTIVITY_GROUP_KEY = 'group-activity';
export type ActivityGroupKey = typeof ACTIVITY_GROUP_KEY;

const ACTIVITY_GROUP: readonly ActivityGroupKey[] = Object.freeze([ACTIVITY_GROUP_KEY]);
const STANDALONE: readonly ActivityGroupKey[] = Object.freeze([]);

/**
 * Data parts that must NOT end an activity group. Ordinary run events are
 * emitted around every tool call (`tool.started` / `tool.completed` live, and
 * woven between parts on reload), and the library's grouper would otherwise
 * fence every call into its own one-step group. The three null-rendering parts
 * are transient bookkeeping that arrives mid-run.
 */
const GROUP_TRANSPARENT_DATA_NAMES: ReadonlySet<string> = new Set([
  CHILD_RUN_USAGE_DATA_NAME,
  CONTEXT_BREAKDOWN_DATA_NAME,
  SHELL_OUTPUT_DATA_NAME,
]);

/**
 * The two human-in-the-loop card data names that must always stand alone —
 * called out explicitly here (rather than relying only on the fallthrough
 * below) so the pause boundary reads as a deliberate rule, not an omission.
 */
const STANDALONE_DATA_NAMES: ReadonlySet<string> = new Set([
  TOOL_APPROVAL_DATA_NAME,
  TOOL_SUSPEND_DATA_NAME,
]);

/** The two part types that carry activity (BST-1656 wording). */
const ACTIVITY_PART_TYPES: ReadonlySet<string> = new Set(['reasoning', 'tool-call']);

/** True only for the two part types that carry activity (BST-1656 wording). */
export function isActivityPart(part: unknown): boolean {
  if (!(part && typeof part === 'object')) {
    return false;
  }
  const type = (part as { readonly type?: unknown }).type;
  return typeof type === 'string' && ACTIVITY_PART_TYPES.has(type);
}

/**
 * `groupBy` for `MessagePrimitive.GroupedParts`.
 *
 * - reasoning / tool-call → the activity group.
 * - `brainstrike.run-event` → transparent, EXCEPT always-visible kinds, which
 *   stay standalone so a collapsed group can never hide a failed/cancelled run,
 *   a skipped MCP server, or a pending approval row.
 * - shell-output / context-breakdown / child-run-usage → transparent.
 * - tool-approval / tool-suspend cards, text, and anything unrecognised →
 *   standalone. A pause is a real boundary: the trace before it settles and
 *   the resumed leg starts a new group.
 */
export function groupAssistantActivityPart(part: PartState): readonly ActivityGroupKey[] {
  return classifyPart(part);
}

/**
 * The fields `groupAssistantActivityPart` actually reads. Both the enriched
 * `PartState` the library hands `groupBy` and the plain `state.message.parts`
 * entries satisfy it, so the same classification serves the renderer's
 * message-level questions (`trailingGroupHasActivity`) without a cast.
 */
interface GroupablePart {
  readonly data?: unknown;
  readonly name?: string;
  readonly type: string;
}

function classifyPart(part: GroupablePart): readonly ActivityGroupKey[] {
  if (ACTIVITY_PART_TYPES.has(part.type)) {
    return ACTIVITY_GROUP;
  }
  if (part.type !== 'data' || part.name === undefined) {
    return STANDALONE;
  }
  if (part.name === ASSISTANT_RUN_EVENT_DATA_NAME) {
    return isAlwaysVisibleRunEvent(part.data) ? STANDALONE : ACTIVITY_GROUP;
  }
  if (STANDALONE_DATA_NAMES.has(part.name)) {
    return STANDALONE;
  }
  // Unknown data names ALSO stay standalone by this fallthrough — an
  // unrecognised part is never guessed to be safe inside the activity group.
  return GROUP_TRANSPARENT_DATA_NAMES.has(part.name) ? ACTIVITY_GROUP : STANDALONE;
}

/**
 * True when the group that holds the message's LAST part contains an activity
 * part — i.e. the trailing group is a live activity group whose header is the
 * running-state signal. Walks back over group-transparent members (run
 * events, shell output, …) that would join that group and stops at the first
 * standalone part, so `[…, text, tool.started]` is `false` (the data part
 * forms a bare data-only group and the earlier group is no longer trailing)
 * while `[…, tool-call, tool.completed]` is `true`. A trailing approval or
 * suspend card is standalone too (`false`); a message paused on one is
 * `requires-action`, not `running`, so the library emits no indicator slot
 * there regardless.
 */
export function trailingGroupHasActivity(parts: readonly GroupablePart[]): boolean {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part === undefined || classifyPart(part) !== ACTIVITY_GROUP) {
      return false;
    }
    if (isActivityPart(part)) {
      return true;
    }
  }
  return false;
}
