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

import { TOOL_APPROVAL_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_SUSPEND_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-suspend';

/**
 * The run-config keys whose presence marks a user message (or an outgoing
 * run's `runConfig`) as an action leg rather than conversation. Approval and
 * suspend echoes are the same class; one seam covers both.
 */
export const ACTION_MESSAGE_RUN_CONFIG_KEYS = [
  TOOL_APPROVAL_RUN_CONFIG_KEY,
  TOOL_SUSPEND_RUN_CONFIG_KEY,
] as const;

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
 * True when `message` is a user message carrying an approval/suspend action
 * marker record under one of `keys` — i.e. transport bookkeeping the model
 * must never see.
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
  return keys.some((key) => isRecord(custom[key]));
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
 * True when an outgoing run's `runConfig` carries an approval/suspend action —
 * the ACTION LEG itself. Both resume routes (desktop + web) read the action
 * from `runConfig` and ignore `messages`, so the transport ships an EMPTY
 * message list on these legs.
 */
export function isActionRunConfig(runConfig: unknown): boolean {
  if (!isRecord(runConfig)) {
    return false;
  }
  const custom = runConfig['custom'];
  if (!isRecord(custom)) {
    return false;
  }
  return ACTION_MESSAGE_RUN_CONFIG_KEYS.some((key) => isRecord(custom[key]));
}
