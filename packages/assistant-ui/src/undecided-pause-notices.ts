import type { ThreadMessage } from '@assistant-ui/react';
import { getToolActionIdentityKey } from '@brainstrike/assistant-contract';
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
import {
  type RediscoveredPauseDisplay,
  readRediscoveredPauseDisplay,
} from './rediscovered-pause-display';
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
 * Exactly what `readRediscoveredPauseDisplay` can report: the durable
 * `DelegatedToolDecisionState` union plus the `invalid` sentinel that reader
 * stamps when a decision exists and could not be read.
 */
type PauseDecisionState = NonNullable<RediscoveredPauseDisplay['decisionState']>;

/**
 * Whether each state SETTLES a pause: `true` locks the card, `false` leaves it
 * undecided so the Stop gate re-reads it. Classified state by state rather than
 * inferred from "has a state", so a non-terminal member is never read as an
 * answer.
 *
 * A TOTAL record over the union, not a list of the settling members, because a
 * list accepts a subset in silence: a state added to the union would default to
 * "still undecided" and reintroduce the spurious remounts this gate exists to
 * prevent, with nothing red. (The union's other consumers here only pin its
 * LABELS — `DELEGATED_DECISION_STATUS_LABELS` and the explanation record in
 * `rediscovered-pause-lines.tsx` — so satisfying those says nothing about how
 * the gate classifies it.) This fails to compile until the new state is
 * classified; a genuinely non-terminal one can still map to `false` and fall
 * through to `undecided`, but DELIBERATELY.
 */
const PAUSE_SETTLED_BY_DECISION_STATE: Record<PauseDecisionState, boolean> = {
  cancelled: true,
  claimed: true,
  consumed: true,
  interrupted: true,
  // Not a durable state: a decision exists and could not be read. It still
  // locks the card, so it still settles the pause.
  invalid: true,
};

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
  // Classified EXPLICITLY, not "any state is an answer": every state the reader
  // can report is terminal today, so all of them lock the card. Should the
  // union gain a non-terminal member, `PAUSE_SETTLED_BY_DECISION_STATE` forces
  // a ruling on it, and a `false` there falls through to `undecided`.
  if (decisionState !== undefined && PAUSE_SETTLED_BY_DECISION_STATE[decisionState]) {
    decided.add(key);
    return;
  }
  undecided.add(key);
}
