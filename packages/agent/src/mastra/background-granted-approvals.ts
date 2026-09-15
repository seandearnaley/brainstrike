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
import type { BackgroundResume } from './background-resume';
import type { DelegatedToolActionScope } from './delegated-conversation-binding';
import { assertDelegatedToolActionPending } from './delegated-tool-actions';
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
  if (!resolveParkedInvocation) {
    throw new Error('Granted background approvals require host-owned ancestry discovery.');
  }
  const { tasks } = await manager.listTasks({
    resourceId: scope.resourceId,
    status: 'suspended',
    threadId: scope.threadId,
  });
  const granted: GrantedBackgroundApproval[] = [];
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
    const delegation = { path: scopes.map((entry) => entry.identity), toolCallId: leaf.toolCallId };
    const toolName = resolveDiscoveredApprovalToolName(
      leaf.toolName,
      runtime.toolNameMap,
      task.runId
    );
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
 * Record every granted approval with the host, after the same native
 * freshness check a click gets, and return the notice updates that lock
 * their cards. A policy answer is recorded as consumed outright
 * (`recordToolActionAnswer`), never as the root's single active claim:
 * claiming it too would collide with the ledger's one-active-claim-per-root
 * rule (thread-796a942d, 2026-09-14).
 */
export async function recordGrantedBackgroundApprovals(params: {
  readonly granted: readonly GrantedBackgroundApproval[];
  readonly runtime: Pick<MastraAgentRuntime, 'agent' | 'conversationBinding'>;
}): Promise<readonly StreamChunkToolApprovalAnswered[]> {
  const { granted, runtime } = params;
  const record = runtime.conversationBinding?.recordToolActionAnswer;
  if (granted.length > 0 && !record) {
    throw new Error('Granted background approvals require host-owned answer records.');
  }
  for (const entry of granted) {
    await assertDelegatedToolActionPending({
      action: entry.action,
      agent: runtime.agent,
      binding: runtime.conversationBinding,
      requiresApproval: true,
    });
    await record?.({
      delegation: entry.action.delegation,
      runId: entry.action.runId,
      toolCallId: entry.action.toolCallId,
    });
  }
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
