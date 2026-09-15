import { useAuiState } from '@assistant-ui/react';
import { getToolActionIdentityKey } from '@brainstrike/assistant-contract';
import {
  type AssistantToolApprovalAnswered,
  isAssistantToolApprovalAnswered,
  TOOL_APPROVAL_ANSWERED_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-approval';
import { createContext, type ReactNode, use, useState } from 'react';

/**
 * One incremental index over the thread for every approval card, instead of
 * a full message walk per card per store update.
 *
 * During a fan-out the root assistant message accumulates one data part per
 * child chunk (the delegated-conversation envelopes), so a per-card selector
 * that walks every part on every update is O(parts) × cards × updates: the
 * work grows with the square of the stream and the renderer stalls while
 * four children stream (2026-09-14, "the app locks up while processing").
 * Parts only ever append while a message streams, so this index scans each
 * message from the count it last saw and resets when the thread's shape
 * changes (rewind, branch switch).
 */
export interface AnsweredApprovalsIndex {
  /** The host's answer per identity key (`getToolActionIdentityKey`): decision and reason. */
  readonly answers: ReadonlyMap<string, AssistantToolApprovalAnswered>;
  /** The prompt the root gave each delegation call, keyed by that call's id. */
  readonly delegationPrompts: ReadonlyMap<string, string>;
}

const EMPTY_INDEX: AnsweredApprovalsIndex = {
  answers: new Map(),
  delegationPrompts: new Map(),
};

const AnsweredApprovalsContext = createContext<AnsweredApprovalsIndex>(EMPTY_INDEX);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ScanCursor {
  readonly keys: string[];
  readonly scanned: number[];
}

function messageKey(message: unknown, index: number): string {
  const id = isRecord(message) ? message['id'] : undefined;
  return typeof id === 'string' ? id : `#${index}`;
}

/** Fold one part into the index; returns true when the index changed. */
function indexPart(
  part: unknown,
  answers: Map<string, AssistantToolApprovalAnswered>,
  prompts: Map<string, string>
): boolean {
  if (!isRecord(part)) {
    return false;
  }
  if (part['type'] === 'tool-call' && typeof part['toolCallId'] === 'string') {
    const args = part['args'];
    const prompt = isRecord(args) ? args['prompt'] : undefined;
    if (typeof prompt === 'string' && prompt.trim().length > 0) {
      prompts.set(part['toolCallId'], prompt);
      return true;
    }
    return false;
  }
  if (
    part['type'] === 'data' &&
    part['name'] === TOOL_APPROVAL_ANSWERED_DATA_NAME &&
    isAssistantToolApprovalAnswered(part['data'])
  ) {
    answers.set(getToolActionIdentityKey(part['data']), part['data']);
    return true;
  }
  return false;
}

/**
 * Advance the cursor over `messages`. A message whose key moved or vanished
 * means the thread was rewritten, so the whole index is rebuilt from scratch;
 * otherwise only the parts appended since the last pass are read.
 */
export function advanceAnsweredApprovalsIndex(
  messages: readonly unknown[],
  cursor: ScanCursor,
  answers: Map<string, AssistantToolApprovalAnswered>,
  prompts: Map<string, string>
): { readonly changed: boolean; readonly cursor: ScanCursor } {
  const keys = messages.map(messageKey);
  const rewritten =
    keys.length < cursor.keys.length || cursor.keys.some((key, index) => keys[index] !== key);
  if (rewritten) {
    answers.clear();
    prompts.clear();
  }
  const scanned = rewritten ? keys.map(() => 0) : [...cursor.scanned, ...keys.map(() => 0)];
  let changed = rewritten;
  for (const [index, message] of messages.entries()) {
    const content = isRecord(message) ? message['content'] : undefined;
    if (!Array.isArray(content)) {
      continue;
    }
    const from = scanned[index] ?? 0;
    for (let partIndex = from; partIndex < content.length; partIndex += 1) {
      if (indexPart(content[partIndex], answers, prompts)) {
        changed = true;
      }
    }
    scanned[index] = content.length;
  }
  return { changed, cursor: { keys, scanned: scanned.slice(0, keys.length) } };
}

interface IndexState {
  readonly answers: Map<string, AssistantToolApprovalAnswered>;
  readonly cursor: ScanCursor;
  readonly messages: readonly unknown[];
  readonly prompts: Map<string, string>;
  readonly value: AnsweredApprovalsIndex;
}

function advanceIndexState(previous: IndexState, messages: readonly unknown[]): IndexState {
  const answers = new Map(previous.answers);
  const prompts = new Map(previous.prompts);
  const result = advanceAnsweredApprovalsIndex(messages, previous.cursor, answers, prompts);
  return {
    answers,
    cursor: result.cursor,
    messages,
    prompts,
    // An unchanged index keeps its identity so consumers do not re-render.
    value: result.changed ? { answers, delegationPrompts: prompts } : previous.value,
  };
}

const INITIAL_STATE: IndexState = {
  answers: new Map(),
  cursor: { keys: [], scanned: [] },
  messages: [],
  prompts: new Map(),
  value: EMPTY_INDEX,
};

export function AnsweredApprovalsProvider({ children }: { children: ReactNode }) {
  const messages = useAuiState((state) => state.thread.messages);
  // React's "store information from previous renders" pattern: the index is
  // derived from the thread, advanced once per new messages array, and never
  // an effect (no extra commit, no state used as an event handler).
  const [state, setState] = useState<IndexState>(INITIAL_STATE);
  if (state.messages !== messages) {
    setState(advanceIndexState(state, messages));
  }
  return (
    <AnsweredApprovalsContext.Provider value={state.value}>
      {children}
    </AnsweredApprovalsContext.Provider>
  );
}

/** The thread's answered-approvals index; empty when no provider is mounted. */
export function useAnsweredApprovals(): AnsweredApprovalsIndex {
  return use(AnsweredApprovalsContext);
}
