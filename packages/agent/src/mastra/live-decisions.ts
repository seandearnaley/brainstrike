import { createLogger } from '@brainstrike/logging';
import type { BackgroundTask } from '@mastra/core/background-tasks';
import type { RuntimeData, StreamChunkToolApprovalAnswered } from '../types';
import type { MastraAgentRuntime } from './agent-runtime';
import { allowedBySnapshot } from './approval-gate';
import {
  findGrantedBackgroundApprovals,
  type GrantedBackgroundApproval,
  recordGrantedBackgroundApprovals,
} from './background-granted-approvals';
import { findPendingBackgroundTask } from './background-resume';
import type {
  DelegatedLiveDecisionRecord,
  DelegatedToolActionAnswer,
} from './delegated-conversation-binding';
import { assertDelegatedToolActionPending } from './delegated-tool-actions';
import {
  type LiveBackgroundOwner,
  type LiveDecisionAction,
  type LiveDecisionRequest,
  LiveDecisionUnavailableError,
} from './live-decision-channel';
import { resolveDiscoveredApprovalToolName } from './suspended-run-discovery';

const logger = createLogger('LiveDecisions');

type LiveRuntime = Pick<
  MastraAgentRuntime,
  | 'agent'
  | 'askTools'
  | 'backgroundTaskManager'
  | 'conversationBinding'
  | 'liveDecisions'
  | 'toolNameMap'
>;

function isApprovalAction(
  action: LiveDecisionAction
): action is Extract<LiveDecisionAction, { readonly action: 'approve' | 'decline' }> {
  return 'action' in action;
}

/**
 * The 1.56+ approval rider for a typed resume delivered live: exactly what the
 * resume leg attaches (`createToolResumeTurnAttempt`), so a decision takes the
 * same shape whichever path carries it.
 */
function withApprovalRider(
  action: Extract<LiveDecisionAction, { readonly resumeData: unknown }>,
  reChecked: boolean,
  leafToolName: string
): unknown {
  const plainObject =
    typeof action.resumeData === 'object' &&
    action.resumeData !== null &&
    !Array.isArray(action.resumeData);
  if (reChecked && !plainObject) {
    logger.warn(
      'Ask-gated suspending tool has a non-object resume payload; the 1.56+ approval rider cannot be attached and Mastra may deny the resume.',
      {
        code: 'mastra_agent_resume_rider_unattachable',
        runId: action.runId,
        toolCallId: action.toolCallId,
        toolName: leafToolName,
      }
    );
  }
  return reChecked && plainObject
    ? { ...(action.resumeData as Record<string, unknown>), approved: true }
    : action.resumeData;
}

function requireLiveOwner(runtime: LiveRuntime): LiveBackgroundOwner {
  const owner = runtime.liveDecisions.owner;
  if (!owner) {
    throw new LiveDecisionUnavailableError('The leg has no running background owner.');
  }
  return owner;
}

/** Publish the host's answers, then resume; a closed stream refuses before any native effect. */
async function publishAndResume(params: {
  readonly answered: readonly StreamChunkToolApprovalAnswered[];
  readonly owner: LiveBackgroundOwner;
  readonly reservation: ReturnType<LiveBackgroundOwner['reserve']>;
  readonly resumes: readonly { readonly resumeData: unknown; readonly task: BackgroundTask }[];
}): Promise<void> {
  for (const chunk of params.answered) {
    if (!params.owner.publish(chunk)) {
      params.reservation.release();
      throw new LiveDecisionUnavailableError('The leg closed before the decision was published.');
    }
  }
  await params.reservation.resume(params.resumes);
}

/**
 * Debug-pack evidence (swarm diagnostics, migration 139): the running leg
 * records a delivered decision with its task, its leaf call, the parked
 * siblings the request's snapshot answered and that snapshot. The endpoint
 * records only the outcomes it alone sees (no live run, refused, failed).
 */
function deliveredDecisionRecord(input: {
  readonly action: LiveDecisionAction;
  readonly answeredSiblingTaskIds: readonly string[];
  readonly delegationToolCallId: string;
  readonly permissionPolicy: LiveDecisionRequest['permissionPolicy'];
  readonly taskId: string;
  readonly toolName: string;
}): DelegatedLiveDecisionRecord {
  return {
    answeredSiblingTaskIds: input.answeredSiblingTaskIds,
    ...(isApprovalAction(input.action)
      ? { decision: input.action.action, kind: 'approval' as const }
      : { decision: 'resume' as const, kind: 'resume' as const }),
    delegationToolCallId: input.delegationToolCallId,
    outcome: 'delivered',
    ...(input.permissionPolicy ? { policySnapshot: input.permissionPolicy } : {}),
    source: 'user',
    taskId: input.taskId,
    toolCallId: input.action.toolCallId,
    toolName: input.toolName,
  };
}

/**
 * Debug-pack evidence for a remembered session grant's answer to a later pause
 * (swarm diagnostics, migration 139): answered with the grant it applied, or
 * failed with the reason (nothing native happened then; the card stays).
 */
function rememberedDecisionRecord(input: {
  readonly entry: GrantedBackgroundApproval;
  readonly failure: string | undefined;
  readonly remembered: NonNullable<LiveDecisionRequest['permissionPolicy']>;
}): DelegatedLiveDecisionRecord {
  const { entry } = input;
  const leaf = {
    delegationToolCallId: entry.action.delegation.toolCallId,
    kind: 'approval' as const,
    source: 'remembered-grant' as const,
    taskId: entry.task.id,
    toolCallId: entry.action.toolCallId,
    ...(entry.answered.toolName ? { toolName: entry.answered.toolName } : {}),
  };
  return input.failure === undefined
    ? {
        ...leaf,
        decision: 'approve',
        outcome: 'remembered-answered',
        policySnapshot: input.remembered,
      }
    : { ...leaf, outcome: 'remembered-failed', reason: input.failure };
}

/**
 * Arm a leg's live decision handler on its runtime channel (settled
 * 2026-09-14, do not relitigate: a decision reaches the RUNNING leg).
 *
 * `deliver`: the explicit decision is validated against the live native
 * snapshot exactly as a click on a new leg would be, as is every parked
 * sibling the request's fresh snapshot now allows (one a durable decision
 * already answered is skipped, not refused); then the decision and those
 * siblings are recorded with the host as consumed in ONE all-or-none write
 * (never the root's single active claim — the leg may hold that claim
 * already; a refused answer records nothing), the answers are published on
 * the leg's own stream so every card locks, and the owning phase resumes the
 * tasks in-process. A lasting grant is remembered once the records succeed and
 * BEFORE the in-process resume; from then on every ask tool's function-form
 * flag (approval-gate.ts) lets each later call the grant allows run without
 * a pause — the user granted reads for the session; a fifth specialist's
 * read is not a new question (Claude Code applies lasting grants to every
 * later prompt).
 *
 * `suspended`: remains for a pause the flag did not lift under a remembered
 * grant (a category the grant does not cover keeps its card; a task that
 * parked before the grant was remembered is answered by it).
 */
export function armLiveDecisions(
  runtime: LiveRuntime,
  runtimeData: RuntimeData | undefined
): () => void {
  const channel = runtime.liveDecisions;
  const requireScope = () => {
    const manager = runtime.backgroundTaskManager;
    const scope = runtimeData?.memory;
    if (!(manager && scope)) {
      throw new LiveDecisionUnavailableError('Live decisions require the root background scope.');
    }
    return { manager, scope };
  };
  const requireAnswerRecords = () => {
    if (!runtime.conversationBinding?.recordToolActionAnswers) {
      throw new Error('Live decisions require host-owned answer records.');
    }
  };
  const answerGranted = async (
    owner: LiveBackgroundOwner,
    granted: readonly GrantedBackgroundApproval[],
    explicit?: {
      readonly answer: DelegatedToolActionAnswer;
      readonly answered: StreamChunkToolApprovalAnswered | undefined;
      readonly resume: { readonly resumeData: unknown; readonly task: BackgroundTask };
    },
    remember?: () => void
  ) => {
    const reservation = owner.reserve([
      ...(explicit ? [explicit.resume.task] : []),
      ...granted.map((entry) => entry.task),
    ]);
    let answered: readonly StreamChunkToolApprovalAnswered[];
    try {
      await reservation.prepare();
      // The user's answer and every granted sibling's are ONE all-or-none
      // host write: a refused sibling must never leave the user's own pause
      // consumed with nothing resumed (BST-1749 review).
      answered = [
        ...(explicit?.answered ? [explicit.answered] : []),
        ...(await recordGrantedBackgroundApprovals({
          ...(explicit ? { explicit: explicit.answer } : {}),
          granted,
          runtime,
        })),
      ];
    } catch (error) {
      reservation.release();
      throw error;
    }
    // The grant is remembered only once the host has recorded the user's
    // decision (a refused record must not widen the gate), and BEFORE the
    // resumed child runs: its next call reads `remembered` through its
    // function-form flag (approval-gate.ts), and a child resumed in-process
    // reaches that call within the same tick chain as `manager.resume`.
    remember?.();
    await publishAndResume({
      answered,
      owner,
      reservation,
      resumes: [
        ...(explicit ? [explicit.resume] : []),
        ...granted.map((entry) => ({ resumeData: { approved: true }, task: entry.task })),
      ],
    });
  };
  return channel.arm({
    async deliver(request) {
      const { manager, scope } = requireScope();
      const owner = requireLiveOwner(runtime);
      const { action } = request;
      const task = await findPendingBackgroundTask(manager, scope, action);
      if (!task) {
        throw new LiveDecisionUnavailableError(
          'The decision does not address a parked background invocation.'
        );
      }
      const approval = isApprovalAction(action);
      const leaf = await assertDelegatedToolActionPending({
        action,
        agent: runtime.agent,
        binding: runtime.conversationBinding,
        requiresApproval: approval,
      });
      const delegation = action.delegation;
      if (!(leaf?.toolName && delegation)) {
        throw new Error('Live decision has no delegated native leaf.');
      }
      requireAnswerRecords();
      const toolName = resolveDiscoveredApprovalToolName(
        leaf.toolName,
        runtime.toolNameMap,
        action.runId
      );
      const grantedPolicy =
        approval && action.action === 'approve' ? request.permissionPolicy : undefined;
      const granted = grantedPolicy
        ? await findGrantedBackgroundApprovals({
            allows: allowedBySnapshot(grantedPolicy, runtime.toolNameMap),
            manager,
            runtime,
            scope,
            select: (candidate) => candidate.id !== task.id,
          })
        : [];
      await answerGranted(
        owner,
        granted,
        {
          answer: { delegation, runId: action.runId, toolCallId: action.toolCallId },
          answered: approval
            ? {
                decision: action.action,
                delegation,
                reason: 'user',
                runId: action.runId,
                toolCallId: action.toolCallId,
                toolName,
                type: 'tool-approval-answered',
              }
            : undefined,
          resume: {
            resumeData: approval
              ? { approved: action.action === 'approve' }
              : withApprovalRider(action, runtime.askTools.has(leaf.toolName), leaf.toolName),
            task,
          },
        },
        grantedPolicy ? () => channel.remember(grantedPolicy) : undefined
      );
      logger.info('Decision delivered into the running leg', {
        answeredSiblings: granted.map((entry) => entry.task.id),
        code: 'live_decision_delivered',
        runId: action.runId,
        taskId: task.id,
        toolCallId: action.toolCallId,
      });
      await runtime.conversationBinding?.recordLiveDecision?.(
        deliveredDecisionRecord({
          action,
          answeredSiblingTaskIds: granted.map((entry) => entry.task.id),
          delegationToolCallId: delegation.toolCallId,
          permissionPolicy: request.permissionPolicy,
          taskId: task.id,
          toolName,
        })
      );
    },
    async suspended(taskId) {
      const remembered = channel.remembered;
      if (!remembered) {
        return;
      }
      // The parked leaf once known: a failure before it has no call id to name
      // and stays in the coded error log, never a row with an invented id.
      let answering: GrantedBackgroundApproval | undefined;
      let failure: string | undefined;
      try {
        const { manager, scope } = requireScope();
        const owner = requireLiveOwner(runtime);
        const granted = await findGrantedBackgroundApprovals({
          allows: allowedBySnapshot(remembered, runtime.toolNameMap),
          manager,
          runtime,
          scope,
          select: (candidate) => candidate.id === taskId,
        });
        if (granted.length === 0) {
          return;
        }
        [answering] = granted;
        await answerGranted(owner, granted);
        logger.info('Remembered session grant answered a later pause', {
          code: 'live_decision_remembered_grant',
          taskId,
        });
      } catch (error) {
        // The card stays for the user; nothing native happened.
        failure = error instanceof Error ? error.message : String(error);
        logger.error('A remembered session grant could not answer a later pause', {
          code: 'live_decision_remembered_grant_failed',
          error: failure,
          taskId,
        });
      }
      // Recorded after the attempt, so a rejecting record can never relabel a
      // pause that was answered as a failed one.
      if (answering) {
        await runtime.conversationBinding?.recordLiveDecision?.(
          rememberedDecisionRecord({ entry: answering, failure, remembered })
        );
      }
    },
  });
}
