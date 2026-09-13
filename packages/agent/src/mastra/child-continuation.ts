import { createHash } from 'node:crypto';
import type {
  AssistantToolApprovalAction,
  AssistantToolResumeAction,
} from '@brainstrike/assistant-contract';
import {
  assertAssistantChildImageCapability,
  assistantChildInputContents,
} from '@brainstrike/assistant-contract';
import type { AssistantChildFollowupAction } from '@brainstrike/assistant-contract/child-followup';
import { Agent, createMessageSignal, createSignal } from '@mastra/core/agent';
import type { AgentMessage, ConversationStreamChunk, StreamChunk, StreamIterator } from '../types';
import { createMastraAgentRuntime, type MastraAgentRuntimeOptions } from './agent-runtime';
import {
  createStreamIteratorFromRuntime,
  createToolApprovalIteratorFromRuntime,
  createToolResumeIteratorFromRuntime,
} from './attempt-legs';
import { CHILD_BRANCH_MEMORY_OPTIONS, childBranchInputProcessors } from './child-branch';
import type {
  ChildContinuationBaseline,
  ChildContinuationHostPort,
  ChildContinuationStatus,
} from './child-continuation-host-port';
import {
  type ContinuationUsageProcessor,
  createContinuationUsageProcessor,
} from './child-continuation-usage';
import { CHILD_INPUT_CONTEXT_KEY } from './child-input-context';
import { configureChildContinuation, restoreChildExecution } from './child-run-configuration';
import {
  readAdmittedPersonaConfiguration,
  withAdmittedPersonaSnapshots,
} from './delegated-persona-snapshots';

/** A managed host leg wakes the exact stored child; the original delegation remains immutable. */
export async function createChildFollowupStream(
  input: AssistantChildFollowupAction,
  options: MastraAgentRuntimeOptions
): Promise<StreamIterator> {
  const host = options.conversationBinding?.continuation;
  if (!host) {
    throw new Error('The host does not provide durable child continuation.');
  }
  const scope = await host.prepareContinuation(input, (configuration) =>
    configureChildContinuation(configuration, input, options)
  );
  let runtime: Awaited<ReturnType<typeof createMastraAgentRuntime>> | undefined;
  try {
    const persona = readAdmittedPersonaConfiguration(scope.configuration);
    assertAssistantChildImageCapability(
      input,
      persona.model?.provider ?? options.runtime?.provider,
      persona.model?.modelId ?? options.runtime?.model
    );
    const profile = restoreChildExecution(
      scope.configuration,
      await withAdmittedPersonaSnapshots([persona], options)
    );
    const restored = {
      ...profile,
      runtime: { ...profile.runtime, assistantMessageId: scope.messageId },
    };
    const usageProcessor = createContinuationUsageProcessor(host, input.id, scope);
    runtime = await createMastraAgentRuntime({
      ...restored,
      continuationChildScope: {
        resourceId: scope.resourceId,
        threadId: scope.threadId,
        usageProcessor,
      },
      delegatedDepthOffset: scope.depth - 1,
    });
    const child = (await runtime.agent.listAgents())[persona.id];
    if (!(child instanceof Agent)) {
      throw new Error('The admitted child cannot use the current model or tool capabilities.');
    }
    const inputProcessors = await childBranchInputProcessors(child, scope);
    const branchInputMessageId = scope.branchInputMessageId;
    if (scope.branch?.kind === 'edit' && !branchInputMessageId) {
      throw new Error('Child edit has no admitted native input identity.');
    }
    const branchMessages: AgentMessage[] = [];
    if (scope.branch?.kind === 'edit' && branchInputMessageId) {
      branchMessages.push({
        id: branchInputMessageId,
        parts: assistantChildInputContents(input).map((part) =>
          part.type === 'text' ? part : { ...part, type: 'file' as const }
        ),
        role: 'user',
      });
    }
    let binding: ChildContinuationBaseline | undefined;
    let nativeRunId: string | undefined;
    const stream = await createStreamIteratorFromRuntime({
      runtime: {
        ...runtime,
        agent: child,
        childExecution: {
          maxSteps: persona.maxSteps,
          ...(inputProcessors ? { inputProcessors } : {}),
        },
      },
      runtimeData: {
        ...restored.runtime,
        ...(restored.childExecutionConfiguration
          ? {
              model: restored.childExecutionConfiguration.model,
              provider: restored.childExecutionConfiguration.provider,
            }
          : {}),
        memory: {
          resourceId: scope.resourceId,
          threadId: scope.threadId,
          ...(scope.branch ? { memoryOptions: CHILD_BRANCH_MEMORY_OPTIONS } : {}),
        },
      },
      ...(options.memory ? { memory: options.memory } : {}),
      messages: branchMessages,
      ...(scope.branch
        ? {
            onNativeStart: async (runId: string) => {
              nativeRunId = runId;
              binding = await host.bindContinuation({ id: input.id, nativeRunId: runId });
            },
          }
        : {
            nativeWake: {
              maxSteps: persona.maxSteps,
              async onWake(runId) {
                nativeRunId = runId;
                binding = await host.bindContinuation({ id: input.id, nativeRunId: runId });
              },
              signal: createMessageSignal(
                {
                  contents: assistantChildInputContents(input),
                  metadata: {
                    brainstrikeChildContinuation: input.id,
                    [CHILD_INPUT_CONTEXT_KEY]: [],
                  },
                },
                {
                  id: `child-continuation:${createHash('sha256')
                    .update(JSON.stringify([scope.resourceId, scope.threadId, input.id]))
                    .digest('hex')}`,
                }
              ),
            },
          }),
    });
    if (!(binding && nativeRunId)) {
      throw new Error('Child continuation has no admitted native run.');
    }
    const branchStream =
      scope.branch?.kind === 'edit'
        ? (async function* () {
            if (!branchInputMessageId) {
              throw new Error('Child edit has no admitted native input identity.');
            }
            yield {
              createdAt: new Date().toISOString(),
              id: branchInputMessageId,
              text: input.text,
              type: 'child-user-message' as const,
              ...(input.attachments ? { attachments: input.attachments } : {}),
            };
            yield* stream;
          })()
        : stream;
    return projectContinuation(
      branchStream,
      host,
      input.id,
      nativeRunId,
      binding,
      options,
      usageProcessor
    );
  } catch (error) {
    const cleanup = await Promise.allSettled([
      runtime?.dispose(),
      host.finishContinuation({
        error: 'Child continuation initialization failed.',
        id: input.id,
        status: 'failed',
      }),
    ]);
    const failures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length) {
      throw new AggregateError(
        [error, ...failures],
        'Child continuation initialization and cleanup failed.'
      );
    }
    throw error;
  }
}

interface ContinuationProjection {
  baselineSent: boolean;
  failureDetail?: string;
  sequence: number;
  status: ChildContinuationStatus;
  readonly text: string[];
}

async function projectContinuationChunk(
  raw: StreamChunk,
  host: ChildContinuationHostPort,
  id: string,
  nativeRunId: string,
  binding: ChildContinuationBaseline,
  state: ContinuationProjection
): Promise<StreamChunk> {
  if (raw.type === 'delegated-conversation-chunk') {
    return { ...raw, continuationId: id };
  }
  if (raw.type === 'child-continuation-chunk') {
    return raw;
  }
  let chunk: ConversationStreamChunk = raw;
  if (chunk.type === 'tool-approval-required' || chunk.type === 'tool-suspend-required') {
    state.status = chunk.type === 'tool-approval-required' ? 'awaiting-approval' : 'awaiting-input';
    chunk = { ...chunk, continuationId: id };
  }
  if (chunk.type === 'text-delta') {
    state.text.push(chunk.value);
  }
  if (chunk.type === 'run-event') {
    if (chunk.event.kind === 'run.failed') {
      state.status = 'failed';
      state.failureDetail = chunk.event.detail ?? chunk.event.label;
    }
    chunk = {
      ...chunk,
      event: {
        ...chunk.event,
        metadata: { ...chunk.event.metadata, continuationId: id },
        runId: nativeRunId,
      },
    };
    await host.persistContinuationEvent({
      event: chunk.event,
      id,
      messageId: binding.messageId,
      sequence: state.sequence++,
    });
  }
  if (chunk.type === 'message-finish' && chunk.finishReason === 'error') {
    state.status = 'failed';
  }
  const baseline = state.baselineSent ? {} : { baseline: binding.baseline };
  state.baselineSent = true;
  return {
    ...baseline,
    chunk,
    continuationId: id,
    messageId: binding.messageId,
    nativeRunId,
    threadId: binding.threadId,
    type: 'child-continuation-chunk',
  };
}

async function settleContinuation(
  host: ChildContinuationHostPort,
  id: string,
  status: ChildContinuationStatus,
  failure: unknown
): Promise<void> {
  try {
    await host.finishContinuation({
      id,
      status,
      ...(status === 'failed'
        ? {
            error:
              failure === undefined
                ? 'Child continuation failed.'
                : failure instanceof Error
                  ? failure.message
                  : String(failure),
          }
        : {}),
    });
  } catch (settleError) {
    if (failure !== undefined) {
      throw new AggregateError(
        [failure, settleError],
        'Child continuation and receipt settlement failed.'
      );
    }
    throw settleError;
  }
}

async function* projectContinuation(
  stream: StreamIterator,
  host: ChildContinuationHostPort,
  id: string,
  nativeRunId: string,
  binding: ChildContinuationBaseline,
  options: MastraAgentRuntimeOptions,
  usageProcessor: ContinuationUsageProcessor
): AsyncIterableIterator<StreamChunk> {
  const signal = options.runtime?.signal;
  const state: ContinuationProjection = {
    baselineSent: false,
    sequence: 0,
    status: 'cancelled',
    text: [],
  };
  let failure: unknown;
  try {
    for await (const raw of stream) {
      const usage = usageProcessor.readUsage();
      const chunk =
        usage && (raw.type === 'finish' || raw.type === 'message-finish') ? { ...raw, usage } : raw;
      yield await projectContinuationChunk(chunk, host, id, nativeRunId, binding, state);
    }
    if (signal?.aborted) {
      state.status = 'cancelled';
    } else if (state.status === 'cancelled') {
      state.status = 'completed';
    }
  } catch (error) {
    state.status = signal?.aborted ? 'cancelled' : 'failed';
    failure = error;
    throw error;
  } finally {
    await settleContinuation(
      host,
      id,
      state.status,
      failure === undefined ? state.failureDetail : failure
    );
  }
  if (state.status === 'completed' && !signal?.aborted) {
    yield* await createRootOutcomeStream(options, id, binding.threadId, state.text.join(''));
  }
}

async function createRootOutcomeStream(
  options: MastraAgentRuntimeOptions,
  continuationId: string,
  childThreadId: string,
  result: string
): Promise<StreamIterator> {
  const runtime = await createMastraAgentRuntime(options);
  return await createStreamIteratorFromRuntime({
    runtime,
    ...(options.runtime ? { runtimeData: options.runtime } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    messages: [],
    nativeWake: {
      async onWake() {},
      signal: createSignal({
        contents: JSON.stringify({ childThreadId, continuationId, result, status: 'completed' }),
        id: `child-continuation-outcome:${continuationId}`,
        tagName: 'child_continuation_result',
        type: 'notification',
      }),
    },
  });
}

export async function createChildContinuationDecisionStream(
  action: AssistantToolApprovalAction | AssistantToolResumeAction,
  options: MastraAgentRuntimeOptions
): Promise<StreamIterator> {
  const host = options.conversationBinding?.continuation;
  if (!(host && action.continuationId)) {
    throw new Error('Child decision requires its durable continuation owner.');
  }
  const decision = {
    ...(action.delegation ? { delegation: action.delegation } : {}),
    id: action.continuationId,
    kind: 'action' in action ? ('tool-approval' as const) : ('tool-resume' as const),
    nativeRunId: action.runId,
    toolCallId: action.toolCallId,
  };
  const scope = await host.resolveContinuationDecision(decision);
  const descendants = action.delegation
    ? await options.conversationBinding?.resolveToolAction?.(action)
    : [];
  if (action.delegation && descendants?.length !== action.delegation.path.length) {
    throw new Error('Continuation decision ancestry is incomplete.');
  }
  const profiles = [
    readAdmittedPersonaConfiguration(scope.configuration),
    ...(descendants ?? []).map((child) =>
      readAdmittedPersonaConfiguration(child.configuration, child.identity.personaId)
    ),
  ];
  const profile = restoreChildExecution(
    scope.configuration,
    await withAdmittedPersonaSnapshots(profiles, options)
  );
  const restored = {
    ...profile,
    runtime: { ...profile.runtime, assistantMessageId: scope.messageId },
  };
  const usageProcessor = createContinuationUsageProcessor(host, decision.id, scope);
  const runtime = await createMastraAgentRuntime({
    ...restored,
    approvalResumeLeg: 'action' in action,
    continuationChildScope: {
      resourceId: scope.resourceId,
      threadId: scope.threadId,
      usageProcessor,
    },
    delegatedDepthOffset: scope.depth - 1,
    hydrateToolDiscoveryFromMemory: true,
  });
  try {
    const persona = readAdmittedPersonaConfiguration(scope.configuration);
    const child = (await runtime.agent.listAgents())[persona.id];
    if (!(child instanceof Agent)) {
      throw new Error('The admitted continuation profile is unavailable.');
    }
    const inputProcessors = await childBranchInputProcessors(child, scope);
    const params = {
      runtime: {
        ...runtime,
        agent: child,
        childExecution: {
          maxSteps: persona.maxSteps,
          ...(inputProcessors ? { inputProcessors } : {}),
        },
        async dispose() {
          try {
            await runtime.dispose();
          } finally {
            await host.finishContinuationDecision(decision);
          }
        },
      },
      runtimeData: {
        ...restored.runtime,
        ...(restored.childExecutionConfiguration
          ? {
              model: restored.childExecutionConfiguration.model,
              provider: restored.childExecutionConfiguration.provider,
            }
          : {}),
        memory: {
          resourceId: scope.resourceId,
          threadId: scope.threadId,
          ...(scope.branch ? { memoryOptions: CHILD_BRANCH_MEMORY_OPTIONS } : {}),
        },
      },
      ...(options.memory ? { memory: options.memory } : {}),
    };
    const stream =
      'action' in action
        ? await createToolApprovalIteratorFromRuntime({
            ...params,
            action,
            requireToolApproval: true,
          })
        : await createToolResumeIteratorFromRuntime({ ...params, action });
    return projectContinuation(
      stream,
      host,
      decision.id,
      decision.nativeRunId,
      scope,
      options,
      usageProcessor
    );
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
