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
import { assertDelegatedToolActionPending } from './delegated-tool-actions';
import {
  type LiveBackgroundOwner,
  type LiveDecisionAction,
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
 * Arm a leg's live decision handler on its runtime channel (settled
 * 2026-09-14, do not relitigate: a decision reaches the RUNNING leg).
 *
 * `deliver`: the explicit decision is validated against the live native
 * snapshot exactly as a click on a new leg would be, recorded with the host
 * as consumed (never the root's single active claim — the leg may hold that
 * claim already), its parked siblings that the request's fresh snapshot now
 * allows are recorded the same way, the answers are published on the leg's
 * own stream so every card locks, and the owning phase resumes the tasks
 * in-process. A lasting grant is remembered once the records succeed and
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
  const requireRecord = () => {
    const record = runtime.conversationBinding?.recordToolActionAnswer;
    if (!record) {
      throw new Error('Live decisions require host-owned answer records.');
    }
    return record;
  };
  const answerGranted = async (
    owner: LiveBackgroundOwner,
    granted: readonly GrantedBackgroundApproval[],
    explicit?: {
      readonly answered: StreamChunkToolApprovalAnswered | undefined;
      readonly resume: { readonly resumeData: unknown; readonly task: BackgroundTask };
      readonly record: () => Promise<void>;
    },
    remember?: () => void
  ) => {
    const reservation = owner.reserve([
      ...(explicit ? [explicit.resume.task] : []),
      ...granted.map((entry) => entry.task),
    ]);
    let answered: readonly StreamChunkToolApprovalAnswered[];
    try {
      await explicit?.record();
      answered = [
        ...(explicit?.answered ? [explicit.answered] : []),
        ...(await recordGrantedBackgroundApprovals({ granted, runtime })),
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
      const record = requireRecord();
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
          record: () => record({ delegation, runId: action.runId, toolCallId: action.toolCallId }),
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
    },
    async suspended(taskId) {
      const remembered = channel.remembered;
      if (!remembered) {
        return;
      }
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
        await answerGranted(owner, granted);
        logger.info('Remembered session grant answered a later pause', {
          code: 'live_decision_remembered_grant',
          taskId,
        });
      } catch (error) {
        // The card stays for the user; nothing native happened.
        logger.error('A remembered session grant could not answer a later pause', {
          code: 'live_decision_remembered_grant_failed',
          error: error instanceof Error ? error.message : String(error),
          taskId,
        });
      }
    },
  });
}
