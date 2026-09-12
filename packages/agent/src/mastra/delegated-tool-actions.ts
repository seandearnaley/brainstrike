import type {
  DelegatedOriginalToolCall,
  DelegatedToolActionIdentity,
} from '@brainstrike/assistant-contract';
import type { Agent, AgentRunToolCall } from '@mastra/core/agent';
import type {
  DelegatedConversationBinding,
  DelegatedToolActionScope,
} from './delegated-conversation-binding';

interface ToolActionTarget {
  readonly continuationId?: string;
  readonly delegation?: DelegatedToolActionIdentity;
  readonly runId: string;
  readonly toolCallId: string;
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

async function readPendingCall(
  agent: SnapshotAgent,
  scope: DelegatedToolActionScope,
  toolCallId: string,
  requiresApproval: boolean
): Promise<AgentRunToolCall> {
  const { runs } = await agent.listSuspendedRuns({
    resourceId: scope.resourceId,
    threadId: scope.threadId,
  });
  const run = runs.find((candidate) => candidate.runId === scope.identity.childRuntimeRunId);
  const call = run?.toolCalls.find((candidate) => candidate.toolCallId === toolCallId);
  if (!call || call.requiresApproval !== requiresApproval) {
    throw new Error('The delegated tool decision is stale or belongs to another pending call.');
  }
  // Native delegation forwards one suspended call at a time. Do not approve
  // an ambiguous snapshot by relying on its implicit target selection.
  if (run?.toolCalls.length !== 1) {
    throw new Error(
      'The delegated snapshot contains multiple pending calls and has no exact native resume target.'
    );
  }
  return call;
}

/**
 * Verify leaf freshness through public native snapshots after the host has
 * authorized ancestry. Never infer child resource/thread ids from their strings.
 * The parent alias can survive multiple distinct leaf pauses in one delegation.
 */
export async function assertDelegatedToolActionPending(input: {
  readonly action: ToolActionTarget;
  readonly agent: SnapshotAgent;
  readonly binding: DelegatedConversationBinding | undefined;
  readonly requiresApproval: boolean;
}): Promise<
  (AgentRunToolCall & { readonly originalToolCall?: DelegatedOriginalToolCall }) | undefined
> {
  const { action, binding } = input;
  if (action.continuationId && !action.delegation) {
    return;
  }
  if (!binding?.resolveToolAction) {
    if (action.delegation) {
      throw new Error('Delegated tool decisions require host-owned ancestry verification.');
    }
    return;
  }
  const scopes = await binding.resolveToolAction(action);
  if (scopes.length === 0) {
    if (action.delegation) {
      throw new Error('Delegated tool decision has no authorized native ancestry.');
    }
    return;
  }
  if (!action.delegation || scopes.length !== action.delegation.path.length) {
    throw new Error('Delegated tool decision has incomplete authorized ancestry.');
  }
  let parent = input.agent;
  let leaf: AgentRunToolCall | undefined;
  for (const [index, scope] of scopes.entries()) {
    const agents = await parent.listAgents();
    const child = agents[scope.identity.personaId];
    if (!isSnapshotAgent(child)) {
      throw new Error('Delegated tool decision requires the original native agent configuration.');
    }
    const toolCallId = scopes[index + 1]?.identity.parentToolCallId ?? action.delegation.toolCallId;
    leaf = await readPendingCall(child, scope, toolCallId, input.requiresApproval);
    parent = child;
  }
  if (!leaf?.toolName || (input.requiresApproval && leaf.args === undefined)) {
    throw new Error('The delegated snapshot is missing its tool identity or approval arguments.');
  }
  const originalToolCall = scopes[0]?.originalToolCall;
  return { ...leaf, ...(originalToolCall ? { originalToolCall } : {}) };
}

async function claimContinuationToolAction(
  action: ToolActionTarget,
  binding: DelegatedConversationBinding | undefined,
  native: { readonly agent: SnapshotAgent; readonly requiresApproval: boolean }
): Promise<void> {
  const host = binding?.continuation;
  if (!(host && action.continuationId)) {
    throw new Error('Child continuation decision requires durable host admission.');
  }
  const decision = {
    ...(action.delegation ? { delegation: action.delegation } : {}),
    id: action.continuationId,
    kind: native.requiresApproval ? ('tool-approval' as const) : ('tool-resume' as const),
    nativeRunId: action.runId,
    toolCallId: action.toolCallId,
  };
  const scope = await host.resolveContinuationDecision(decision);
  await host.claimContinuationDecision(decision);
  try {
    if (action.delegation) {
      await assertDelegatedToolActionPending({ action, binding, ...native });
      await binding?.prepareToolAction?.(action);
      return;
    }
    const { runs } = await native.agent.listSuspendedRuns({
      resourceId: scope.resourceId,
      threadId: scope.threadId,
    });
    const run = runs.find((entry) => entry.runId === action.runId);
    const call = run?.toolCalls.find((entry) => entry.toolCallId === action.toolCallId);
    if (!call || call.requiresApproval !== native.requiresApproval || run?.toolCalls.length !== 1) {
      throw new Error('Child continuation decision is stale or ambiguous.');
    }
  } catch (error) {
    try {
      await host.releaseUnexecutedContinuationDecision(decision);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'Child continuation validation and release failed.'
      );
    }
    throw error;
  }
}

/** Hold host admission until this runtime settles; validation alone is not atomic. */
export async function claimDelegatedToolAction(
  action: ToolActionTarget,
  binding: DelegatedConversationBinding | undefined,
  native: { readonly agent: SnapshotAgent; readonly requiresApproval: boolean }
): Promise<void> {
  if (action.continuationId) {
    return await claimContinuationToolAction(action, binding, native);
  }
  if (!action.delegation) {
    return;
  }
  if (
    !(binding?.claimToolAction && binding.finishToolActions && binding.releaseUnexecutedToolAction)
  ) {
    throw new Error('Delegated tool decisions require durable host admission and settlement.');
  }
  await binding.claimToolAction(action);
  // The earlier read can race another completed resume before admission.
  // The durable root claim now excludes competing host resume legs.
  try {
    await assertDelegatedToolActionPending({ action, binding, ...native });
    await binding.prepareToolAction?.(action);
  } catch (error) {
    // No native resume call has occurred at this boundary. A failed read must
    // not permanently consume a still-pending decision. Later failures and
    // cancellation remain consumed because their effect is not knowable here.
    try {
      await binding.releaseUnexecutedToolAction(action);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'Delegated decision validation and release failed.'
      );
    }
    throw error;
  }
}
