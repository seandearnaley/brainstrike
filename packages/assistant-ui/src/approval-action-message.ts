/**
 * Approval/suspend ACTION MESSAGES are UI/transport bookkeeping, not
 * conversation. When the user clicks Approve/Decline (approval notice) or
 * Approve/Reject/Answer (suspend notice), the notice appends a user message
 * whose `metadata.custom` carries the action under a well-known key
 * (`TOOL_APPROVAL_RUN_CONFIG_KEY` / `TOOL_SUSPEND_RUN_CONFIG_KEY`) plus a
 * human-readable echo text ("Approved brainstrike.executeCommand."). The
 * message must EXIST in thread state (the notice's outcome locking and the
 * resume `runConfig` ride on it) but must NEVER reach the model: both resume
 * routes read the action from `runConfig` and ignore messages, and Mastra
 * never persists it (pinned live in
 * packages/agent mastra-tool-approval-suspend.integration.spec.ts) — so any
 * copy the transport resends is a phantom "user said" turn.
 *
 * These helpers are the SINGLE source of truth for recognizing such messages;
 * the data-stream transport (exclusion seam) and the panel (chip rendering)
 * both consume them.
 */

import {
  isAssistantToolApprovalAction,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  isAssistantToolResumeAction,
  TOOL_SUSPEND_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-suspend';

/**
 * The run-config keys whose presence marks a user message (or an outgoing
 * run's `runConfig`) as an action leg rather than conversation. Approval and
 * suspend echoes are the same class; one seam covers both.
 */
export const ACTION_MESSAGE_RUN_CONFIG_KEYS = [
  TOOL_APPROVAL_RUN_CONFIG_KEY,
  TOOL_SUSPEND_RUN_CONFIG_KEY,
] as const;

/**
 * The STRICT contract guard for each action key — the SAME guards the chip
 * recognizer (`approval-action-chip.tsx`) uses (`isAssistantToolApprovalAction`
 * / `isAssistantToolResumeAction`, which require non-empty `runId`/`toolCallId`
 * and — for suspend — a `resumeData` key). Wire-exclusion and chip-rendering
 * MUST agree on what an action message is: a record-but-structurally-invalid
 * marker (e.g. `{}`) is NOT an action — it renders as an ordinary prompt bubble,
 * so it must stay on the wire, never be silently stripped (no-silent-fallbacks).
 * A key with no registered guard is never treated as an action marker.
 */
const ACTION_MARKER_GUARD_BY_KEY: Record<string, (value: unknown) => boolean> = {
  [TOOL_APPROVAL_RUN_CONFIG_KEY]: isAssistantToolApprovalAction,
  [TOOL_SUSPEND_RUN_CONFIG_KEY]: isAssistantToolResumeAction,
};

function isValidActionMarker(custom: Record<string, unknown>, key: string): boolean {
  const guard = ACTION_MARKER_GUARD_BY_KEY[key];
  return guard === undefined ? false : guard(custom[key]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readCustomMetadata(message: unknown): Record<string, unknown> | undefined {
  if (!isRecord(message)) {
    return;
  }
  const metadata = message['metadata'];
  if (!isRecord(metadata)) {
    return;
  }
  const custom = metadata['custom'];
  return isRecord(custom) ? custom : undefined;
}

/**
 * True when `message` is a user message carrying a STRUCTURALLY VALID
 * approval/suspend action marker under one of `keys` — i.e. transport
 * bookkeeping the model must never see. Uses the same strict contract guards as
 * the chip recognizer, so a record-but-invalid marker is NOT stripped here (it
 * renders as a bubble and must reach the wire).
 */
export function isApprovalActionMessage(
  message: unknown,
  keys: readonly string[] = ACTION_MESSAGE_RUN_CONFIG_KEYS
): boolean {
  if (!isRecord(message) || message['role'] !== 'user') {
    return false;
  }
  const custom = readCustomMetadata(message);
  if (!custom) {
    return false;
  }
  return keys.some((key) => isValidActionMarker(custom, key));
}

/** Filter action bookkeeping messages out of an outgoing message list. */
export function excludeApprovalActionMessages<T>(
  messages: readonly T[],
  keys: readonly string[] = ACTION_MESSAGE_RUN_CONFIG_KEYS
): readonly T[] {
  if (!messages.some((message) => isApprovalActionMessage(message, keys))) {
    return messages;
  }
  return messages.filter((message) => !isApprovalActionMessage(message, keys));
}

/**
 * True when an outgoing run's `runConfig` carries a STRUCTURALLY VALID
 * approval/suspend action — the ACTION LEG itself. Both resume routes (desktop +
 * web) read the action from `runConfig` and ignore `messages`, so the transport
 * ships an EMPTY message list on these legs. Uses the SAME strict guards as the
 * message recognizer (and the server-side `readTool*RunConfigAction`), so an
 * invalid marker is NOT mistaken for an action leg that suppresses the messages.
 */
export function isActionRunConfig(runConfig: unknown): boolean {
  if (!isRecord(runConfig)) {
    return false;
  }
  const custom = runConfig['custom'];
  if (!isRecord(custom)) {
    return false;
  }
  return ACTION_MESSAGE_RUN_CONFIG_KEYS.some((key) => isValidActionMarker(custom, key));
}
