import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { ChildInputNotDeliveredError } from '@brainstrike/assistant-contract';
import { BACKGROUND_TASK_WORKFLOW_ID } from '@mastra/core/background-tasks';
import { expect, it, vi } from 'vitest';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import {
  createStreamIteratorFromRuntime,
  createToolApprovalIteratorFromRuntime,
  createToolResumeIteratorFromRuntime,
} from '../mastra/attempt-legs';
import { repairBackgroundResults } from '../mastra/background-results';
import { listSuspendedMastraRuns } from '../mastra/suspended-run-discovery';
import type { StreamChunk } from '../types';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

it.each([false, true])(
  'preserves definitive discard and its cleanup outcome (cleanup fails=%s)',
  async (cleanupFails) => {
    const fixture = await createBackgroundFixture();
    const { backing, runtime, runtimeData, entered, release, database, model } = fixture;
    const cleanupFailure = new Error('Injected child signal cleanup failure');
    const store = await backing.storage.getStore('memory');
    if (!store) {
      throw new Error('Missing native memory');
    }
    const remove = store.deleteMessages.bind(store);
    const deleteMessages = vi.spyOn(store, 'deleteMessages').mockImplementation((ids) => {
      if (cleanupFails && ids.some((id) => id.startsWith('child-input:'))) {
        return Promise.reject(cleanupFailure);
      }
      return remove(ids);
    });
    const saved = Promise.withResolvers<void>();
    const continueDelivery = Promise.withResolvers<void>();
    let consuming: Promise<void> | undefined;
    let sending: Promise<void> | undefined;
    const save = backing.memory.saveMessages.bind(backing.memory);
    const persist = vi.spyOn(backing.memory, 'saveMessages').mockImplementation(async (input) => {
      const result = await save(input);
      if (input.messages.some((message) => message.id.startsWith('child-input:'))) {
        saved.resolve();
        await continueDelivery.promise;
      }
      return result;
    });
    try {
      const iterator = await createStreamIteratorFromRuntime({
        memory: backing.memory,
        messages: [{ id: 'task', parts: [{ text: 'Inspect', type: 'text' }], role: 'user' }],
        runtime,
        runtimeData,
      });
      consuming = (async () => {
        for await (const _chunk of iterator) {
          /* Drain native output. */
        }
      })();
      consuming.catch(() => {});
      await entered.promise;
      sending = fixture.followup({ id: 'late-input', text: 'MUST_NOT_RECALL_DISCARDED_INPUT' });
      sending.catch(() => {});
      await saved.promise;
      release.resolve();
      await consuming;
      continueDelivery.resolve();
      if (cleanupFails) {
        await expect(sending).rejects.toMatchObject({
          errors: [expect.any(ChildInputNotDeliveredError), cleanupFailure],
          name: 'AggregateError',
        });
      } else {
        await expect(sending).rejects.toBeInstanceOf(ChildInputNotDeliveredError);
        expect(
          (await database.query("SELECT id FROM mastra_messages WHERE role = 'signal'")).rows
        ).toEqual([]);
      }
      expect(JSON.stringify(model.prompts)).not.toContain('MUST_NOT_RECALL_DISCARDED_INPUT');
    } finally {
      release.resolve();
      continueDelivery.resolve();
      persist.mockRestore();
      deleteMessages.mockRestore();
      await Promise.allSettled([consuming, sending]);
      await runtime.dispose();
      await database.close();
    }
  }
);

it.each(['lookup', 'persist'])(
  'rechecks revoked admission after awaited %s before sending child input',
  async (boundary) => {
    const fixture = await createBackgroundFixture();
    const { backing, runtime, runtimeData, entered, release, database, model } = fixture;
    let consuming: Promise<void> | undefined;
    try {
      const iterator = await createStreamIteratorFromRuntime({
        memory: backing.memory,
        messages: [{ id: 'task', parts: [{ text: 'Inspect', type: 'text' }], role: 'user' }],
        runtime,
        runtimeData,
      });
      consuming = (async () => {
        for await (const _chunk of iterator) {
          /* Drain native output. */
        }
      })();
      consuming.catch(() => {});
      await entered.promise;
      const store = await backing.storage.getStore('memory');
      if (!store) {
        throw new Error('Missing native memory');
      }
      let revoked = false;
      const lookup = store.listMessagesById.bind(store);
      const read = vi.spyOn(store, 'listMessagesById').mockImplementation(async (input) => {
        const result = await lookup(input);
        if (boundary === 'lookup' && input.messageIds.some((id) => id.startsWith('child-input:'))) {
          revoked = true;
        }
        return result;
      });
      const save = backing.memory.saveMessages.bind(backing.memory);
      const persisted = vi
        .spyOn(backing.memory, 'saveMessages')
        .mockImplementation(async (input) => {
          const result = await save(input);
          if (
            boundary === 'persist' &&
            input.messages.some((message) => message.id.startsWith('child-input:'))
          ) {
            revoked = true;
          }
          return result;
        });
      try {
        await expect(
          fixture.followup({ id: 'revoked', text: 'INPUT_AFTER_STOP' }, async () => {
            if (revoked) {
              throw new Error('Durable admission revoked');
            }
          })
        ).rejects.toMatchObject({
          cause: expect.objectContaining({ message: 'Durable admission revoked' }),
          name: 'ChildInputNotDeliveredError',
        });
      } finally {
        read.mockRestore();
        persisted.mockRestore();
      }
      expect(
        (await database.query("SELECT id FROM mastra_messages WHERE role = 'signal'")).rows
      ).toEqual([]);
      release.resolve();
      await consuming;
      expect(JSON.stringify(model.prompts)).not.toContain('INPUT_AFTER_STOP');
    } finally {
      release.resolve();
      await Promise.allSettled([consuming]);
      await runtime.dispose();
      await database.close();
    }
  }
);

it('never replays an ambiguous child input after receipt persistence fails and permits a later explicit request', async () => {
  const fixture = await createBackgroundFixture();
  const { backing, runtime, runtimeData, entered, release, database, model } = fixture;
  let consuming: Promise<void> | undefined;
  try {
    const iterator = await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [
        {
          id: 'interrupted-input-task',
          parts: [{ text: 'Read evidence', type: 'text' }],
          role: 'user',
        },
      ],
      runtime,
      runtimeData,
    });
    consuming = (async () => {
      for await (const _chunk of iterator) {
        /* Drain the actual production owner. */
      }
    })();
    // Observe rejection before releasing the held production tool.
    consuming.catch(() => {});
    await entered.promise;
    const store = await backing.storage.getStore('memory');
    if (!store) {
      throw new Error('Missing native memory store');
    }
    const update = vi
      .spyOn(store, 'updateMessages')
      .mockRejectedValueOnce(new Error('Receipt persistence unavailable'));
    const input = { id: 'ambiguous', text: 'AMBIGUOUS_INPUT_ONCE' };
    try {
      await expect(fixture.followup(input)).rejects.toThrow('Receipt persistence unavailable');
    } finally {
      update.mockRestore();
    }
    await expect(fixture.followup(input)).rejects.toThrow('interrupted');
    await fixture.followup({ id: 'later-explicit', text: 'LATER_EXPLICIT_INPUT' });
    release.resolve();
    await consuming;
    const childPrompt = model.prompts.findLast(
      (prompt) => !prompt.tools?.some((tool) => tool.name === 'agent-explore')
    );
    expect(JSON.stringify(childPrompt).match(/AMBIGUOUS_INPUT_ONCE/g)).toHaveLength(1);
    expect(JSON.stringify(childPrompt).match(/LATER_EXPLICIT_INPUT/g)).toHaveLength(1);
  } finally {
    release.resolve();
    await Promise.allSettled([consuming]);
    await runtime.dispose();
    await database.close();
  }
});

it.each([true, false])(
  'delivers a follow-up once through the production child owner while preserving the parent outcome (background=%s)',
  async (background) => {
    const fixture = await createBackgroundFixture(false, undefined, false, background);
    const { backing, runtime, runtimeData, entered, release, database, model, effect } = fixture;
    let consuming: Promise<void> | undefined;
    try {
      const iterator = await createStreamIteratorFromRuntime({
        memory: backing.memory,
        messages: [
          { id: 'followup-task', parts: [{ text: 'Read evidence', type: 'text' }], role: 'user' },
        ],
        runtime,
        runtimeData,
      });
      const chunks: StreamChunk[] = [];
      consuming = (async () => {
        for await (const chunk of iterator) {
          chunks.push(chunk);
        }
      })();
      consuming.catch(() => {});
      await entered.promise;
      await fixture.followup({ id: 'human-update', text: 'FOLLOWUP_PRODUCTION_1723' });
      await fixture.followup({ id: 'human-update', text: 'FOLLOWUP_PRODUCTION_1723' });
      const persisted = await database.query(
        `SELECT content FROM mastra_messages WHERE role = 'signal'`
      );
      expect(persisted.rows).toHaveLength(1);
      expect(JSON.stringify(persisted.rows)).toContain('FOLLOWUP_PRODUCTION_1723');
      expect(JSON.stringify(persisted.rows)).toContain('delivered');
      await expect(
        fixture.followup({ id: 'human-update', text: 'CHANGED_CONTENT' })
      ).rejects.toThrow('different content');
      release.resolve();
      await consuming;
      const childPrompt = model.prompts.findLast(
        (prompt) => !prompt.tools?.some((tool) => tool.name === 'agent-explore')
      );
      expect(JSON.stringify(childPrompt).match(/FOLLOWUP_PRODUCTION_1723/g)).toHaveLength(1);
      expect(JSON.stringify(chunks)).toContain('PARENT_FINAL_OUTCOME');
      const inputs = chunks.filter(
        (chunk) =>
          chunk.type === 'delegated-conversation-chunk' && chunk.chunk.type === 'child-user-message'
      );
      expect(inputs).toHaveLength(1);
      expect(JSON.stringify(inputs)).toContain('FOLLOWUP_PRODUCTION_1723');
      expect(effect).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([consuming]);
      await runtime.dispose();
      await database.close();
    }
  }
);

it('selected Stop joins cleanup even after the native task becomes completed', async () => {
  const fixture = await createBackgroundFixture();
  const { backing, runtime, runtimeData, entered, release, database } = fixture;
  const workflows = await backing.storage.getStore('workflows');
  if (!workflows) {
    throw new Error('Missing native workflows');
  }
  const deleting = Promise.withResolvers<void>();
  const releaseDeletion = Promise.withResolvers<void>();
  const remove = workflows.deleteWorkflowRunById.bind(workflows);
  const deletion = vi
    .spyOn(workflows, 'deleteWorkflowRunById')
    .mockImplementation(async (input) => {
      if (input.workflowName !== BACKGROUND_TASK_WORKFLOW_ID) {
        return remove(input);
      }
      deleting.resolve();
      await releaseDeletion.promise;
      await remove(input);
    });
  let consuming: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  try {
    const iterator = await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [
        { id: 'cleanup-request', parts: [{ text: 'Read evidence', type: 'text' }], role: 'user' },
      ],
      runtime,
      runtimeData,
    });
    consuming = (async () => {
      for await (const _chunk of iterator) {
        /* drain */
      }
    })();
    consuming.catch(() => {});
    await entered.promise;
    release.resolve();
    await deleting.promise;
    const task = (await runtime.backgroundTaskManager?.listTasks({ status: 'completed' }))
      ?.tasks[0];
    if (!task) {
      throw new Error('Expected completed task with held cleanup');
    }
    let acknowledged = false;
    stopping = fixture
      .cancel([{ parentRuntimeRunId: task.runId, parentToolCallId: task.toolCallId }])
      .then(() => {
        acknowledged = true;
      });
    stopping.catch(() => {});
    await nextEventLoopTurn();
    expect(acknowledged, 'Production Stop must join terminal native cleanup').toBe(false);
    releaseDeletion.resolve();
    await stopping;
    await consuming;
    expect(await runtime.backgroundTaskManager?.getTask(task.id)).toMatchObject({
      status: 'completed',
    });
  } finally {
    release.resolve();
    releaseDeletion.resolve();
    await Promise.allSettled([stopping, consuming]);
    deletion.mockRestore();
    await runtime.dispose();
    await database.close();
  }
});

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
        const finishedTasks = (await resumedRuntime.backgroundTaskManager?.listTasks({}))?.tasks;
        expect(finishedTasks, JSON.stringify(finishedTasks)).toMatchObject([
          { status: 'completed' },
        ]);
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
  const fixture = await createBackgroundFixture();
  const { database, backing, runtimeData, release, effect, discoveryOptions } = fixture;
  // The host loop's silence budget, shortened so the running child (held on
  // `release`) expires it; the expiry must surface, never a quiet finish.
  const runtime = await createMastraAgentRuntime({ ...discoveryOptions, backgroundIdleMs: 1 });
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
    release.resolve();
    await runtime.dispose();
    await fixture.runtime.dispose();
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
