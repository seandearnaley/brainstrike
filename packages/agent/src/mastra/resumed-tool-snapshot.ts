import type { AssistantToolResumeAction } from '@brainstrike/assistant-contract/tool-suspend';
import { createMastraAgentError } from '../mastra-boundary/mastra-agent-error';
import type { RuntimeData } from '../types';
import type { MastraAgentRuntime } from './agent-runtime';
import type { ResumedApprovalToolCall } from './agent-streaming';
import { findPendingBackgroundTask } from './background-resume';
import { assertDelegatedToolActionPending } from './delegated-tool-actions';

/**
 * The suspend-resume transport answers a tool's OWN `suspend()` pause and
 * nothing else. Refuse when the targeted call is suspended for APPROVAL
 * (BST-1097): the two pause kinds carry different resume shapes, and a generic
 * resume payload delivered to an approval pause would reach a self-approving
 * tool as if its gates were already settled — e.g. `{action:'allow'}` answering
 * run_python's Gate A would skip the approval card entirely. Mirrors
 * `readResumedApprovalToolCall`, which enforces the symmetric direction
 * (`requiresApproval === true`) for the approval transport. A missing run or
 * tool call fails visibly here with the same typed error family — never a
 * silent fallthrough to a blind resume.
 */
export async function assertResumedCallIsSuspendPause(
  runtime: MastraAgentRuntime,
  runtimeData: RuntimeData | undefined,
  action: AssistantToolResumeAction
): Promise<{
  readonly toolName: string;
  readonly delegatedLeaf?: NonNullable<ResumedApprovalToolCall['delegatedLeaf']>;
}> {
  const memoryContext = runtimeData?.memory;
  const backgroundTask = await findPendingBackgroundTask(
    runtime.backgroundTaskManager,
    memoryContext,
    action
  );
  if (backgroundTask) {
    const delegated = await assertDelegatedToolActionPending({
      action,
      agent: runtime.agent,
      binding: runtime.conversationBinding,
      requiresApproval: false,
    });
    if (!delegated?.toolName) {
      throw new Error('Background resume requires its authorized native child decision.');
    }
    if (!action.delegation) {
      throw new Error('Background resume requires its authorized native ancestry.');
    }
    return {
      delegatedLeaf: {
        path: action.delegation.path,
        toolCall: {
          args: delegated.args,
          displayToolName: delegated.toolName,
          registeredToolName: delegated.toolName,
          toolCallId: action.delegation.toolCallId,
        },
      },
      toolName: delegated.toolName,
    };
  }
  const { runs } = await runtime.agent.listSuspendedRuns(
    memoryContext
      ? { resourceId: memoryContext.resourceId, threadId: memoryContext.threadId }
      : undefined
  );
  const run = runs.find((candidate) => candidate.runId === action.runId);
  const toolCall = run?.toolCalls.find((candidate) => candidate.toolCallId === action.toolCallId);
  if (!toolCall) {
    throw createMastraAgentError('mastra_agent_stream_failure', {
      context: { runId: action.runId, toolCallId: action.toolCallId },
      detail: 'Suspended tool snapshot is missing the requested tool call.',
    });
  }
  if (toolCall.requiresApproval) {
    throw createMastraAgentError('mastra_agent_stream_failure', {
      context: { runId: action.runId, toolCallId: action.toolCallId },
      detail:
        'The requested tool call is suspended for APPROVAL; answer it through the approval transport, not the suspend-resume transport.',
    });
  }
  const delegated = await assertDelegatedToolActionPending({
    action,
    agent: runtime.agent,
    binding: runtime.conversationBinding,
    requiresApproval: false,
  });
  if (delegated && !delegated.toolName) {
    throw new Error('Delegated suspend snapshot has no observed native leaf tool name.');
  }
  const toolName = delegated?.toolName ?? toolCall.toolName;
  if (!toolName) {
    // The rider decision below keys on the tool's ask registration; a
    // snapshot with no tool name cannot be classified — refuse rather than
    // guessing (a wrong guess either denies a valid resume or widens a
    // payload the tool's schema will reject).
    throw createMastraAgentError('mastra_agent_stream_failure', {
      context: { runId: action.runId, toolCallId: action.toolCallId },
      detail: 'Suspended tool snapshot has no tool name for the requested tool call.',
    });
  }
  return {
    toolName,
    ...(delegated && action.delegation
      ? {
          delegatedLeaf: {
            path: action.delegation.path,
            toolCall: {
              args: delegated.args,
              displayToolName: toolName,
              registeredToolName: toolName,
              toolCallId: action.delegation.toolCallId,
            },
          },
        }
      : {}),
  };
}
