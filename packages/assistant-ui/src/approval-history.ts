import {
  getToolActionIdentityKey,
  readAssistantRunEventDataPart,
} from '@brainstrike/assistant-contract';
import {
  type AssistantToolApprovalAnswered,
  type AssistantToolApprovalRequest,
  isAssistantToolApprovalAnswered,
  TOOL_APPROVAL_ANSWERED_DATA_NAME,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  type AnsweredApprovalsIndex,
  approvalSurfaceCallKey,
  type IndexedApprovalRequest,
} from './answered-approvals-index-model';
import { isAssistantToolApprovalRequest } from './tool-decision-run-outcome';

/** A leaf key alone does not establish the surface or the complete ancestry. */
function isExactSurfaceAnswer(
  answer: AssistantToolApprovalAnswered,
  request: AssistantToolApprovalRequest
): boolean {
  if (
    answer.runId !== request.runId ||
    answer.toolCallId !== request.toolCallId ||
    answer.toolName !== request.toolName ||
    answer.continuationId !== request.continuationId
  ) {
    return false;
  }
  const answered = answer.delegation;
  const requested = request.delegation;
  if (!(answered && requested)) {
    return answered === requested;
  }
  return (
    answered.toolCallId === requested.toolCallId &&
    answered.path.length === requested.path.length &&
    answered.path.every((edge, index) => {
      const original = requested.path[index];
      return (
        original?.childRuntimeRunId === edge.childRuntimeRunId &&
        original.parentRuntimeRunId === edge.parentRuntimeRunId &&
        original.parentToolCallId === edge.parentToolCallId &&
        original.personaId === edge.personaId
      );
    })
  );
}

/** The host's `tool-approval-answered` payload this part carries, if any. */
function readAnsweredPart(part: unknown): AssistantToolApprovalAnswered | undefined {
  if (
    !(
      typeof part === 'object' &&
      part !== null &&
      'type' in part &&
      part.type === 'data' &&
      'name' in part &&
      part.name === TOOL_APPROVAL_ANSWERED_DATA_NAME &&
      'data' in part &&
      isAssistantToolApprovalAnswered(part.data)
    )
  ) {
    return;
  }
  return part.data;
}

/** Associate only this message's host answer with its original addressable card. */
function answeredApprovalSurfaceCall(
  answer: AssistantToolApprovalAnswered | undefined,
  cardedSurfaceCalls: ReadonlySet<string> | undefined,
  requests: ReadonlyMap<string, IndexedApprovalRequest> | undefined
): string | undefined {
  if (!answer) {
    return;
  }
  // A reconstructed leg seeds the approved call under its NEW host leg.
  // Global answers and bare reused call ids cannot identify that copy.
  const request = requests?.get(getToolActionIdentityKey(answer))?.request;
  if (
    !(
      request?.timelineRunId &&
      cardedSurfaceCalls?.has(approvalSurfaceCallKey(request.timelineRunId, request.toolCallId)) &&
      isExactSurfaceAnswer(answer, request)
    )
  ) {
    return;
  }
  return request.toolCallId;
}

function toolPartCallId(part: unknown): string | undefined {
  if (
    typeof part !== 'object' ||
    part === null ||
    !('type' in part) ||
    part.type !== 'tool-call' ||
    !('toolCallId' in part) ||
    typeof part.toolCallId !== 'string'
  ) {
    return;
  }
  return part.toolCallId;
}

function isUnambiguous(id: string, counts: ReadonlyMap<string, number>): boolean {
  return (counts.get(id) ?? 0) < 2;
}

/** The committed facts this projection reads: which cards exist and how each was answered. */
export type ApprovalCardIndex = Partial<
  Pick<AnsweredApprovalsIndex, 'answers' | 'cardedSurfaceCalls' | 'requests' | 'userDecisions'>
>;

/** This message's approval cards and the committed answer state of each carded call. */
export interface ApprovalCardCalls {
  /**
   * Carded calls whose pause has a committed answer: the host's
   * `tool-approval-answered`, the user's appended decision, or a durable
   * decision state. Never inferred from the message's (runtime-rewritten) status.
   */
  readonly answered: ReadonlySet<string>;
  /**
   * Carded calls whose host answer streamed in THIS message: the leg that
   * executes the call after its decision, which owns that execution's chrome.
   */
  readonly answeredHere: ReadonlySet<string>;
  /** Calls an addressable approval card owns: the card replaces their pause chrome. */
  readonly ids: ReadonlySet<string>;
  /** Carded calls whose card renders in this message, by call: the approval's identity key. */
  readonly inline: ReadonlyMap<string, string>;
}

function isCommittedAnswer(identityKey: string, index: ApprovalCardIndex): boolean {
  return (
    index.answers?.has(identityKey) === true ||
    index.userDecisions?.has(identityKey) === true ||
    index.requests?.get(identityKey)?.decided === true
  );
}

/** A separate card's surface call is answered when the request it carries is. */
function isSurfaceCallAnswered(runId: string, callId: string, index: ApprovalCardIndex): boolean {
  for (const [identityKey, { request }] of index.requests ?? []) {
    if (
      request.timelineRunId === runId &&
      request.toolCallId === callId &&
      isCommittedAnswer(identityKey, index)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A separate card matches the invocation's recorded HOST leg and surface call,
 * even when the pause event lives elsewhere. Never infer a native Mastra run ID
 * or a child leaf.
 */
function separateCardSurfaceCall(
  part: unknown,
  index: ApprovalCardIndex
): { readonly answered: boolean; readonly callId: string } | undefined {
  const event = index.cardedSurfaceCalls?.size ? readAssistantRunEventDataPart(part) : undefined;
  if (
    !((event?.kind === 'tool.approval.requested' || event?.kind === 'tool.started') && event.runId)
  ) {
    return;
  }
  const callId = event.metadata?.['toolCallId'];
  if (
    typeof callId !== 'string' ||
    !index.cardedSurfaceCalls?.has(approvalSurfaceCallKey(event.runId, callId))
  ) {
    return;
  }
  return { answered: isSurfaceCallAnswered(event.runId, callId, index), callId };
}

/** The approval request an inline card in this message renders. */
function inlineApprovalRequest(part: unknown): AssistantToolApprovalRequest | undefined {
  if (
    typeof part !== 'object' ||
    part === null ||
    !('type' in part) ||
    part.type !== 'data' ||
    !('name' in part) ||
    part.name !== TOOL_APPROVAL_DATA_NAME ||
    !('data' in part) ||
    !isAssistantToolApprovalRequest(part.data)
  ) {
    return;
  }
  return part.data;
}

/** Only a real, addressable approval card can replace its duplicate pause chrome. */
export function approvalCardCalls(
  parts: readonly unknown[],
  index: ApprovalCardIndex = {}
): ApprovalCardCalls {
  const ids = new Set<string>();
  const answered = new Set<string>();
  const answeredHere = new Set<string>();
  const answerKeysHere = new Set<string>();
  const inline = new Map<string, string>();
  const toolCallCounts = new Map<string, number>();
  for (const part of parts) {
    const partCallId = toolPartCallId(part);
    if (partCallId !== undefined) {
      toolCallCounts.set(partCallId, (toolCallCounts.get(partCallId) ?? 0) + 1);
    }
    const surfaceCall = separateCardSurfaceCall(part, index);
    if (surfaceCall) {
      ids.add(surfaceCall.callId);
      if (surfaceCall.answered) {
        answered.add(surfaceCall.callId);
      }
    }
    // The host's answer in this message is itself the committed answer, and
    // marks this message as the leg that executes the decided call.
    const answer = readAnsweredPart(part);
    if (answer) {
      answerKeysHere.add(getToolActionIdentityKey(answer));
    }
    const answeredCall = answeredApprovalSurfaceCall(
      answer,
      index.cardedSurfaceCalls,
      index.requests
    );
    if (answeredCall) {
      ids.add(answeredCall);
      answered.add(answeredCall);
      answeredHere.add(answeredCall);
    }
    const request = inlineApprovalRequest(part);
    if (!request) {
      continue;
    }
    const identityKey = getToolActionIdentityKey(request);
    ids.add(request.toolCallId);
    inline.set(request.toolCallId, identityKey);
    if (isCommittedAnswer(identityKey, index)) {
      answered.add(request.toolCallId);
    }
  }
  // An inline pause answered within its own message was decided live, so this
  // message executes it too.
  for (const [callId, identityKey] of inline) {
    if (answerKeysHere.has(identityKey)) {
      answered.add(callId);
      answeredHere.add(callId);
    }
  }
  // Tool parts do not carry native/ancestry coordinates. Two same-id parts
  // cannot be individually addressed by this projection; retain both rather
  // than applying one proven answer to an unrelated invocation.
  const carded = (id: string): boolean => ids.has(id) && isUnambiguous(id, toolCallCounts);
  return {
    answered: new Set([...answered].filter(carded)),
    answeredHere: new Set([...answeredHere].filter(carded)),
    ids: new Set([...ids].filter(carded)),
    inline: new Map([...inline].filter(([id]) => carded(id))),
  };
}

/** The ids `approvalCardCalls` reports, for callers that only need card ownership. */
export function approvalCardToolCallIds(
  parts: readonly unknown[],
  cardedSurfaceCalls?: ReadonlySet<string>,
  requests?: ReadonlyMap<string, IndexedApprovalRequest>
): ReadonlySet<string> {
  return approvalCardCalls(parts, {
    ...(cardedSurfaceCalls ? { cardedSurfaceCalls } : {}),
    ...(requests ? { requests } : {}),
  }).ids;
}

/** The fields a carded call's ownership reads from its part. */
interface PausedCallPart {
  readonly result?: unknown;
  readonly status: { readonly reason?: string; readonly type: string };
  readonly toolCallId: string;
}

/**
 * BST-2185, case B: an inline card's pause that the run ended before any
 * committed answer existed — Stop while the approval waited, or a later turn
 * that left it unanswered (the vendor local runtime then settles the paused
 * message as `incomplete/cancelled`). The call never ran. Which case applies is
 * decided by the committed answer; the status only says the pause is over.
 */
export function isStoppedUnansweredPause(part: PausedCallPart, calls: ApprovalCardCalls): boolean {
  return (
    part.result === undefined &&
    calls.inline.has(part.toolCallId) &&
    !calls.answered.has(part.toolCallId) &&
    part.status.type === 'incomplete' &&
    part.status.reason === 'cancelled'
  );
}

/**
 * Whether a resultless carded call's pause belongs to its approval card rather
 * than an activity group: while it waits for a decision (`requires-action`);
 * once its decision is committed and resumed in another message (cases A and C:
 * the card shows the decision, and the call's execution belongs to the resumed
 * turn); and once it was stopped unanswered (case B). The message that executes
 * a decided call (its host answer streamed here) keeps that execution's chrome,
 * live while it runs and settled if it is stopped or fails.
 */
export function cardOwnsPausedCall(part: PausedCallPart, calls: ApprovalCardCalls): boolean {
  if (part.result !== undefined || !calls.ids.has(part.toolCallId)) {
    return false;
  }
  if (part.status.type === 'requires-action') {
    return true;
  }
  if (part.status.type === 'running' || calls.answeredHere.has(part.toolCallId)) {
    return false;
  }
  return calls.answered.has(part.toolCallId) || isStoppedUnansweredPause(part, calls);
}

const NO_STOPPED_APPROVALS: ReadonlySet<string> = new Set();

/** The approval identity keys of this message's inline cards whose pause was stopped unanswered. */
export function stoppedApprovalKeys(
  parts: readonly unknown[],
  calls: ApprovalCardCalls
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const part of parts) {
    if (!(isPausedCallPart(part) && isStoppedUnansweredPause(part, calls))) {
      continue;
    }
    const key = calls.inline.get(part.toolCallId);
    if (key !== undefined) {
      keys.add(key);
    }
  }
  // One shared empty set: a streaming message re-derives this per chunk, and a
  // fresh identity would re-render every approval card it provides to.
  return keys.size === 0 ? NO_STOPPED_APPROVALS : keys;
}

function isPausedCallPart(part: unknown): part is PausedCallPart {
  if (toolPartCallId(part) === undefined || !(typeof part === 'object' && part !== null)) {
    return false;
  }
  const status = 'status' in part ? part.status : undefined;
  return (
    typeof status === 'object' &&
    status !== null &&
    'type' in status &&
    typeof status.type === 'string'
  );
}
