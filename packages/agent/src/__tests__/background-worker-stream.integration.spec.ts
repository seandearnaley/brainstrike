import { addAbortListener } from 'node:events';
import { TransformStream } from 'node:stream/web';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { AgentExecutionOptionsBase } from '@mastra/core/agent';
import { createTool, type ToolExecutionContext } from '@mastra/core/tools';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import {
  createStreamIteratorFromRuntime,
  createToolApprovalIteratorFromRuntime,
  createToolResumeIteratorFromRuntime,
} from '../mastra/attempt-legs';
import { repairBackgroundResults } from '../mastra/background-results';
import {
  createDelegatedConversationBinding,
  type DelegatedConversationIdentity,
} from '../mastra/delegated-conversation-binding';
import type { DelegatedRunIdentity } from '../mastra/delegated-run-publication';
import { listSuspendedMastraRuns } from '../mastra/suspended-run-discovery';
import { createPgliteMastraMemory } from '../pglite-mastra-memory';
import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '../test-fixtures/scripted-agent-model';
import { createAskUserTool } from '../tools/ask-user-tool';
import { createSubmitPlanTool } from '../tools/submit-plan-tool';
import type { StreamChunk } from '../types';

async function createBackgroundFixture(
  requireApproval = false,
  signal?: AbortSignal,
  question: boolean | 'then-plan' = false
) {
  const database = await createEnginePglite();
  const scope = { resourceId: 'background-owner', threadId: 'background-root' };
  const backing = await createPgliteMastraMemory({
    backgroundTaskScope: scope,
    database: {
      exec: (sql) => database.exec(sql),
      query: (sql, values) => database.query(sql, values ? [...values] : undefined),
      transaction: (operation) =>
        database.transaction((tx) =>
          operation({
            exec: (sql) => tx.exec(sql),
            query: (sql, values) => tx.query(sql, values ? [...values] : undefined),
          })
        ),
    },
    memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
  });
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const identities: DelegatedConversationIdentity[] = [];
  const runIdentities: DelegatedRunIdentity[] = [];
  const toolSignals: AbortSignal[] = [];
  const effect = vi.fn(async (_input: unknown, context?: ToolExecutionContext) => {
    const signal = context?.abortSignal;
    if (!signal) {
      throw new Error('Native background tool omitted its cancellation signal.');
    }
    toolSignals.push(signal);
    const aborted = Promise.withResolvers<never>();
    const subscription = addAbortListener(signal, () => aborted.reject(signal.reason));
    entered.resolve();
    try {
      await Promise.race([release.promise, aborted.promise]);
      return { matches: ['BACKGROUND_EVIDENCE'] };
    } finally {
      subscription[Symbol.dispose]();
    }
  });
  const model = scriptedAgentModel((options) => {
    if (options.tools?.some((tool) => tool.name === 'agent-explore')) {
      if (!hasToolResult(options, 'agent-explore')) {
        return toolCallParts('agent-explore', 'background-child', {
          prompt: 'Read background evidence',
        });
      }
      return textParts(
        JSON.stringify(options.prompt).includes('CHILD_FINAL_EVIDENCE')
          ? 'PARENT_FINAL_OUTCOME'
          : 'PARENT_USEFUL_PROGRESS'
      );
    }
    if (question && !hasToolResult(options, 'brainstrike_askUser')) {
      return toolCallParts('brainstrike_askUser', 'background-question', {
        question: 'Which evidence should I inspect?',
      });
    }
    if (question === 'then-plan' && !hasToolResult(options, 'brainstrike_submitPlan')) {
      return toolCallParts('brainstrike_submitPlan', 'background-plan', {
        overview: 'Read the selected evidence.',
        steps: [{ title: 'Read evidence' }],
        title: 'Inspect evidence',
      });
    }
    return hasToolResult(options, 'brainstrike_grepSearch')
      ? textParts('CHILD_FINAL_EVIDENCE')
      : toolCallParts('brainstrike_grepSearch', 'background-read', { pattern: 'evidence' });
  });
  const runtimeData = {
    apiKey: 'test-key',
    memory: scope,
    model: 'gpt-5.4',
    provider: 'openai',
    ...(signal ? { signal } : {}),
  } as const;
  const options = {
    backgroundTaskScope: scope,
    conversationBinding: {
      claimToolAction: async () => {},
      finishToolActions: async () => {},
      prepareToolAction: async () => {},
      releaseUnexecutedToolAction: async () => {},
      resolveToolAction: async (action: { runId: string; toolCallId: string }) => {
        const identity = runIdentities.find(
          (candidate) =>
            candidate.parentRuntimeRunId === action.runId &&
            candidate.parentToolCallId === action.toolCallId
        );
        const child = identities.find(
          (candidate) =>
            candidate.parentRuntimeRunId === action.runId &&
            candidate.parentToolCallId === action.toolCallId
        );
        if (!(identity && child)) {
          throw new Error('Unknown test invocation');
        }
        return [
          {
            identity,
            resourceId: child.childResourceId,
            threadId: child.childThreadId,
            ...(child.originalToolCall ? { originalToolCall: child.originalToolCall } : {}),
          },
        ];
      },
      ...createDelegatedConversationBinding(async (identity) => {
        identities.push(identity);
      }),
      bindRun: async (identity: DelegatedRunIdentity) => {
        runIdentities.push(identity);
        const child = identities.find(
          (entry) => entry.parentToolCallId === identity.parentToolCallId
        );
        if (!child) {
          throw new Error('Missing native child identity');
        }
        const { messages } = await backing.memory.recall({
          perPage: false,
          resourceId: child.childResourceId,
          threadId: child.childThreadId,
        });
        const previous = messages.findLast((message) => message.role === 'assistant');
        return { threadId: child.childThreadId, ...(previous ? { messageId: previous.id } : {}) };
      },
    },
    getDelegatedSystemContext: () => [],
    memory: backing.memory,
    modelOverride: model.model,
    personas: [
      {
        allowedToolIds: [
          'brainstrike.grepSearch',
          ...(question ? ['brainstrike.askUser', 'brainstrike.submitPlan'] : []),
        ],
        description: 'Read evidence',
        id: 'explore',
        instructions: 'Read evidence',
        label: 'Explorer',
        maxSteps: 4,
      },
    ],
    runtime: runtimeData,
    storage: backing.storage,
    tools: {
      ...(question
        ? {
            'brainstrike.askUser': createAskUserTool(),
            'brainstrike.submitPlan': createSubmitPlanTool(),
          }
        : {}),
      'brainstrike.grepSearch': createTool({
        description: 'Read evidence',
        execute: effect,
        id: 'brainstrike.grepSearch',
        inputSchema: z.object({ pattern: z.string() }),
        requireApproval,
      }),
    },
  };
  const runtime = await createMastraAgentRuntime(options);
  return {
    backing,
    database,
    discoveryOptions: {
      ...options,
      delegatedSuspensionDiscovery: async (parent: {
        parentRuntimeRunId: string;
        parentToolCallId: string;
      }) => {
        const identity = runIdentities.find(
          (candidate) =>
            candidate.parentRuntimeRunId === parent.parentRuntimeRunId &&
            candidate.parentToolCallId === parent.parentToolCallId
        );
        const child = identities.find(
          (candidate) =>
            candidate.parentRuntimeRunId === parent.parentRuntimeRunId &&
            candidate.parentToolCallId === parent.parentToolCallId
        );
        if (!(identity && child)) {
          return;
        }
        return { identity, resourceId: child.childResourceId, threadId: child.childThreadId };
      },
    },
    effect,
    entered,
    model,
    release,
    runtime,
    runtimeData,
    scope,
    toolSignals,
  };
}

it('streams useful parent output, the complete rich background child and the final parent outcome once', async () => {
  const { database, backing, runtime, runtimeData, effect, release, entered, model } =
    await createBackgroundFixture();
  const progress = Promise.withResolvers<void>();
  try {
    expect(runtime.agent.getBackgroundTasksConfig()?.tools).toEqual({ explore: true });
    const iterator = await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [
        {
          id: 'request',
          parts: [{ text: 'Inspect the background evidence', type: 'text' }],
          role: 'user',
        },
      ],
      runtime,
      runtimeData,
    });
    const chunks: StreamChunk[] = [];
    const consuming = (async () => {
      for await (const chunk of iterator) {
        chunks.push(chunk);
        if (chunk.type === 'text-delta' && chunk.value.includes('PARENT_USEFUL_PROGRESS')) {
          progress.resolve();
        }
      }
    })();
    try {
      await Promise.race([
        Promise.all([progress.promise, entered.promise]),
        consuming.then(() => {
          throw new Error('Parent ended before useful progress');
        }),
      ]);
      expect(effect).toHaveBeenCalledTimes(1);
      release.resolve();
      await consuming;
      expect(
        chunks
          .filter((chunk) => chunk.type === 'text-delta')
          .map((chunk) => chunk.value)
          .join('')
      ).toBe('PARENT_USEFUL_PROGRESS\n\nPARENT_FINAL_OUTCOME');
      const finishes = chunks.filter((chunk) => chunk.type === 'message-finish');
      expect(finishes).toHaveLength(1);
      expect(finishes[0]?.usage).toMatchObject({ completionTokens: 3, promptTokens: 3 });
      expect(model.prompts).toHaveLength(5);
      const childText = chunks.flatMap((chunk) =>
        chunk.type === 'delegated-conversation-chunk' && chunk.chunk.type === 'text-delta'
          ? [chunk.chunk.value]
          : []
      );
      expect(childText.join('')).toBe('CHILD_FINAL_EVIDENCE');
      expect(effect).toHaveBeenCalledTimes(1);
      // Retention/compaction must not turn an already delivered task into a
      // permanent construction failure or cause its effect to run again.
      await database.query('DELETE FROM mastra_messages WHERE thread_id = $1', [
        runtimeData.memory.threadId,
      ]);
      await expect(
        repairBackgroundResults({
          manager: runtime.backgroundTaskManager,
          memory: backing.memory,
          scope: runtimeData.memory,
        })
      ).resolves.toEqual([]);
      expect(effect).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await consuming;
    }
  } finally {
    release.resolve();
    await runtime.dispose();
    await database.close();
  }
});

it.each([
  { action: 'approve' as const, failDelivery: false, failExecutor: false },
  { action: 'approve' as const, failDelivery: true, failExecutor: false },
  { action: 'decline' as const, failDelivery: false, failExecutor: false },
  { action: 'approve' as const, failDelivery: false, failExecutor: true },
])(
  'preserves pending approval $action, delivery failure=$failDelivery, executor failure=$failExecutor',
  async ({ action, failDelivery, failExecutor }) => {
    const { database, backing, scope, runtime, runtimeData, effect, release, discoveryOptions } =
      await createBackgroundFixture(true);
    release.resolve();
    try {
      const iterator = await createStreamIteratorFromRuntime({
        memory: backing.memory,
        messages: [
          {
            id: 'approval-request',
            parts: [{ text: 'Inspect with approval', type: 'text' }],
            role: 'user',
          },
        ],
        runtime,
        runtimeData,
      });
      const chunks: StreamChunk[] = [];
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }
      expect(effect).not.toHaveBeenCalled();
      const decisions = chunks.filter(
        (chunk) =>
          chunk.type === 'delegated-conversation-chunk' &&
          chunk.chunk.type === 'tool-approval-required'
      );
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ chunk: { toolCallId: 'background-read' } });
      const tasks = await runtime.backgroundTaskManager?.listTasks({});
      expect(tasks?.tasks).toHaveLength(1);
      expect(tasks?.tasks[0]).toMatchObject({
        status: 'suspended',
        toolCallId: 'background-child',
      });
      expect(
        chunks.filter(
          (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'subagent.finished'
        )
      ).toEqual([]);
      const { delegatedSuspensionDiscovery: _resolver, ...unownedDiscovery } = discoveryOptions;
      await expect(listSuspendedMastraRuns(scope, unownedDiscovery)).rejects.toThrow(
        'Background decision discovery requires an authorized child resolver'
      );
      await expect(
        listSuspendedMastraRuns(scope, {
          ...discoveryOptions,
          delegatedSuspensionDiscovery: async () => undefined,
        })
      ).rejects.toThrow('Background decision has no authorized child address');
      const rediscovered = await listSuspendedMastraRuns(scope, discoveryOptions);
      expect(rediscovered.approvals).toHaveLength(1);
      expect(rediscovered.approvals[0]).toMatchObject({
        delegation: { toolCallId: 'background-read' },
        toolCallId: 'background-child',
      });
      const approval = rediscovered.approvals[0];
      if (!approval) {
        throw new Error('Missing rediscovered approval');
      }
      const resumedRuntime = await createMastraAgentRuntime(discoveryOptions);
      const executorFailure = new Error('Controlled native child executor failure');
      const nativeTools = resumedRuntime.agent.getToolsForExecution.bind(resumedRuntime.agent);
      const executorSpy = vi
        .spyOn(resumedRuntime.agent, 'getToolsForExecution')
        .mockImplementation(async (options) => {
          const tools = await nativeTools(options);
          if (!failExecutor) {
            return tools;
          }
          const child = tools['agent-explore'];
          if (!child) {
            throw new Error('Missing native delegated executor');
          }
          return {
            ...tools,
            'agent-explore': {
              ...child,
              execute: async () => {
                throw executorFailure;
              },
            },
          };
        });
      const originalSave = backing.memory.saveMessages.bind(backing.memory);
      const deliveryFailure = new Error('Controlled parent outcome write failure');
      const saveSpy = vi.spyOn(backing.memory, 'saveMessages').mockImplementation(async (input) => {
        if (
          failDelivery &&
          input.messages.some(
            (message) =>
              message.threadId === scope.threadId &&
              JSON.stringify(message.content).includes('CHILD_FINAL_EVIDENCE')
          )
        ) {
          throw deliveryFailure;
        }
        return originalSave(input);
      });
      try {
        const resumed = await createToolApprovalIteratorFromRuntime({
          action: {
            action,
            runId: approval.runId,
            toolCallId: approval.toolCallId,
            ...(approval.delegation ? { delegation: approval.delegation } : {}),
          },
          memory: backing.memory,
          runtime: resumedRuntime,
          runtimeData,
        });
        const resumedChunks: StreamChunk[] = [];
        const consume = async () => {
          for await (const chunk of resumed) {
            resumedChunks.push(chunk);
          }
        };
        if (failDelivery) {
          await expect(consume()).rejects.toThrow(deliveryFailure.message);
          expect(effect).toHaveBeenCalledTimes(1);
          const stored = await resumedRuntime.backgroundTaskManager?.listTasks({});
          expect(stored?.tasks[0]).toMatchObject({ status: 'completed' });
          expect(resumedChunks.filter((chunk) => chunk.type === 'text-delta')).toEqual([]);
          saveSpy.mockRestore();
          const recoveredRuntime = await createMastraAgentRuntime(discoveryOptions);
          try {
            const recovered = await createStreamIteratorFromRuntime({
              memory: backing.memory,
              messages: [],
              runtime: recoveredRuntime,
              runtimeData,
            });
            const recoveredText: string[] = [];
            for await (const chunk of recovered) {
              if (chunk.type === 'text-delta') {
                recoveredText.push(chunk.value);
              }
            }
            expect(recoveredText.join('')).toContain('PARENT_FINAL_OUTCOME');
            expect(effect).toHaveBeenCalledTimes(1);
          } finally {
            await recoveredRuntime.dispose();
          }
          return;
        }
        await consume();
        if (failExecutor) {
          expect(effect).not.toHaveBeenCalled();
          const stored = await resumedRuntime.backgroundTaskManager?.listTasks({});
          expect(stored?.tasks[0]).toMatchObject({ status: 'failed' });
          const saved = await backing.memory.recall({
            perPage: false,
            resourceId: scope.resourceId,
            threadId: scope.threadId,
          });
          const parts = saved.messages.flatMap((message) => message.content.parts);
          const invocation = parts.find(
            (part) =>
              part.type === 'tool-invocation' &&
              part.toolInvocation.toolCallId === 'background-child'
          );
          expect(invocation).toMatchObject({
            toolInvocation: { errorText: executorFailure.message, state: 'output-error' },
          });
          return;
        }
        expect(effect).toHaveBeenCalledTimes(action === 'approve' ? 1 : 0);
        expect(
          resumedChunks
            .flatMap((chunk) =>
              chunk.type === 'delegated-conversation-chunk' && chunk.chunk.type === 'text-delta'
                ? [chunk.chunk.value]
                : []
            )
            .join('')
        ).toBe('CHILD_FINAL_EVIDENCE');
        expect(
          resumedChunks
            .filter((chunk) => chunk.type === 'text-delta')
            .map((chunk) => chunk.value)
            .join('')
        ).toContain('PARENT_FINAL_OUTCOME');
        expect((await listSuspendedMastraRuns(scope, discoveryOptions)).approvals).toEqual([]);
      } finally {
        executorSpy.mockRestore();
        saveSpy.mockRestore();
        await resumedRuntime.dispose();
      }
    } finally {
      await runtime.dispose();
      await database.close();
    }
  }
);

it('reports native idle expiry while a child still owns unfinished work', async () => {
  const { database, backing, runtime, runtimeData, release, effect } =
    await createBackgroundFixture();
  const nativeStream = runtime.agent.stream.bind(runtime.agent);
  const streamSpy = vi
    .spyOn(runtime.agent, 'stream')
    .mockImplementation(
      async (
        messages: Parameters<typeof nativeStream>[0],
        options?: AgentExecutionOptionsBase<unknown>
      ) => {
        const result = options
          ? await nativeStream(
              messages,
              options.untilIdle ? { ...options, untilIdle: { maxIdleMs: 1 } } : options
            )
          : await nativeStream(messages);
        if (!options?.untilIdle) {
          return result;
        }
        return new Proxy(result, {
          get(target, property, receiver) {
            if (property !== 'fullStream') {
              return Reflect.get(target, property, receiver);
            }
            return target.fullStream.pipeThrough(
              new TransformStream({
                flush() {
                  // Observe real native EOF before releasing the controlled child.
                  release.resolve();
                },
              })
            );
          },
        });
      }
    );
  try {
    const iterator = await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [
        { id: 'idle-request', parts: [{ text: 'Read evidence', type: 'text' }], role: 'user' },
      ],
      runtime,
      runtimeData,
    });
    const chunks: StreamChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of iterator) {
          chunks.push(chunk);
        }
      })()
    ).rejects.toThrow('Background stream ended with unfinished child work');
    expect(effect).toHaveBeenCalledTimes(1);
    expect(chunks.filter((chunk) => chunk.type === 'message-finish')).toEqual([]);
  } finally {
    streamSpy.mockRestore();
    release.resolve();
    await runtime.dispose();
    await database.close();
  }
});

it('root Stop aborts and joins the actual background tool without completing its effect', async () => {
  const controller = new AbortController();
  const fixture = await createBackgroundFixture(false, controller.signal);
  const { runtime, runtimeData, backing, database, release, entered, toolSignals } = fixture;
  const manager = runtime.backgroundTaskManager;
  if (!manager) {
    throw new Error('Missing background owner');
  }
  manager.config.globalConcurrency = 1;
  const queuedEffect = vi.fn(async () => ({ written: true }));
  let consuming: Promise<void> | undefined;
  try {
    const iterator = await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [
        { id: 'stop-request', parts: [{ text: 'Read evidence', type: 'text' }], role: 'user' },
      ],
      runtime,
      runtimeData,
    });
    consuming = (async () => {
      for await (const _chunk of iterator) {
        /* drain owned stream */
      }
    })();
    consuming.catch(() => {});
    await entered.promise;
    const active = (await manager.listTasks({ status: 'running' })).tasks[0];
    if (!active) {
      throw new Error('Missing active native task');
    }
    const queued = await manager.enqueue(
      {
        agentId: active.agentId,
        args: {},
        ...(active.resourceId ? { resourceId: active.resourceId } : {}),
        runId: active.runId,
        ...(active.threadId ? { threadId: active.threadId } : {}),
        toolCallId: 'queued-effect',
        toolName: 'queued-write',
      },
      { executor: { execute: queuedEffect } }
    );
    expect(queued.task.status).toBe('pending');
    controller.abort(new Error('Controlled explicit root Stop'));
    await vi.waitFor(() => expect(toolSignals[0]?.aborted).toBe(true));
    await consuming.catch(() => {});
    const stored = await runtime.backgroundTaskManager?.listTasks({});
    expect(stored?.tasks[0]).toMatchObject({ status: 'cancelled' });
    expect(await manager.getTask(queued.task.id)).toMatchObject({ status: 'cancelled' });
    expect(queuedEffect).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await consuming?.catch(() => {});
    await runtime.dispose();
    await database.close();
  }
});

it.each([false, true])(
  'reloads and answers the exact child question with subsequent plan=%s',
  async (thenPlan) => {
    const fixture = await createBackgroundFixture(false, undefined, thenPlan ? 'then-plan' : true);
    const { runtime, runtimeData, backing, database, release, scope, discoveryOptions, effect } =
      fixture;
    release.resolve();
    try {
      const initial = await createStreamIteratorFromRuntime({
        memory: backing.memory,
        messages: [
          {
            id: 'question-request',
            parts: [{ text: 'Ask then read evidence', type: 'text' }],
            role: 'user',
          },
        ],
        runtime,
        runtimeData,
      });
      for await (const _chunk of initial) {
        /* consume native suspension */
      }
      expect(effect).not.toHaveBeenCalled();
      const pending = await listSuspendedMastraRuns(scope, discoveryOptions);
      expect(pending.approvals).toEqual([]);
      expect(pending.suspends).toHaveLength(1);
      const pause = pending.suspends[0];
      if (!pause) {
        throw new Error('Missing child question');
      }
      expect(pause).toMatchObject({
        delegation: { toolCallId: 'background-question' },
        toolName: 'brainstrike.askUser',
      });
      const resumedRuntime = await createMastraAgentRuntime(discoveryOptions);
      try {
        const resumed = await createToolResumeIteratorFromRuntime({
          action: {
            resumeData: { answer: 'Inspect evidence' },
            runId: pause.runId,
            toolCallId: pause.toolCallId,
            ...(pause.delegation ? { delegation: pause.delegation } : {}),
          },
          memory: backing.memory,
          runtime: resumedRuntime,
          runtimeData,
        });
        const chunks: StreamChunk[] = [];
        for await (const chunk of resumed) {
          chunks.push(chunk);
        }
        if (thenPlan) {
          expect(effect).not.toHaveBeenCalled();
          expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toEqual([]);
          const waiting = await listSuspendedMastraRuns(scope, discoveryOptions);
          expect(waiting.suspends).toHaveLength(1);
          const plan = waiting.suspends[0];
          if (!plan) {
            throw new Error('Missing subsequent plan decision');
          }
          expect(plan).toMatchObject({
            delegation: { toolCallId: 'background-plan' },
            toolName: 'brainstrike.submitPlan',
          });
          const planRuntime = await createMastraAgentRuntime(discoveryOptions);
          try {
            const continuation = await createToolResumeIteratorFromRuntime({
              action: {
                resumeData: { action: 'approved' },
                runId: plan.runId,
                toolCallId: plan.toolCallId,
                ...(plan.delegation ? { delegation: plan.delegation } : {}),
              },
              memory: backing.memory,
              runtime: planRuntime,
              runtimeData,
            });
            for await (const chunk of continuation) {
              chunks.push(chunk);
            }
          } finally {
            await planRuntime.dispose();
          }
        }
        expect(effect).toHaveBeenCalledTimes(1);
        expect(
          chunks
            .filter((chunk) => chunk.type === 'text-delta')
            .map((chunk) => chunk.value)
            .join('')
        ).toContain('PARENT_FINAL_OUTCOME');
        expect((await listSuspendedMastraRuns(scope, discoveryOptions)).suspends).toEqual([]);
        const saved = await backing.memory.recall({
          perPage: false,
          resourceId: scope.resourceId,
          threadId: scope.threadId,
        });
        for (const message of saved.messages) {
          expect(message.content.metadata?.['suspendedTools'] ?? {}).not.toHaveProperty(
            'background-child'
          );
        }
      } finally {
        await resumedRuntime.dispose();
      }
    } finally {
      await runtime.dispose();
      await database.close();
    }
  }
);

it('construction and background cleanup failures both survive the production stream entry point', async () => {
  const fixture = await createBackgroundFixture();
  const primary = new Error('Controlled provider initialization failure');
  const cleanup = new Error('Controlled background cancellation persistence failure');
  const manager = fixture.runtime.backgroundTaskManager;
  if (!manager) {
    throw new Error('Missing native background manager');
  }
  const stop = vi.spyOn(manager, 'shutdown').mockRejectedValue(cleanup);
  const stream = vi.spyOn(fixture.runtime.agent, 'stream').mockRejectedValue(primary);
  try {
    await expect(
      createStreamIteratorFromRuntime({
        memory: fixture.backing.memory,
        messages: [],
        runtime: fixture.runtime,
        runtimeData: fixture.runtimeData,
      })
    ).rejects.toMatchObject({ cause: { errors: [{ errors: [primary, cleanup] }, cleanup] } });
  } finally {
    stop.mockRestore();
    stream.mockRestore();
    fixture.release.resolve();
    await fixture.runtime.dispose();
    await fixture.database.close();
  }
});
