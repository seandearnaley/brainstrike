import { useAuiState } from '@assistant-ui/react';
import { getToolActionIdentityKey } from '@brainstrike/assistant-contract';
import {
  type AssistantToolApprovalAnswered,
  type AssistantToolApprovalDecision,
  type AssistantToolApprovalRequest,
  isAssistantToolApprovalAction,
  isAssistantToolApprovalAnswered,
  TOOL_APPROVAL_ANSWERED_DATA_NAME,
  TOOL_APPROVAL_DATA_NAME,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';
import { createContext, type ReactNode, use, useState } from 'react';
import { readRediscoveredPauseDisplay } from './rediscovered-pause-display';
import { isAssistantToolApprovalRequest } from './tool-decision-run-outcome';

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
 *
 * Since 2026-09-15 it also records every approval REQUEST part and the
 * user's own appended decisions, so the card-vs-row ranking
 * (`approval-presentation-context.tsx`) and the composer strip read one
 * index rather than walking the thread again.
 */
export interface IndexedApprovalRequest {
  /** A durable decision state rode on the part (rediscovered, already admitted). */
  readonly decided: boolean;
  readonly request: AssistantToolApprovalRequest;
}

export interface AnsweredApprovalsIndex {
  /** The host's answer per identity key (`getToolActionIdentityKey`): decision and reason. */
  readonly answers: ReadonlyMap<string, AssistantToolApprovalAnswered>;
  /** The prompt the root gave each delegation call, keyed by that call's id. */
  readonly delegationPrompts: ReadonlyMap<string, string>;
  /** Every approval request in the thread, in part order, keyed like its notice. */
  readonly requests: ReadonlyMap<string, IndexedApprovalRequest>;
  /** The user's own appended decisions (idle-thread clicks), keyed like the request. */
  readonly userDecisions: ReadonlyMap<string, AssistantToolApprovalDecision>;
}

/** The mutable working set `advanceAnsweredApprovalsIndex` folds into. */
export interface MutableApprovalsIndex {
  readonly answers: Map<string, AssistantToolApprovalAnswered>;
  readonly prompts: Map<string, string>;
  readonly requests: Map<string, IndexedApprovalRequest>;
  readonly userDecisions: Map<string, AssistantToolApprovalDecision>;
}

export function createMutableApprovalsIndex(): MutableApprovalsIndex {
  return { answers: new Map(), prompts: new Map(), requests: new Map(), userDecisions: new Map() };
}

const EMPTY_INDEX: AnsweredApprovalsIndex = {
  answers: new Map(),
  delegationPrompts: new Map(),
  requests: new Map(),
  userDecisions: new Map(),
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
function indexPart(part: unknown, index: MutableApprovalsIndex): boolean {
  if (!isRecord(part)) {
    return false;
  }
  if (part['type'] === 'tool-call' && typeof part['toolCallId'] === 'string') {
    const args = part['args'];
    const prompt = isRecord(args) ? args['prompt'] : undefined;
    if (typeof prompt === 'string' && prompt.trim().length > 0) {
      index.prompts.set(part['toolCallId'], prompt);
      return true;
    }
    return false;
  }
  if (part['type'] !== 'data') {
    return false;
  }
  if (
    part['name'] === TOOL_APPROVAL_ANSWERED_DATA_NAME &&
    isAssistantToolApprovalAnswered(part['data'])
  ) {
    index.answers.set(getToolActionIdentityKey(part['data']), part['data']);
    return true;
  }
  if (part['name'] === TOOL_APPROVAL_DATA_NAME && isAssistantToolApprovalRequest(part['data'])) {
    const request = part['data'];
    index.requests.set(getToolActionIdentityKey(request), {
      decided: readRediscoveredPauseDisplay(request)?.decisionState !== undefined,
      request,
    });
    return true;
  }
  return false;
}

/**
 * A user message appended by an approval click carries the action under
 * `metadata.custom[TOOL_APPROVAL_RUN_CONFIG_KEY]` (APPROVAL ACTION MESSAGES
 * ARE BOOKKEEPING, assistant-runtime.md). Read once per message: metadata
 * never changes after the append. A malformed marker is ignored, never
 * guessed into a decision.
 */
function indexUserDecision(message: unknown, index: MutableApprovalsIndex): boolean {
  if (!(isRecord(message) && message['role'] === 'user')) {
    return false;
  }
  const metadata = message['metadata'];
  const custom = isRecord(metadata) ? metadata['custom'] : undefined;
  const action = isRecord(custom) ? custom[TOOL_APPROVAL_RUN_CONFIG_KEY] : undefined;
  if (!isAssistantToolApprovalAction(action)) {
    return false;
  }
  index.userDecisions.set(getToolActionIdentityKey(action), action.action);
  return true;
}

/**
 * Advance the cursor over `messages`. A message whose key moved or vanished
 * means the thread was rewritten, so the whole index is rebuilt from scratch;
 * otherwise only the parts appended since the last pass are read, and a
 * message's decision marker is read only when the message is new.
 */
export function advanceAnsweredApprovalsIndex(
  messages: readonly unknown[],
  cursor: ScanCursor,
  index: MutableApprovalsIndex
): { readonly changed: boolean; readonly cursor: ScanCursor } {
  const keys = messages.map(messageKey);
  const rewritten =
    keys.length < cursor.keys.length || cursor.keys.some((key, position) => keys[position] !== key);
  if (rewritten) {
    index.answers.clear();
    index.prompts.clear();
    index.requests.clear();
    index.userDecisions.clear();
  }
  const scanned = rewritten ? keys.map(() => 0) : [...cursor.scanned, ...keys.map(() => 0)];
  let changed = rewritten;
  for (const [position, message] of messages.entries()) {
    const isNewMessage = rewritten || position >= cursor.keys.length;
    if (isNewMessage && indexUserDecision(message, index)) {
      changed = true;
    }
    const content = isRecord(message) ? message['content'] : undefined;
    if (!Array.isArray(content)) {
      continue;
    }
    const from = scanned[position] ?? 0;
    for (let partIndex = from; partIndex < content.length; partIndex += 1) {
      if (indexPart(content[partIndex], index)) {
        changed = true;
      }
    }
    scanned[position] = content.length;
  }
  return { changed, cursor: { keys, scanned: scanned.slice(0, keys.length) } };
}

interface IndexState {
  readonly cursor: ScanCursor;
  readonly index: MutableApprovalsIndex;
  readonly messages: readonly unknown[];
  readonly value: AnsweredApprovalsIndex;
}

function advanceIndexState(previous: IndexState, messages: readonly unknown[]): IndexState {
  const index: MutableApprovalsIndex = {
    answers: new Map(previous.index.answers),
    prompts: new Map(previous.index.prompts),
    requests: new Map(previous.index.requests),
    userDecisions: new Map(previous.index.userDecisions),
  };
  const result = advanceAnsweredApprovalsIndex(messages, previous.cursor, index);
  return {
    cursor: result.cursor,
    index,
    messages,
    // An unchanged index keeps its identity so consumers do not re-render.
    value: result.changed
      ? {
          answers: index.answers,
          delegationPrompts: index.prompts,
          requests: index.requests,
          userDecisions: index.userDecisions,
        }
      : previous.value,
  };
}

const INITIAL_STATE: IndexState = {
  cursor: { keys: [], scanned: [] },
  index: createMutableApprovalsIndex(),
  messages: [],
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
