import { readAssistantRunEventDataPart } from '@brainstrike/assistant-contract';
import { SUBAGENT_NO_ANSWER_OUTCOME } from '@brainstrike/assistant-contract/personas';
import { extractPrimaryArg } from './tool-summaries';

export type SubAgentToolRowStatus = 'error' | 'running' | 'success';

export interface SubAgentToolRow {
  argSummary: string | undefined;
  key: string;
  status: SubAgentToolRowStatus;
  toolName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Persisted per-child rows from a delegation result's `subAgentToolResults`.
 * Authoritative at completion and on reload (see docs/agents/assistant-subagents.md).
 */
export function readSubAgentToolRows(result: unknown): SubAgentToolRow[] {
  if (!isRecord(result)) {
    return [];
  }
  const list = result['subAgentToolResults'];
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((entry, index) => {
    const record = isRecord(entry) ? entry : {};
    const toolName = typeof record['toolName'] === 'string' ? record['toolName'] : 'tool';
    const toolCallId = typeof record['toolCallId'] === 'string' ? record['toolCallId'] : undefined;
    return {
      argSummary: extractPrimaryArg(record['args'], undefined)?.display,
      key: toolCallId ?? `${toolName}-${index}`,
      status: record['isError'] === true ? 'error' : 'success',
      toolName,
    };
  });
}

/** How a delegation ended, beyond what the tool-call status can express. */
export type SubagentDelegationOutcome = typeof SUBAGENT_NO_ANSWER_OUTCOME;

/**
 * This delegation's terminal outcome, when it is one the tool-call status
 * cannot express (BST-1410).
 *
 * A child that exhausts its step cap mid-tool-loop still produces a SUCCESSFUL
 * delegation tool call, so `status.type` reports it as complete — the same
 * silent success that made a supervisor abandon delegation for a whole turn.
 * The discriminator is the terminal run event's bounded `outcome` metadata,
 * never the human label (a hard child failure shares the same kind and status).
 *
 * Scoped by `parentToolCallId` because MAX_CONCURRENT_DELEGATIONS is 2: an
 * unscoped read would report one delegation's outcome on another's card.
 */
export function readSubagentDelegationOutcome(
  parts: readonly unknown[],
  parentToolCallId: string
): SubagentDelegationOutcome | undefined {
  for (const part of parts) {
    const data = readAssistantRunEventDataPart(part);
    const metadata = data?.metadata;
    if (
      metadata &&
      metadata['parentToolCallId'] === parentToolCallId &&
      metadata['outcome'] === SUBAGENT_NO_ANSWER_OUTCOME
    ) {
      return SUBAGENT_NO_ANSWER_OUTCOME;
    }
  }
  return;
}

const SUBAGENT_TOOL_KIND_STATUS: Record<string, SubAgentToolRowStatus> = {
  'subagent.tool.completed': 'success',
  'subagent.tool.failed': 'error',
  'subagent.tool.started': 'running',
};

/**
 * LIVE in-flight per-child rows derived from `subagent.tool.*` run-event message
 * parts whose `metadata.parentToolCallId` matches this delegation. Later events
 * for the same child toolCallId supersede earlier ones (started → completed),
 * so a running delegation shows its in-progress tool count instead of zero.
 */
export function readLiveSubagentToolRows(
  parts: readonly unknown[],
  parentToolCallId: string
): SubAgentToolRow[] {
  const byChild = new Map<string, SubAgentToolRow>();
  for (const part of parts) {
    const data = readAssistantRunEventDataPart(part);
    if (!data) {
      continue;
    }
    const status = SUBAGENT_TOOL_KIND_STATUS[data.kind];
    if (!status) {
      continue;
    }
    const metadata = data.metadata;
    if (!metadata || metadata['parentToolCallId'] !== parentToolCallId) {
      continue;
    }
    const toolCallId =
      typeof metadata['toolCallId'] === 'string' ? metadata['toolCallId'] : undefined;
    if (!toolCallId) {
      continue;
    }
    const toolName =
      typeof metadata['childToolName'] === 'string' ? metadata['childToolName'] : 'tool';
    byChild.set(toolCallId, { argSummary: undefined, key: toolCallId, status, toolName });
  }
  return Array.from(byChild.values());
}

/**
 * Value-stable serialization of {@link readLiveSubagentToolRows} for a
 * `useAuiState` selector.
 *
 * `useAuiState` re-runs its selector on every store update and compares the
 * result with `Object.is`; returning the raw `state.message.parts` array (a
 * referentially-stable reference that grows in place as run-event data parts are
 * appended) never trips that comparison, so the connected card froze on an early
 * snapshot and undercounted live child rows (D2 — showed 2 of 10 mid-delegation).
 * Serializing to a string makes the selector change by VALUE exactly when the
 * derived rows change — the same pattern the run-lifecycle notifier uses for its
 * array selectors.
 */
export function serializeLiveSubagentToolRows(
  parts: readonly unknown[],
  parentToolCallId: string
): string {
  return JSON.stringify(readLiveSubagentToolRows(parts, parentToolCallId));
}

/**
 * Union of live + persisted rows, keyed by child toolCallId; a persisted row
 * (terminal, authoritative) supersedes the matching live row while preserving
 * its position, and persisted-only rows append.
 */
export function mergeSubagentToolRows(
  persisted: readonly SubAgentToolRow[],
  live: readonly SubAgentToolRow[]
): SubAgentToolRow[] {
  const byKey = new Map<string, SubAgentToolRow>();
  for (const row of live) {
    byKey.set(row.key, row);
  }
  for (const row of persisted) {
    byKey.set(row.key, row);
  }
  return Array.from(byKey.values());
}

interface MessageWithParts {
  readonly parts?: readonly unknown[];
}

/**
 * Thread-wide variant of {@link readLiveSubagentToolRows} (2026-08-24 field
 * failure): hydration weaves a run's `subagent.tool.*` events into ONE
 * assistant group, and an approval-resume turn splits into sibling groups —
 * so on reload the events can land on a DIFFERENT message than the delegation
 * card, and a message-scoped read shows "0 tool calls" for a child that did
 * minutes of work. The events are `parentToolCallId`-scoped by design, so
 * reading every message's parts is safe and reload-robust.
 */
export function readLiveSubagentToolRowsFromMessages(
  messages: readonly MessageWithParts[],
  parentToolCallId: string
): SubAgentToolRow[] {
  const parts: unknown[] = [];
  for (const message of messages) {
    if (Array.isArray(message.parts)) {
      parts.push(...message.parts);
    }
  }
  return readLiveSubagentToolRows(parts, parentToolCallId);
}

/** Value-stable serialization of {@link readLiveSubagentToolRowsFromMessages}. */
export function serializeLiveSubagentToolRowsFromMessages(
  messages: readonly MessageWithParts[],
  parentToolCallId: string
): string {
  return JSON.stringify(readLiveSubagentToolRowsFromMessages(messages, parentToolCallId));
}

/** Thread-wide variant of {@link readSubagentDelegationOutcome} — same rationale. */
export function readSubagentDelegationOutcomeFromMessages(
  messages: readonly MessageWithParts[],
  parentToolCallId: string
): SubagentDelegationOutcome | undefined {
  for (const message of messages) {
    if (!Array.isArray(message.parts)) {
      continue;
    }
    const outcome = readSubagentDelegationOutcome(message.parts, parentToolCallId);
    if (outcome) {
      return outcome;
    }
  }
  return;
}
