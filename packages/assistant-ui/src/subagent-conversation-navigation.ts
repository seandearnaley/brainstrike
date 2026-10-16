import {
  DELEGATED_CONVERSATION_DATA_NAME,
  readAssistantRunEventDataPart,
} from '@brainstrike/assistant-contract';
import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { createContext } from 'react';

export const SubagentConversationNavigationContext = createContext<
  ((threadId: string, origin?: HTMLElement) => void) | null
>(null);

export interface SubagentConversationPresentation {
  readonly colorId?: string;
  readonly displayName: string;
  readonly markClassName: string;
}
export const SubagentConversationPresentationContext = createContext<
  ((threadId: string) => Promise<SubagentConversationPresentation>) | null
>(null);

/** BST-1932 (AT-07): an approval a delegated child asked and that was answered. */
export interface SubagentAnsweredApproval {
  readonly args: unknown;
  /** The root's live policy, not a person, answered it. */
  readonly byPolicy: boolean;
  readonly decision: 'approve' | 'deny';
  readonly interactionId: string;
  /** The child's call sign. */
  readonly owner: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}
/** A child conversation's answered approvals, by child thread, for its delegation card's history. */
export const SubagentApprovalHistoryContext = createContext<
  ((threadId: string) => readonly SubagentAnsweredApproval[]) | null
>(null);

/**
 * A delegated child conversation's run state, as its own committed log says:
 * its latest run working, waiting on a person, or how that run ended, and the
 * tool calls its runs made. `no-answer` is a run that completed without
 * writing an answer (agent-host `hostAnswerText`). The owner folds the child's
 * log; nothing else writes it.
 */
export interface SubagentChildRun {
  readonly status:
    | 'running'
    | 'needs-input'
    | 'completed'
    | 'no-answer'
    | 'stopped'
    | 'failed'
    | 'interrupted';
  readonly toolCalls: number;
}
/** The owner's child run states by child thread; a read keeps its identity until it changes. */
export interface SubagentChildRunSource {
  /** Undefined until the child's committed log has been read. */
  readonly read: (threadId: string) => SubagentChildRun | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}
export const SubagentChildRunContext = createContext<SubagentChildRunSource | null>(null);

/** Host-authorized display identity for an approval's exact delegated owner. */
export interface DelegatedApprovalOwner {
  readonly colorId: string;
  readonly displayName: string;
}
export const DelegatedApprovalOwnerContext = createContext<
  ((approval: AssistantToolApprovalRequest) => Promise<DelegatedApprovalOwner | undefined>) | null
>(null);

/** Host-authorized live child publications, keyed by the owning native invocation. */
export interface SubagentLiveInvocationSource {
  readonly getThreadId: (identity: SubagentInvocationAddress) => string | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}
export const SubagentLiveInvocationContext = createContext<SubagentLiveInvocationSource | null>(
  null
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The child thread a delegation's own result names: a native completion
 * persists it, and an agent host delegation names it in every result
 * (BST-1932). Contradictory addresses fail closed.
 */
function readResultThread(result: unknown): string | undefined {
  let threadId: string | undefined;
  for (const key of ['subAgentThreadId', 'childThreadId'] as const) {
    if (!(isRecord(result) && key in result)) {
      continue;
    }
    const child = result[key];
    if (typeof child !== 'string' || !child.trim()) {
      throw new Error('Invalid child conversation address.');
    }
    if (threadId && threadId !== child) {
      throw new Error('Conflicting child conversation addresses.');
    }
    threadId = child;
  }
  return threadId;
}

/** Read the already validated host envelope in this message, never a persona label. */
export function readSubagentConversationThread(
  parts: readonly unknown[],
  toolCallId: string,
  result?: unknown
): string | undefined {
  // Live publication has an envelope instead; contradictory sources fail closed.
  let threadId = readResultThread(result);
  for (const part of parts) {
    if (
      !(
        isRecord(part) &&
        part['type'] === 'data' &&
        part['name'] === DELEGATED_CONVERSATION_DATA_NAME &&
        isRecord(part['data'])
      )
    ) {
      continue;
    }
    const data = part['data'];
    if (
      !(
        isRecord(data['identity']) &&
        data['identity']['parentToolCallId'] === toolCallId &&
        isRecord(data['baseline'])
      )
    ) {
      continue;
    }
    const child = data['baseline']['threadId'];
    if (typeof child !== 'string' || !child.trim()) {
      throw new Error('Invalid child conversation address.');
    }
    if (threadId && threadId !== child) {
      throw new Error('Conflicting child conversation addresses.');
    }
    threadId = child;
  }
  return threadId;
}

export type SubagentConversationAddress =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'available'; readonly threadId: string }
  | { readonly kind: 'invalid'; readonly error: string };

/** Render failures locally without hiding a contradictory host address. */
export function readSubagentConversationAddress(
  parts: readonly unknown[],
  toolCallId: string,
  result?: unknown
): SubagentConversationAddress {
  try {
    const threadId = readSubagentConversationThread(parts, toolCallId, result);
    return threadId ? { kind: 'available', threadId } : { kind: 'unavailable' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), kind: 'invalid' };
  }
}

export interface SubagentInvocationAddress {
  readonly parentRuntimeRunId: string;
  readonly parentToolCallId: string;
}
/** Host lookup uses the persisted native invocation, including before completion. */
export const SubagentInvocationResolverContext = createContext<
  ((identity: SubagentInvocationAddress) => Promise<string>) | null
>(null);

function readSubagentInvocationRunId(
  parts: readonly unknown[],
  toolCallId: string
): string | undefined {
  let runId: string | undefined;
  for (const part of parts) {
    const event = readAssistantRunEventDataPart(part);
    if (event?.metadata?.['parentToolCallId'] !== toolCallId) {
      continue;
    }
    const candidate = event.metadata['parentRuntimeRunId'];
    if (typeof candidate !== 'string' || !candidate.trim()) {
      continue;
    }
    if (runId && candidate !== runId) {
      throw new Error('Conflicting native invocation addresses.');
    }
    runId = candidate;
  }
  return runId;
}

export type SubagentInvocationRun =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'available'; readonly parentRuntimeRunId: string }
  | { readonly kind: 'invalid'; readonly error: string };

/** The agent host run an assistant message answers; its owner names it (BST-1932). */
function readHostRunId(metadata: unknown): string | undefined {
  const custom = isRecord(metadata) ? metadata['custom'] : undefined;
  if (!(isRecord(custom) && 'hostRunId' in custom)) {
    return;
  }
  const runId = custom['hostRunId'];
  if (typeof runId !== 'string' || !runId.trim()) {
    throw new Error('Invalid agent host run address.');
  }
  return runId;
}

/**
 * Scope to the owning message: native call IDs may repeat in another turn. An
 * agent host message is one run, so its run owns every delegation it shows.
 */
export function readSubagentInvocationRun(
  parts: readonly unknown[],
  toolCallId: string,
  metadata?: unknown
): SubagentInvocationRun {
  try {
    const native = readSubagentInvocationRunId(parts, toolCallId);
    const host = readHostRunId(metadata);
    if (native && host && native !== host) {
      throw new Error('Conflicting native invocation addresses.');
    }
    const parentRuntimeRunId = native ?? host;
    return parentRuntimeRunId ? { kind: 'available', parentRuntimeRunId } : { kind: 'unavailable' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), kind: 'invalid' };
  }
}
