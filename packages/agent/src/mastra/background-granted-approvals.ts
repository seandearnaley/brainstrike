import type { DelegatedToolActionIdentity } from '@brainstrike/assistant-contract';
import type {
  AssistantToolApprovalAction,
  AssistantToolApprovalAnswered,
} from '@brainstrike/assistant-contract/tool-approval';
import { createLogger } from '@brainstrike/logging';
import type { Agent } from '@mastra/core/agent';
import type { BackgroundTask, BackgroundTaskManager } from '@mastra/core/background-tasks';
import type { RuntimeData, StreamChunkToolApprovalAnswered } from '../types';
import type { MastraAgentRuntime } from './agent-runtime';
import { withBackgroundIdleLoop } from './background-idle-loop';
import { createBackgroundLedgerSource, personaLabelFor } from './background-ledger';
import { type BackgroundResume, findPendingBackgroundTask } from './background-resume';
import type {
  DelegatedToolActionAnswer,
  DelegatedToolActionLeaf,
  DelegatedToolActionScope,
  DelegatedToolActionUnanswerable,
} from './delegated-conversation-binding';
import { assertDelegatedToolActionPending } from './delegated-tool-actions';
import {
  readLateBackgroundResults,
  recordLateOverlayWakeup,
} from './late-background-results-processor';
import type { buildStreamOptions } from './runtime-assembly/stream-options';
import type { DelegationOutcomeCapture } from './subagent-delegation';
import { resolveDiscoveredApprovalToolName } from './suspended-run-discovery';

const logger = createLogger('BackgroundGrantedApprovals');

/**
 * A parked background child whose pending approval the current policy now
 * answers. `action` is the same canonical root action the user's own click
 * would have sent for that child; `answered` is the notice update the leg
 * streams so the card locks.
 */
export interface GrantedBackgroundApproval {
  readonly action: AssistantToolApprovalAction & {
    readonly action: 'approve';
    readonly delegation: NonNullable<AssistantToolApprovalAction['delegation']>;
  };
  readonly answered: AssistantToolApprovalAnswered;
  readonly task: BackgroundTask;
}

type SnapshotAgent = Pick<Agent, 'listAgents' | 'listSuspendedRuns'>;

function isSnapshotAgent(value: unknown): value is SnapshotAgent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'listAgents' in value &&
    typeof value.listAgents === 'function' &&
    'listSuspendedRuns' in value &&
    typeof value.listSuspendedRuns === 'function'
  );
}

export function isApprovalSuspension(task: BackgroundTask): boolean {
  const payload = task.suspendPayload;
  return typeof payload === 'object' && payload !== null && 'requireToolApproval' in payload;
}

/**
 * Walk from a parked task's dispatch address down to its pending native leaf:
 * the host resolves each edge read-only (`resolveParkedInvocation`, the same
 * discovery reload uses), the live child agent's suspended-run snapshot names
 * the single pending call, and the walk continues while that call is itself
 * a delegation the host knows. Mirrors `discoverDelegatedToolPause` without
 * building inert agents. No action exists yet, so `resolveToolAction` cannot
 * be used here: the host refuses a bare address by design.
 */
async function readParkedLeaf(params: {
  readonly agent: SnapshotAgent;
  readonly resolveParkedInvocation: NonNullable<
    NonNullable<MastraAgentRuntime['conversationBinding']>['resolveParkedInvocation']
  >;
  readonly rootThreadId: string;
  readonly task: BackgroundTask;
}): Promise<{
  readonly leaf: { readonly toolCallId: string; readonly toolName: string };
  readonly scopes: readonly DelegatedToolActionScope[];
}> {
  const scopes: DelegatedToolActionScope[] = [];
  let leafToolName: string | undefined;
  let parent = params.agent;
  let address = {
    parentRuntimeRunId: params.task.runId,
    parentThreadId: params.rootThreadId,
    parentToolCallId: params.task.toolCallId,
  };
  while (true) {
    const scope = await params.resolveParkedInvocation(address);
    if (!scope) {
      break;
    }
    scopes.push(scope);
    const agents = await parent.listAgents();
    const child = agents[scope.identity.personaId];
    if (!isSnapshotAgent(child)) {
      throw new Error('Parked delegation requires the original native agent configuration.');
    }
    const { runs } = await child.listSuspendedRuns({
      resourceId: scope.resourceId,
      threadId: scope.threadId,
    });
    const run = runs.find((candidate) => candidate.runId === scope.identity.childRuntimeRunId);
    const pending = run?.toolCalls[0];
    if (run?.toolCalls.length !== 1 || !pending?.toolCallId || !pending.toolName) {
      throw new Error('Parked delegation has no unambiguous native leaf decision.');
    }
    if (!pending.requiresApproval) {
      throw new Error('Parked delegation is not waiting on an approval.');
    }
    parent = child;
    leafToolName = pending.toolName;
    address = {
      parentRuntimeRunId: run.runId,
      parentThreadId: scope.threadId,
      parentToolCallId: pending.toolCallId,
    };
  }
  if (!(scopes.length > 0 && leafToolName)) {
    throw new Error('Parked background decision has no authorized child address.');
  }
  // The loop's final address names the leaf call inside the last child.
  return { leaf: { toolCallId: address.parentToolCallId, toolName: leafToolName }, scopes };
}

type GateRuntime = Pick<MastraAgentRuntime, 'askTools' | 'permissionEnforced' | 'toolNameMap'>;

/**
 * "Allowed now" under the runtime's OWN gate: under an enforced policy a tool
 * the root registered that is no longer in the ask set is allowed. Without an
 * enforced policy (a global approval run) nothing is auto-answered.
 */
export function allowedByRuntimeGate(
  runtime: GateRuntime
): ((registeredToolName: string) => boolean) | undefined {
  if (!runtime.permissionEnforced) {
    return;
  }
  return (toolName) => runtime.toolNameMap.has(toolName) && !runtime.askTools.has(toolName);
}

export { allowedBySnapshot } from './approval-gate';

/**
 * The parked background approvals that `allows` now answers (BST-1723,
 * settled 2026-09-14).
 *
 * A session grant is a policy change, and the canonical behaviour (Claude
 * Code's queued permission prompts) is that a prompt the new rule answers is
 * answered — the user is not asked four times for the same read. A one-shot
 * approve changes no policy, so every sibling stays parked; an explicit
 * global approval (no policy) never auto-answers. `select` names which parked
 * tasks are candidates (the explicit decision's siblings, or one task that
 * parked later). An ambiguous or unauthorized parked task throws, exactly as
 * the user's own click on it would.
 *
 * A sibling the host's answer write would refuse for a reason of its OWN is
 * skipped, not answered: `readUnanswerableToolActionLeaves` names both — a
 * leaf another decision already answered, and a leaf whose subtree was
 * stopped (a Stop that never reached `cancelStoredBackgroundInvocations`
 * leaves the subtree stopped and its task still suspended). Neither needs
 * anything from this grant, and refusing the whole leg over either used to
 * refuse the user's own click on every retry that still carried the grant
 * (BST-1749, PR #3209 review and its follow-up). A leaf answered or stopped
 * in the window between this read and the write still refuses the write,
 * which stays all-or-none, as does root-wide admission.
 */
export async function findGrantedBackgroundApprovals(params: {
  readonly allows: (registeredToolName: string) => boolean;
  readonly manager: BackgroundTaskManager;
  readonly runtime: Pick<MastraAgentRuntime, 'agent' | 'conversationBinding' | 'toolNameMap'>;
  readonly scope: { readonly threadId: string; readonly resourceId: string };
  readonly select: (task: BackgroundTask) => boolean;
}): Promise<readonly GrantedBackgroundApproval[]> {
  const { allows, manager, runtime, scope } = params;
  const resolveParkedInvocation = runtime.conversationBinding?.resolveParkedInvocation;
  const readUnanswerableLeaves = runtime.conversationBinding?.readUnanswerableToolActionLeaves;
  if (!(resolveParkedInvocation && readUnanswerableLeaves)) {
    throw new Error(
      'Granted background approvals require host-owned ancestry discovery and its unanswerable-leaf read.'
    );
  }
  const { tasks } = await manager.listTasks({
    resourceId: scope.resourceId,
    status: 'suspended',
    threadId: scope.threadId,
  });
  const candidates: {
    readonly delegation: DelegatedToolActionIdentity;
    readonly leafRunId: string;
    readonly task: BackgroundTask;
    /** The leaf's whole authorized ancestry, as the host's answer write reads it. */
    readonly threadIds: readonly string[];
    readonly toolName: string;
  }[] = [];
  for (const task of tasks) {
    if (!(params.select(task) && isApprovalSuspension(task))) {
      continue;
    }
    const { leaf, scopes } = await readParkedLeaf({
      agent: runtime.agent,
      resolveParkedInvocation,
      rootThreadId: scope.threadId,
      task,
    });
    if (!allows(leaf.toolName)) {
      continue;
    }
    const identities = scopes.map((entry) => entry.identity);
    const leafRunId = identities.at(-1)?.childRuntimeRunId;
    if (!leafRunId) {
      throw new Error('Parked background decision has no authorized child address.');
    }
    candidates.push({
      delegation: { path: identities, toolCallId: leaf.toolCallId },
      leafRunId,
      task,
      threadIds: scopes.map((entry) => entry.threadId),
      toolName: resolveDiscoveredApprovalToolName(leaf.toolName, runtime.toolNameMap, task.runId),
    });
  }
  const leafKey = (leaf: DelegatedToolActionLeaf): string =>
    JSON.stringify([leaf.childRuntimeRunId, leaf.toolCallId]);
  const unanswerable = new Map<string, DelegatedToolActionUnanswerable['reason']>(
    (
      await readUnanswerableLeaves(
        candidates.map((candidate) => ({
          childRuntimeRunId: candidate.leafRunId,
          threadIds: candidate.threadIds,
          toolCallId: candidate.delegation.toolCallId,
        }))
      )
    ).map((leaf) => [leafKey(leaf), leaf.reason])
  );
  const granted: GrantedBackgroundApproval[] = [];
  for (const { delegation, leafRunId, task, toolName } of candidates) {
    const skipped = unanswerable.get(
      leafKey({ childRuntimeRunId: leafRunId, toolCallId: delegation.toolCallId })
    );
    if (skipped) {
      logger.info(
        skipped === 'stopped'
          ? 'A parked sibling was stopped; the grant skips it'
          : 'A parked sibling is already answered; the grant skips it',
        {
          code: 'background_granted_approval_skipped',
          reason: skipped,
          taskId: task.id,
          toolName,
        }
      );
      continue;
    }
    granted.push({
      action: {
        action: 'approve',
        delegation,
        runId: task.runId,
        toolCallId: task.toolCallId,
        toolName,
      },
      answered: {
        decision: 'approve',
        delegation,
        reason: 'session-grant',
        runId: task.runId,
        toolCallId: task.toolCallId,
        toolName,
      },
      task,
    });
  }
  return granted;
}

/**
 * Validate every granted approval with the same native freshness check a
 * click gets, then record them — and a live leg's own user answer, already
 * validated by its caller — with the host in ONE all-or-none write
 * (`recordToolActionAnswers`), and return the notice updates that lock the
 * siblings' cards. A refused answer (a sibling answered concurrently) records
 * nothing, so the user's own pause stays answerable (BST-1749 review). An
 * answer is recorded as consumed outright, never as the root's single active
 * claim: claiming it too would collide with the ledger's
 * one-active-claim-per-root rule (thread-796a942d, 2026-09-14).
 */
export async function recordGrantedBackgroundApprovals(params: {
  /** A live leg's own user answer, recorded in the same write as the siblings. */
  readonly explicit?: DelegatedToolActionAnswer;
  readonly granted: readonly GrantedBackgroundApproval[];
  readonly runtime: Pick<MastraAgentRuntime, 'agent' | 'conversationBinding'>;
}): Promise<readonly StreamChunkToolApprovalAnswered[]> {
  const { explicit, granted, runtime } = params;
  if (!explicit && granted.length === 0) {
    return [];
  }
  const record = runtime.conversationBinding?.recordToolActionAnswers;
  if (!record) {
    throw new Error('Granted background approvals require host-owned answer records.');
  }
  for (const entry of granted) {
    await assertDelegatedToolActionPending({
      action: entry.action,
      agent: runtime.agent,
      binding: runtime.conversationBinding,
      requiresApproval: true,
    });
  }
  await record([
    ...(explicit ? [explicit] : []),
    ...granted.map(({ action }) => ({
      delegation: action.delegation,
      runId: action.runId,
      toolCallId: action.toolCallId,
    })),
  ]);
  if (granted.length > 0) {
    logger.info('Session grant answers parked background children', {
      code: 'background_granted_approvals',
      tasks: granted.map((entry) => ({ taskId: entry.task.id, toolName: entry.answered.toolName })),
    });
  }
  return granted.map((entry) => ({ ...entry.answered, type: 'tool-approval-answered' }));
}

/**
 * Every parent inference the host starts drives its own background
 * continuations (`withBackgroundIdleLoop`): a child's result, failure or
 * cancellation wakes the parent; a child's suspension is a host-surfaced
 * approval and wakes nothing. Without a background owner the output is the
 * leg's single native turn.
 */
export function driveBackgroundWork<Output extends Parameters<typeof withBackgroundIdleLoop>[0]>(
  runtime: MastraAgentRuntime,
  runtimeData: RuntimeData | undefined,
  output: Output,
  options: ReturnType<typeof buildStreamOptions>,
  abortSignal: AbortSignal,
  /** The capture the leg's delegation config records refusals in (`buildStreamOptions`). */
  delegationOutcomes: DelegationOutcomeCapture | undefined
): Output {
  const manager = runtime.backgroundTaskManager;
  if (!manager) {
    return output;
  }
  const scope = runtimeData?.memory;
  if (!scope) {
    throw new Error('Background work requires the original root memory scope.');
  }
  return withBackgroundIdleLoop(output, {
    abortSignal,
    agent: runtime.agent,
    channel: runtime.liveDecisions,
    ledger: createBackgroundLedgerSource({
      manager,
      personaLabel: personaLabelFor(runtime),
      rejectedDelegations: delegationOutcomes,
      resolveInvocation: runtime.conversationBinding?.resolveParkedInvocation,
      scope,
    }),
    manager,
    maxIdleMs: runtime.backgroundIdleMs,
    options,
    recordWakeup: runtime.conversationBinding?.recordWakeup,
    rejectedDelegations: delegationOutcomes,
    scope,
  });
}

/**
 * Everything an approval leg does between its durable claim and native
 * resume: locate the parked task, then answer the parked siblings its policy
 * covers. RECORD LAST (BST-1749, PR #3209 review): every fallible step runs
 * BEFORE the answers are recorded, so the record is the leg's last DURABLE
 * act. What follows it is stream construction and then native resume — a
 * background leg builds `createBackgroundResumeStream` after this returns
 * (`attempt-legs.ts`), and that construction is the boundary: it registers
 * the resumed executors rather than writing, and its failures surface on the
 * stream the leg already owns, never as an unrecorded answer. The caller runs
 * this inside `beforeDelegatedToolActionResume`, which releases the claim
 * when it fails.
 */
export async function prepareApprovalResume(params: {
  readonly action: AssistantToolApprovalAction & { readonly action: 'approve' | 'decline' };
  /** A background resume needs durable memory; a foreground one does not. */
  readonly hasDurableMemory: boolean;
  readonly runtime: MastraAgentRuntime;
  readonly runtimeData: RuntimeData | undefined;
  readonly signal: AbortSignal;
}): Promise<{
  readonly answeredApprovals: readonly StreamChunkToolApprovalAnswered[];
  readonly backgroundTask: BackgroundTask | undefined;
  readonly late: BackgroundTask[];
  readonly resumes: readonly BackgroundResume[];
}> {
  const { action, runtime, runtimeData } = params;
  params.signal.throwIfAborted();
  const task = await findPendingBackgroundTask(
    runtime.backgroundTaskManager,
    runtimeData?.memory,
    action
  );
  if (!task) {
    const late = await readLateBackgroundResults(runtime, runtimeData, action.runId);
    await recordLateOverlayWakeup(runtime, late);
    return { answeredApprovals: [], backgroundTask: undefined, late, resumes: [] };
  }
  if (!params.hasDurableMemory) {
    throw new Error('Background resume requires durable memory.');
  }
  // A session grant recorded with this approval reaches the runtime as its
  // permission snapshot; every parked sibling that snapshot now allows is
  // answered and resumed in this same leg.
  return {
    backgroundTask: task,
    late: [],
    ...(await claimGrantedBackgroundResumes({
      decision: { resumeData: { approved: action.action === 'approve' }, task },
      runtime,
      runtimeData,
    })),
  };
}

/**
 * The resumes an approval leg runs: the user's own decision first, then every
 * parked sibling the leg's policy answers, each durably recorded exactly as
 * a user click would be, plus the notice updates that lock their cards.
 */
export async function claimGrantedBackgroundResumes(params: {
  readonly decision: BackgroundResume;
  readonly runtime: MastraAgentRuntime;
  readonly runtimeData: RuntimeData | undefined;
}): Promise<{
  readonly answeredApprovals: readonly StreamChunkToolApprovalAnswered[];
  readonly resumes: readonly BackgroundResume[];
}> {
  const { decision, runtime, runtimeData } = params;
  const manager = runtime.backgroundTaskManager;
  const scope = runtimeData?.memory;
  if (!(manager && scope)) {
    throw new Error('Background decisions require the original root memory scope.');
  }
  const allows = allowedByRuntimeGate(runtime);
  const granted = allows
    ? await findGrantedBackgroundApprovals({
        allows,
        manager,
        runtime,
        scope,
        select: (task) => task.id !== decision.task.id,
      })
    : [];
  const answeredApprovals = await recordGrantedBackgroundApprovals({ granted, runtime });
  return {
    answeredApprovals,
    resumes: [
      decision,
      ...granted.map((entry) => ({ resumeData: { approved: true }, task: entry.task })),
    ],
  };
}
