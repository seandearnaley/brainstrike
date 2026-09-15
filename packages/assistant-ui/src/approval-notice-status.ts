/**
 * The approval card's header state and owner naming, shared with the card
 * itself (`assistant-tool-approval-notice.tsx`): queue state, the host's
 * answer from the thread index, and the status chip text.
 */
import { useAuiState } from '@assistant-ui/react';
import { getToolActionIdentityKey } from '@brainstrike/assistant-contract';
import { SUBAGENT_DELEGATION_TOOL_PREFIX } from '@brainstrike/assistant-contract/personas';
import type {
  AssistantToolApprovalAnswered,
  AssistantToolApprovalDecision,
  AssistantToolApprovalRequest,
} from '@brainstrike/assistant-contract/tool-approval';
import type { ToolRiskCategory } from '@brainstrike/assistant-contract/tool-metadata';
import { use } from 'react';
import { ActiveThreadKeyContext } from './active-thread-key-context';
import { useAnsweredApprovals } from './answered-approvals-context';
import { followUpQueueKey, isDecisionQueued, useFollowUpQueueStore } from './follow-up-queue-store';
import {
  DELEGATED_DECISION_STATUS_LABELS,
  type RediscoveredPauseDisplay,
} from './rediscovered-pause-display';
import { personaLabelForToolName } from './subagent-persona-label';

/** Characters of the delegation prompt shown next to the persona label. */
const DELEGATION_PROMPT_PREVIEW_CHARS = 96;

/**
 * User-facing plural nouns for the session-grant actions ("Allow commands
 * this session"), shared by the card's grant button and the composer strip.
 */
export const RISK_CATEGORY_GRANT_NOUN: Record<ToolRiskCategory, string> = {
  edit: 'edits',
  execute: 'commands',
  mcp: 'MCP tools',
  read: 'reads',
};

/** Singular forms for counts ("1 read", "1 MCP tool"). */
export const RISK_CATEGORY_GRANT_NOUN_SINGULAR: Record<ToolRiskCategory, string> = {
  edit: 'edit',
  execute: 'command',
  mcp: 'MCP tool',
  read: 'read',
};

/** "Explorer" for depth 1, "Explorer › Analyst" for a grandchild: the persona chain, outermost first. */
export function describeDelegationChain(
  delegation: NonNullable<AssistantToolApprovalRequest['delegation']>
): string {
  return delegation.path
    .map((edge) => personaLabelForToolName(`${SUBAGENT_DELEGATION_TOOL_PREFIX}${edge.personaId}`))
    .join(' › ');
}

/**
 * "Explorer · Act as the frontend specialist…": the child this approval belongs
 * to, named by its persona chain (`describeDelegationChain`, so a grandchild
 * reads "Explorer › Analyst") and by the prompt the root gave it (read from
 * the thread's answered-approvals index, keyed by the root delegation call).
 * Four identical `queryEmbeddingSpace` cards from four Explorer specialists
 * are otherwise indistinguishable (thread-1dab3290, 2026-09-14).
 */
export function describeDelegationOwner(
  prompts: ReadonlyMap<string, string>,
  delegation: NonNullable<AssistantToolApprovalRequest['delegation']>
): string {
  const root = delegation.path[0];
  const label = root ? describeDelegationChain(delegation) : 'Subagent';
  const prompt = root ? prompts.get(root.parentToolCallId) : undefined;
  if (!prompt) {
    return label;
  }
  const preview = prompt.trim().replace(/\s+/g, ' ');
  return `${label} · ${
    preview.length > DELEGATION_PROMPT_PREVIEW_CHARS
      ? `${preview.slice(0, DELEGATION_PROMPT_PREVIEW_CHARS - 1)}…`
      : preview
  }`;
}

/**
 * Whether the thread runs and whether this card's decision already waits in
 * the thread's follow-up queue (`decision-dispatch.ts`).
 */
export function useDecisionQueueState(approval: AssistantToolApprovalRequest | null): {
  readonly isRunning: boolean;
  readonly queued: boolean;
  readonly threadKey: string | undefined;
} {
  const threadKey = use(ActiveThreadKeyContext);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const identityKey = approval ? getToolActionIdentityKey(approval) : null;
  const queued = useFollowUpQueueStore((state) =>
    identityKey === null ? false : isDecisionQueued(state, followUpQueueKey(threadKey), identityKey)
  );
  return { isRunning, queued, threadKey };
}

/** The header chip: queued, a host answer, a durable decision state, or the run outcome. */
export function resolveNoticeStatus(input: {
  readonly actionLockedByRun: boolean;
  readonly displayedAction: AssistantToolApprovalDecision | null;
  readonly hostAnswer: AssistantToolApprovalAnswered | null;
  readonly queued: boolean;
  readonly rediscovered: RediscoveredPauseDisplay | null;
}): string {
  if (input.queued) {
    return 'Queued';
  }
  if (input.hostAnswer?.reason === 'session-grant') {
    return 'Allowed by session grant';
  }
  if (input.hostAnswer !== null) {
    // The user's own decision, delivered into the running turn.
    return resolveApprovalStatusLabel(input.hostAnswer.decision, true);
  }
  if (input.rediscovered?.decisionState !== undefined) {
    return DELEGATED_DECISION_STATUS_LABELS[input.rediscovered.decisionState];
  }
  return resolveApprovalStatusLabel(input.displayedAction, input.actionLockedByRun);
}

/**
 * The host's answer and the owning child, from the thread's shared index —
 * one incremental scan for every card, never a per-card walk of the thread on
 * each store update (`answered-approvals-index.tsx`).
 */
export function useDelegatedNoticeContext(approval: AssistantToolApprovalRequest | null): {
  readonly delegationOwner: string | null;
  readonly hostAnswer: AssistantToolApprovalAnswered | null;
} {
  const index = useAnsweredApprovals();
  const hostAnswer = approval
    ? (index.answers.get(getToolActionIdentityKey(approval)) ?? null)
    : null;
  const delegationOwner = approval?.delegation
    ? describeDelegationOwner(index.delegationPrompts, approval.delegation)
    : null;
  return { delegationOwner, hostAnswer };
}

/** Status chip text for the notice header. */
export function resolveApprovalStatusLabel(
  displayedAction: AssistantToolApprovalDecision | null,
  actionLockedByRun: boolean
): string {
  if (displayedAction === 'approve') {
    return 'Approved';
  }
  if (displayedAction === 'decline') {
    return 'Declined';
  }
  return actionLockedByRun ? 'Submitted' : 'Pending';
}
