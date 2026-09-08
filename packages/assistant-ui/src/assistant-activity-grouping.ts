import type { PartState } from '@assistant-ui/react';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  CHILD_RUN_USAGE_DATA_NAME,
  CONTEXT_BREAKDOWN_DATA_NAME,
  SHELL_OUTPUT_DATA_NAME,
} from '@brainstrike/assistant-contract';
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

/** True only for the two part types that carry activity (BST-1656 wording). */
export function isActivityPart(part: unknown): boolean {
  if (!(part && typeof part === 'object')) {
    return false;
  }
  const type = (part as { readonly type?: unknown }).type;
  return type === 'tool-call' || type === 'reasoning';
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
  if (part.type === 'reasoning' || part.type === 'tool-call') {
    return ACTIVITY_GROUP;
  }
  if (part.type !== 'data') {
    return STANDALONE;
  }
  if (part.name === ASSISTANT_RUN_EVENT_DATA_NAME) {
    return isAlwaysVisibleRunEvent(part.data) ? STANDALONE : ACTIVITY_GROUP;
  }
  return GROUP_TRANSPARENT_DATA_NAMES.has(part.name) ? ACTIVITY_GROUP : STANDALONE;
}
