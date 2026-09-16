import type { ThreadMessage } from '@assistant-ui/react';
import {
  type DelegatedToolDecisionState,
  getToolActionIdentityKey,
} from '@brainstrike/assistant-contract';
import {
  isAssistantToolApprovalAction,
  isAssistantToolApprovalAnswered,
  TOOL_APPROVAL_ANSWERED_DATA_NAME,
  TOOL_APPROVAL_DATA_NAME,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  isAssistantToolResumeAction,
  TOOL_SUSPEND_DATA_NAME,
  TOOL_SUSPEND_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-suspend';
import { readRediscoveredPauseDisplay } from './rediscovered-pause-display';
import {
  isAssistantToolApprovalRequest,
  isAssistantToolSuspendRequest,
} from './tool-decision-run-outcome';
import { resolveTurnAnchorMessageId } from './turn-anchor';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A thread message's `data` part, narrowed out of assistant-ui's part union. */
interface DataPart {
  readonly data: unknown;
  readonly name: string;
}

/** Whatever `getToolActionIdentityKey` can key: a pause, answer or decision. */
type ToolActionIdentity = Parameters<typeof getToolActionIdentityKey>[0];

/**
 * The durable states that SETTLE a pause. Listed rather than inferred from
 * "has a state", so a future non-terminal member (a `pending`, say) is not
 * silently read as an answer — it would fall through as still undecided.
 */
const DECIDED_DECISION_STATES = new Set<DelegatedToolDecisionState | 'invalid'>([
  'cancelled',
  'claimed',
  'consumed',
  'interrupted',
  'invalid',
]);

/**
 * The messages of the turn being stopped: from its anchoring user message
 * (`resolveTurnAnchorMessageId`, which skips decision echoes) to the live one.
 * A pause raised by an EARLIER turn is still parked on the host and this
 * cancel never touched it, so it must not drag the thread through a remount.
 */
function stoppedTurnMessages(messages: readonly ThreadMessage[]): readonly ThreadMessage[] {
  const anchorId = resolveTurnAnchorMessageId(messages);
  if (anchorId === null) {
    return messages;
  }
  const anchorIndex = messages.findIndex((message) => message.id === anchorId);
  return anchorIndex < 0 ? messages : messages.slice(anchorIndex);
}

/** The identity of a decision the user appended in this session, if any. */
function readAppendedDecisionKey(message: ThreadMessage): string | undefined {
  if (message.role !== 'user') {
    return;
  }
  const custom = isRecord(message.metadata) ? message.metadata['custom'] : undefined;
  if (!isRecord(custom)) {
    return;
  }
  const approval = custom[TOOL_APPROVAL_RUN_CONFIG_KEY];
  if (isAssistantToolApprovalAction(approval)) {
    return getToolActionIdentityKey(approval);
  }
  const resume = custom[TOOL_SUSPEND_RUN_CONFIG_KEY];
  // The contract's own guard, so this agrees with `isApprovalActionMessage`
  // about what a resume marker is — which is what keeps the resume echo out of
  // the turn anchor and its suspend pause inside the window.
  return isAssistantToolResumeAction(resume) ? getToolActionIdentityKey(resume) : undefined;
}

/**
 * True when the turn a root Stop just cancelled still shows an approval or
 * suspend pause that NOTHING has answered.
 *
 * The renderer remounts the thread when this says yes, and a remount is
 * destructive, so the question is narrow: only pauses in the stopped turn
 * (`stoppedTurnMessages`), and only those with no decision of any kind. A
 * durable `decisionState` is one answer; so are the two IN-SESSION answers,
 * which never carry one: the host's streamed `tool-approval-answered` part and
 * the user's own appended decision. Counting those remounted the thread on the
 * ordinary "approve a tool, keep going, Stop" path (PR #3214 review).
 *
 * Deliberately pure over the same parts the approvals index folds, rather than
 * reading that index: this runs in the run session, outside the runtime tree.
 */
export function hasUndecidedPauseNotice(messages: readonly ThreadMessage[]): boolean {
  const decided = new Set<string>();
  const undecided = new Set<string>();
  for (const message of stoppedTurnMessages(messages)) {
    const appendedDecision = readAppendedDecisionKey(message);
    if (appendedDecision !== undefined) {
      decided.add(appendedDecision);
    }
    for (const part of message.content) {
      if (part.type === 'data') {
        indexPausePart(part, decided, undecided);
      }
    }
  }
  return [...undecided].some((key) => !decided.has(key));
}

/** The pause this data part carries, or undefined when it carries none. */
function readPauseRequest(part: DataPart): ToolActionIdentity | undefined {
  if (part.name === TOOL_APPROVAL_DATA_NAME && isAssistantToolApprovalRequest(part.data)) {
    return part.data;
  }
  if (part.name === TOOL_SUSPEND_DATA_NAME && isAssistantToolSuspendRequest(part.data)) {
    return part.data;
  }
  return;
}

/** Fold one data part into the decided / still-undecided identity sets. */
function indexPausePart(part: DataPart, decided: Set<string>, undecided: Set<string>): void {
  if (
    part.name === TOOL_APPROVAL_ANSWERED_DATA_NAME &&
    isAssistantToolApprovalAnswered(part.data)
  ) {
    decided.add(getToolActionIdentityKey(part.data));
    return;
  }
  const pause = readPauseRequest(part);
  if (!pause) {
    return;
  }
  const key = getToolActionIdentityKey(pause);
  const decisionState = readRediscoveredPauseDisplay(pause)?.decisionState;
  // Matched EXPLICITLY, not "any state is an answer": every member of the
  // durable union is terminal today, and `invalid` means a decision exists but
  // could not be read — all of them lock the card. Should the union ever gain
  // a non-terminal member, it falls through to `undecided`, which re-reads.
  if (decisionState !== undefined && DECIDED_DECISION_STATES.has(decisionState)) {
    decided.add(key);
    return;
  }
  undecided.add(key);
}
