import {
  type DelegatedToolActionIdentity,
  isDelegatedToolActionIdentity,
} from '@brainstrike/assistant-contract';
import { Agent, type AgentRunToolCall } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { createListingOnlyModel } from '../providers/listing-only-model';
import type { DelegatedToolActionScope } from './delegated-conversation-binding';

export type DelegatedSuspensionResolver = (parent: {
  readonly parentRuntimeRunId: string;
  readonly parentThreadId: string;
  readonly parentToolCallId: string;
}) => Promise<DelegatedToolActionScope | undefined>;

/**
 * Read the current leaf through public Agent snapshots and host-owned graph
 * edges. Inert agents use the original persona ids but load no tools, provider
 * credentials, or execution handles. Discovery never resumes a workflow.
 */
export async function discoverDelegatedToolPause(input: {
  readonly resolveInvocation: DelegatedSuspensionResolver;
  readonly rootThreadId: string;
  readonly runId: string;
  readonly storage: MastraCompositeStore;
  readonly toolCall: AgentRunToolCall;
}): Promise<
  | {
      readonly delegation: DelegatedToolActionIdentity;
      readonly suspendedAt: Date;
      readonly toolCall: AgentRunToolCall;
    }
  | undefined
> {
  const path: DelegatedToolActionIdentity['path'][number][] = [];
  let runId = input.runId;
  let threadId = input.rootThreadId;
  let toolCall = input.toolCall;
  let suspendedAt: Date | undefined;
  while (true) {
    const toolCallId = toolCall.toolCallId;
    if (!toolCallId?.trim()) {
      throw new Error('Suspended delegation is missing its native call id.');
    }
    const scope = await input.resolveInvocation({
      parentRuntimeRunId: runId,
      parentThreadId: threadId,
      parentToolCallId: toolCallId,
    });
    if (!scope) {
      break;
    }
    path.push(scope.identity);
    // The same wire bound guards corrupt/cyclic graphs before another read.
    if (!isDelegatedToolActionIdentity({ path, toolCallId: toolCall.toolCallId })) {
      throw new Error('Suspended delegation has invalid or excessive ancestry.');
    }
    const agent = new Agent({
      id: scope.identity.personaId,
      instructions: 'Read suspended workflow metadata only.',
      model: createListingOnlyModel(),
      name: scope.identity.personaId,
    });
    const mastra = new Mastra({
      agents: { discovery: agent },
      logger: false,
      storage: input.storage,
    });
    try {
      const { runs } = await agent.listSuspendedRuns({
        resourceId: scope.resourceId,
        threadId: scope.threadId,
      });
      const run = runs.find((candidate) => candidate.runId === scope.identity.childRuntimeRunId);
      const pending = run?.toolCalls[0];
      if (
        run?.toolCalls.length !== 1 ||
        !pending ||
        pending.requiresApproval !== input.toolCall.requiresApproval
      ) {
        throw new Error('Suspended delegation has no unambiguous native leaf decision.');
      }
      toolCall = pending;
      suspendedAt = run.suspendedAt;
      runId = run.runId;
      threadId = scope.threadId;
    } finally {
      await mastra.shutdown();
    }
  }
  if (path.length === 0) {
    return;
  }
  if (!(suspendedAt && toolCall.toolName && toolCall.toolCallId)) {
    throw new Error('Suspended delegation is missing its native tool identity.');
  }
  return { delegation: { path, toolCallId: toolCall.toolCallId }, suspendedAt, toolCall };
}
