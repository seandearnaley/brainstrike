import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { PGlite } from '@electric-sql/pglite';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import type { ChunkType } from '@mastra/core/stream';
import { createTool, ToolStream } from '@mastra/core/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createDelegatedConversationBinding,
  type DelegatedCancellationTarget,
} from '../mastra/delegated-conversation-binding';
import { createPgliteMastraMemory, type PgliteDatabase } from '../pglite-mastra-memory';
import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
  toolThenAnswer,
} from '../test-fixtures/scripted-agent-model';

async function collect(stream: AsyncIterable<ChunkType>): Promise<ChunkType[]> {
  const chunks: ChunkType[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

/** How a `data-child-probe` part reached the stream: raw on a turn, or as a task's output. */
function probeDelivery(chunk: ChunkType): 'task' | 'turn' | undefined {
  const part: Record<string, unknown> = { ...chunk };
  if (part['type'] === 'data-child-probe') {
    return 'turn';
  }
  const payload = part['payload'];
  if (part['type'] !== 'background-task-output' || typeof payload !== 'object' || !payload) {
    return;
  }
  const output: unknown = Reflect.get(payload, 'payload');
  return typeof output === 'object' && output && Reflect.get(output, 'type') === 'data-child-probe'
    ? 'task'
    : undefined;
}

describe('native background delegation (BST-1723)', () => {
  let database: PGlite;
  let backing: Awaited<ReturnType<typeof createPgliteMastraMemory>>;
  const hosts = new Set<Mastra>();

  // Adapt readonly seam parameters to PGlite's mutable parameter-array type.
  // Transactions still execute on the real driver and store, without a cast.
  function memoryDatabase(): PgliteDatabase {
    return {
      exec: (query) => database.exec(query),
      query: (query, values) => database.query(query, values ? [...values] : undefined),
      transaction: (operation) =>
        database.transaction((tx) =>
          operation({
            exec: (query) => tx.exec(query),
            query: (query, values) => tx.query(query, values ? [...values] : undefined),
          })
        ),
    };
  }

  async function shutdownHost(host: Mastra): Promise<void> {
    hosts.delete(host);
    await host.shutdown();
  }

  beforeEach(async () => {
    database = await createEnginePglite();
    backing = await createPgliteMastraMemory({
      database: memoryDatabase(),
      memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
    });
  });

  afterEach(async () => {
    const results = await Promise.allSettled([...hosts].map(shutdownHost));
    await database.close();
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Mastra fixture shutdown failed');
    }
  });

  it('streams useful parent output while a native background child works and delivers its result once', async () => {
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const progress = Promise.withResolvers<void>();
    const effect = vi.fn(async () => {
      started.resolve();
      await release.promise;
      return { completed: 'BACKGROUND_EFFECT_ONCE' };
    });
    const childModel = toolThenAnswer('inspect', 'background-child-effect', {});
    const child = new Agent({
      defaultOptions: { maxSteps: 4 },
      id: 'worker',
      instructions: 'Inspect the workspace.',
      memory: backing.memory,
      model: childModel.model,
      name: 'Worker',
      tools: {
        inspect: createTool({
          description: 'Inspect',
          execute: effect,
          id: 'inspect',
          inputSchema: z.object({}),
        }),
      },
    });
    const parentModel = scriptedAgentModel((options) => {
      if (!hasToolResult(options, 'agent-worker')) {
        return toolCallParts('agent-worker', 'background-delegation', {
          prompt: 'Inspect the workspace',
        });
      }
      return textParts(
        JSON.stringify(options.prompt).includes('background-child-effect answered')
          ? 'Parent received child result'
          : 'Parent continues useful work'
      );
    });
    const parent = new Agent({
      agents: { worker: child },
      backgroundTasks: { tools: { worker: { enabled: true } }, waitTimeoutMs: 0 },
      defaultOptions: { maxSteps: 4 },
      id: 'background-parent',
      instructions: 'Delegate, continue useful work, then report the child result.',
      memory: backing.memory,
      model: parentModel.model,
      name: 'Parent',
    });
    const host = new Mastra({
      agents: { parent },
      backgroundTasks: { defaultRetries: { maxRetries: 0 }, enabled: true, waitTimeoutMs: 0 },
      logger: false,
      storage: backing.storage,
    });
    hosts.add(host);
    const output = await parent.stream('Inspect', {
      memory: { resource: 'owner', thread: 'background-root' },
      untilIdle: true,
    });
    const chunks: ChunkType[] = [];
    const consuming = (async () => {
      for await (const chunk of output.fullStream) {
        chunks.push(chunk);
        if (
          chunk.type === 'text-delta' &&
          chunk.payload.text.includes('Parent continues useful work')
        ) {
          progress.resolve();
        }
      }
    })();
    try {
      await Promise.race([
        Promise.all([started.promise, progress.promise]),
        consuming.then(() => {
          throw new Error(
            `Native background stream ended before progress: ${JSON.stringify(chunks)}`
          );
        }),
      ]);
      expect(effect).toHaveBeenCalledTimes(1);
      expect(parentModel.prompts).toHaveLength(2);
      release.resolve();
      await consuming;
      expect(parentModel.prompts).toHaveLength(3);
      expect(
        chunks.some(
          (chunk) =>
            chunk.type === 'text-delta' &&
            chunk.payload.text.includes('Parent received child result')
        )
      ).toBe(true);
      const tasks = await host.backgroundTaskManager?.listTasks({ threadId: 'background-root' });
      expect(tasks?.tasks).toHaveLength(1);
      expect(tasks?.tasks[0]).toMatchObject({
        maxRetries: 0,
        result: { text: 'background-child-effect answered' },
        status: 'completed',
      });
      expect(effect).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await consuming;
    }
  });

  it("delivers a background child's raw data part once while the dispatching parent turn is still open", async () => {
    // Mastra's background executor hands the tool one writer that publishes
    // each chunk as the task's output (`background-task-output`) AND writes it
    // through the dispatching step's own writer. A subagent forwards its
    // child's `data-*` parts with `writer.custom()`, which carries no call
    // identity, so while the parent turn was open Mastra's own untilIdle
    // stream delivered every such part twice (@mastra/core 1.64.0, unchanged
    // in 1.67.0; live GLM run 19, 2026-09-15).
    const written = Promise.withResolvers<void>();
    let probeWrites = 0;
    const child = new Agent({
      defaultOptions: { maxSteps: 4 },
      id: 'worker',
      instructions: 'Inspect the workspace.',
      memory: backing.memory,
      model: toolThenAnswer('inspect', 'background-child-probe', {}).model,
      name: 'Worker',
      tools: {
        inspect: createTool({
          description: 'Inspect',
          execute: async (_input, context) => {
            const writer: unknown = context['writer'];
            if (!(writer instanceof ToolStream)) {
              throw new Error('Native child tool omitted its stream writer.');
            }
            await writer.custom({ data: { probe: 'CHILD_PROBE' }, type: 'data-child-probe' });
            probeWrites += 1;
            written.resolve();
            return { completed: true };
          },
          id: 'inspect',
          inputSchema: z.object({}),
        }),
      },
    });
    const parentModel = scriptedAgentModel((options) =>
      hasToolResult(options, 'agent-worker')
        ? textParts('Parent continues useful work')
        : toolCallParts('agent-worker', 'background-delegation', {
            prompt: 'Inspect the workspace',
          })
    );
    const scripted = parentModel.model.doStream;
    parentModel.model.doStream = async (options) => {
      // The dispatching turn stays open until the child has written its part.
      if (hasToolResult(options, 'agent-worker')) {
        await written.promise;
      }
      return scripted(options);
    };
    const parent = new Agent({
      agents: { worker: child },
      backgroundTasks: { tools: { worker: { enabled: true } }, waitTimeoutMs: 0 },
      defaultOptions: { maxSteps: 4 },
      id: 'background-parent',
      instructions: 'Delegate, continue useful work, then report the child result.',
      memory: backing.memory,
      model: parentModel.model,
      name: 'Parent',
    });
    const host = new Mastra({
      agents: { parent },
      backgroundTasks: { defaultRetries: { maxRetries: 0 }, enabled: true, waitTimeoutMs: 0 },
      logger: false,
      storage: backing.storage,
    });
    hosts.add(host);
    const output = await parent.stream('Inspect', {
      memory: { resource: 'owner', thread: 'background-root' },
      untilIdle: true,
    });
    const chunks = await collect(output.fullStream);
    const deliveries = chunks.flatMap((chunk) => {
      const delivery = probeDelivery(chunk);
      return delivery ? [delivery] : [];
    });
    // The turn's writer also runs the parent's data-part pipeline, which adds a
    // non-transient part to the parent's own response message.
    const rootRows = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM mastra_messages
        WHERE thread_id = 'background-root' AND content::text LIKE '%data-child-probe%'`
    );
    // One write by the child's tool, so a second delivery is a copy, not a write.
    expect({
      deliveries,
      probeWrites,
      rootProbeRows: rootRows.rows[0]?.count,
    }).toEqual({ deliveries: ['task'], probeWrites: 1, rootProbeRows: 0 });
  });

  it('honors foreground child cancellation without cancelling the parent', async () => {
    const binding = createDelegatedConversationBinding(async () => undefined);
    let target: DelegatedCancellationTarget | undefined;
    const parentStop = new AbortController();
    let effectSignal: AbortSignal | undefined;
    const childModel = toolThenAnswer('inspect', 'foreground-effect', {});
    const child = new Agent({
      defaultOptions: ({ requestContext }) => ({
        abortSignal: requestContext ? binding.getAbortSignal?.(requestContext) : undefined,
        maxSteps: 4,
      }),
      id: 'foreground-child',
      instructions: 'Inspect once.',
      memory: backing.memory,
      model: childModel.model,
      name: 'Foreground child',
      tools: {
        inspect: createTool({
          description: 'Inspect once and stop the selected child.',
          execute: async (_input, context) => {
            const signal: unknown = context?.['abortSignal'];
            if (!(signal instanceof AbortSignal)) {
              throw new Error('Foreground tool requires its native abort signal');
            }
            effectSignal = signal;
            if (!target) {
              throw new Error('Missing selected invocation');
            }
            binding.abortInvocations?.([target]);
            return { inspected: true };
          },
          id: 'inspect',
          inputSchema: z.object({}),
        }),
      },
    });
    const parent = new Agent({
      agents: { child },
      defaultOptions: {
        delegation: {
          hookErrorStrategy: 'throw',
          onDelegationStart: (context) => {
            binding.prepare(context, {}, parentStop.signal);
            target = { parentRuntimeRunId: context.runId, parentToolCallId: context.toolCallId };
          },
        },
      },
      id: 'foreground-parent',
      instructions: 'Delegate an inspection.',
      memory: backing.memory,
      model: toolThenAnswer('agent-child', 'foreground-call', { prompt: 'Inspect' }).model,
      name: 'Foreground parent',
    });
    const host = new Mastra({ agents: { parent }, logger: false, storage: backing.storage });
    hosts.add(host);
    const output = await parent.stream('Inspect', {
      abortSignal: parentStop.signal,
      maxSteps: 4,
      memory: { resource: 'owner', thread: 'foreground-root' },
    });
    await collect(output.fullStream);
    expect(effectSignal?.aborted).toBe(true);
    expect(childModel.prompts).toHaveLength(1);
    expect(parentStop.signal.aborted).toBe(false);
  });

  it.each([false, true])(
    'joins selected child cleanup or reports its deadline without aborting a sibling (%s)',
    async (expireCleanup) => {
      const host = new Mastra({
        backgroundTasks: { enabled: true },
        logger: false,
        storage: backing.storage,
      });
      hosts.add(host);
      const manager = host.backgroundTaskManager;
      if (!manager) {
        throw new Error('Missing native background manager');
      }
      await manager.init(host.pubsub);
      const childStarted = Promise.withResolvers<void>();
      const childAborted = Promise.withResolvers<void>();
      const releaseChild = Promise.withResolvers<void>();
      const siblingStarted = Promise.withResolvers<void>();
      const releaseSibling = Promise.withResolvers<void>();
      let siblingSignal: AbortSignal | undefined;
      let childCleaned = false;
      let cancellation: Promise<void> | undefined;
      try {
        const { task: child } = await manager.enqueue(
          {
            agentId: 'selective-owner',
            args: {},
            runId: 'selective-run',
            toolCallId: 'selected-child',
            toolName: 'inspect',
          },
          {
            executor: {
              execute: async (_args, options) => {
                options?.abortSignal?.addEventListener(
                  'abort',
                  () => {
                    if (expireCleanup) {
                      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
                    }
                    childAborted.resolve();
                  },
                  { once: true }
                );
                childStarted.resolve();
                await releaseChild.promise;
                childCleaned = true;
                return { cleaned: true };
              },
            },
          }
        );
        const { task: sibling } = await manager.enqueue(
          {
            agentId: 'selective-owner',
            args: {},
            runId: 'selective-run',
            toolCallId: 'sibling-child',
            toolName: 'inspect',
          },
          {
            executor: {
              execute: async (_args, options) => {
                siblingSignal = options?.abortSignal;
                siblingStarted.resolve();
                await releaseSibling.promise;
                return { inspected: true };
              },
            },
          }
        );
        await Promise.all([childStarted.promise, siblingStarted.promise]);
        let acknowledged = false;
        cancellation = manager.cancel(child.id).then(() => {
          acknowledged = true;
        });
        const deadlineRejected = expireCleanup
          ? expect(cancellation).rejects.toThrow(/cancellation cleanup exceeded the deadline/)
          : undefined;
        await childAborted.promise;
        await nextEventLoopTurn();
        expect(siblingSignal?.aborted).toBe(false);
        expect((await manager.getTask(sibling.id))?.status).toBe('running');
        expect(childCleaned).toBe(false);
        expect(
          acknowledged,
          'Stop must not acknowledge while the selected executor owns work'
        ).toBe(false);
        if (expireCleanup) {
          await deadlineRejected;
          expect(childCleaned).toBe(false);
        }
        releaseChild.resolve();
        if (!expireCleanup) {
          await cancellation;
          expect(childCleaned).toBe(true);
        }
        expect((await manager.getTask(child.id))?.status).toBe('cancelled');
        expect(siblingSignal?.aborted).toBe(false);
      } finally {
        releaseChild.resolve();
        releaseSibling.resolve();
        await Promise.allSettled([cancellation]);
        vi.restoreAllMocks();
      }
    }
  );

  it.each([false, true])(
    'joins selected workflow deletion and reports cleanup errors (%s)',
    async (failDeletion) => {
      const host = new Mastra({
        backgroundTasks: { enabled: true },
        logger: false,
        storage: backing.storage,
      });
      hosts.add(host);
      const manager = host.backgroundTaskManager;
      if (!manager) {
        throw new Error('Missing native background manager');
      }
      await manager.init(host.pubsub);
      const deleting = Promise.withResolvers<void>();
      const releaseDeletion = Promise.withResolvers<void>();
      const cleanupFailure = new Error('Controlled selected workflow deletion failure');
      const remove = backing.workflows.deleteWorkflowRunById.bind(backing.workflows);
      vi.spyOn(backing.workflows, 'deleteWorkflowRunById').mockImplementation(async (input) => {
        deleting.resolve();
        await releaseDeletion.promise;
        if (failDeletion) {
          throw cleanupFailure;
        }
        await remove(input);
      });
      let cancellation: Promise<void> | undefined;
      try {
        const { task } = await manager.enqueue(
          {
            agentId: 'cleanup-owner',
            args: {},
            runId: 'cleanup-run',
            toolCallId: 'selected-cleanup',
            toolName: 'inspect',
          },
          { executor: { execute: async () => ({ inspected: true }) } }
        );
        await deleting.promise;
        let acknowledged = false;
        cancellation = manager.cancel(task.id).then(() => {
          acknowledged = true;
        });
        const outcome = cancellation.then(
          () => undefined,
          (error: unknown) => error
        );
        await nextEventLoopTurn();
        expect(acknowledged, 'Stop must own the selected workflow deletion').toBe(false);
        releaseDeletion.resolve();
        if (failDeletion) {
          expect(await outcome).toBe(cleanupFailure);
          await expect(manager.cancel(task.id)).rejects.toThrow(cleanupFailure);
        } else {
          await cancellation;
        }
      } finally {
        releaseDeletion.resolve();
        await Promise.allSettled([cancellation]);
        vi.restoreAllMocks();
        if (failDeletion) {
          await expect(shutdownHost(host)).rejects.toMatchObject({ errors: [cleanupFailure] });
        }
      }
    }
  );

  it('reports a held workflow cleanup at the existing shutdown deadline without hanging the owner', async () => {
    const host = new Mastra({
      backgroundTasks: { enabled: true },
      logger: false,
      storage: backing.storage,
    });
    const manager = host.backgroundTaskManager;
    if (!manager) {
      throw new Error('Missing native background manager');
    }
    await manager.init(host.pubsub);
    const deleting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const deleted = Promise.withResolvers<void>();
    const remove = backing.workflows.deleteWorkflowRunById.bind(backing.workflows);
    vi.spyOn(backing.workflows, 'deleteWorkflowRunById').mockImplementation(async (input) => {
      deleting.resolve();
      await release.promise;
      await remove(input);
      deleted.resolve();
    });
    let shutdown: Promise<void> | undefined;
    try {
      await manager.enqueue(
        {
          agentId: 'deadline-owner',
          args: {},
          runId: 'deadline-run',
          toolCallId: 'deadline-call',
          toolName: 'inspect',
        },
        { executor: { execute: async () => ({ inspected: true }) } }
      );
      await deleting.promise;
      const flushing = Promise.withResolvers<void>();
      const flush = host.pubsub.flush.bind(host.pubsub);
      const future = Date.now() + 60_000;
      vi.spyOn(host.pubsub, 'flush').mockImplementationOnce(async () => {
        await flush();
        vi.spyOn(Date, 'now').mockReturnValue(future);
        flushing.resolve();
      });
      let settled = false;
      shutdown = manager.shutdown();
      void shutdown.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await flushing.promise;
      await nextEventLoopTurn();
      expect(
        settled,
        'The expired native shutdown deadline must release teardown with an error'
      ).toBe(true);
      await expect(shutdown).rejects.toThrow(/cleanup|deadline/i);
    } finally {
      release.resolve();
      await deleted.promise;
      await shutdown?.catch(() => undefined);
      vi.restoreAllMocks();
      await host.shutdown().catch(() => undefined);
    }
  });

  it.each([false, true])(
    'joins native workflow deletion even when pubsub flush fails (%s)',
    async (failFlush) => {
      const host = new Mastra({
        backgroundTasks: { defaultRetries: { maxRetries: 0 }, enabled: true },
        logger: false,
        storage: backing.storage,
      });
      hosts.add(host);
      const manager = host.backgroundTaskManager;
      if (!manager) {
        throw new Error('Missing native background manager');
      }
      await manager.init(host.pubsub);
      const deleting = Promise.withResolvers<void>();
      const releaseDeletion = Promise.withResolvers<void>();
      const remove = backing.workflows.deleteWorkflowRunById.bind(backing.workflows);
      const deletion = vi
        .spyOn(backing.workflows, 'deleteWorkflowRunById')
        .mockImplementation(async (input) => {
          deleting.resolve();
          await releaseDeletion.promise;
          await remove(input);
        });
      const flushFailure = new Error('Controlled pubsub flush failure');
      let shutdown: Promise<void> | undefined;
      try {
        await manager.enqueue(
          {
            agentId: 'cleanup-owner',
            args: {},
            runId: 'cleanup-run',
            toolCallId: 'cleanup-call',
            toolName: 'inspect',
          },
          { executor: { execute: async () => ({ inspected: true }) } }
        );
        await deleting.promise;
        const flushing = Promise.withResolvers<void>();
        const flush = host.pubsub.flush.bind(host.pubsub);
        vi.spyOn(host.pubsub, 'flush').mockImplementationOnce(async () => {
          flushing.resolve();
          if (failFlush) {
            throw flushFailure;
          }
          await flush();
        });
        let settled = false;
        shutdown = manager.shutdown();
        void shutdown.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          }
        );
        await flushing.promise;
        await nextEventLoopTurn();
        expect(settled, 'Shutdown must still own the held native workflow write').toBe(false);
        releaseDeletion.resolve();
        if (failFlush) {
          await expect(shutdown).rejects.toMatchObject({ errors: [flushFailure] });
        } else {
          await shutdown;
        }
        expect(deletion).toHaveBeenCalledTimes(1);
      } finally {
        releaseDeletion.resolve();
        await shutdown?.catch(() => undefined);
        vi.restoreAllMocks();
        await shutdownHost(host).catch((error: unknown) => {
          if (!failFlush) {
            throw error;
          }
        });
      }
    }
  );

  it.each([false, true])(
    'keeps a background child approval suspended and resumes its exact task without replay (new host: %s)',
    async (newHost) => {
      const effect = vi.fn(async () => ({ written: 'APPROVED_ONCE' }));
      const childModel = toolThenAnswer('write', 'background-write', {});
      const makeChild = () =>
        new Agent({
          defaultOptions: { maxSteps: 4 },
          id: 'worker',
          instructions: 'Write only after approval.',
          memory: backing.memory,
          model: childModel.model,
          name: 'Worker',
          tools: {
            write: createTool({
              description: 'Write',
              execute: effect,
              id: 'write',
              inputSchema: z.object({}),
              requireApproval: true,
            }),
          },
        });
      const parentModel = toolThenAnswer('agent-worker', 'background-write-delegation', {
        prompt: 'Write',
      });
      const makeParent = () =>
        new Agent({
          agents: { worker: makeChild() },
          backgroundTasks: { tools: { worker: { enabled: true } } },
          defaultOptions: { maxSteps: 4 },
          id: 'parent',
          instructions: 'Delegate write.',
          memory: backing.memory,
          model: parentModel.model,
          name: 'Parent',
        });
      const parent = makeParent();
      const host = new Mastra({
        agents: { parent },
        backgroundTasks: { defaultRetries: { maxRetries: 0 }, enabled: true },
        logger: false,
        storage: backing.storage,
      });
      hosts.add(host);
      const output = await parent.stream('Write', {
        memory: { resource: 'owner', thread: 'background-approval' },
        untilIdle: true,
      });
      const chunks = await collect(output.fullStream);
      expect(effect).not.toHaveBeenCalled();
      const tasks = await host.backgroundTaskManager?.listTasks({
        threadId: 'background-approval',
      });
      expect(tasks?.tasks).toHaveLength(1);
      expect(
        tasks?.tasks[0],
        JSON.stringify(
          chunks.map((chunk) => ({
            payload: 'payload' in chunk ? chunk.payload : null,
            type: chunk.type,
          }))
        )
      ).toMatchObject({ status: 'suspended' });
      const suspension = chunks.find((chunk) => chunk.type === 'background-task-suspended');
      expect(suspension).toBeDefined();
      let manager = host.backgroundTaskManager;
      const task = tasks?.tasks[0];
      if (!(manager && task?.threadId && task.resourceId)) {
        throw new Error('Missing background approval owner');
      }
      if (newHost) {
        await host.shutdown();
        hosts.delete(host);
        const persisted = await database.dumpDataDir();
        await database.close();
        database = await createEnginePglite({ loadDataDir: persisted });
        backing = await createPgliteMastraMemory({
          database: memoryDatabase(),
          memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
        });
        const restoredParent = makeParent();
        const restoredHost = new Mastra({
          agents: { parent: restoredParent },
          backgroundTasks: { defaultRetries: { maxRetries: 0 }, enabled: true },
          logger: false,
          storage: backing.storage,
        });
        hosts.add(restoredHost);
        manager = restoredHost.backgroundTaskManager;
        if (!manager) {
          throw new Error('Missing reconstructed background manager');
        }
        const tools = await restoredParent.getToolsForExecution({
          resourceId: task.resourceId,
          runId: task.runId,
          threadId: task.threadId,
        });
        const execute = tools[task.toolName]?.execute;
        if (!execute) {
          throw new Error('Missing reconstructed native child executor');
        }
        manager.registerTaskContext(task.id, {
          executor: {
            execute: (args, options) =>
              execute(args, {
                messages: [],
                toolCallId: task.toolCallId,
                ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
                ...(options?.resumeData === undefined ? {} : { resumeData: options.resumeData }),
                ...(options?.suspend ? { suspend: options.suspend } : {}),
              }),
          },
        });
      }
      const watching = new AbortController();
      const events = manager.stream({ abortSignal: watching.signal, taskId: task.id });
      const observed = (async () => {
        let running = false;
        for await (const event of events) {
          if (
            event['type'] === 'background-task-running' ||
            event['type'] === 'background-task-resumed'
          ) {
            running = true;
          }
          if (
            running &&
            [
              'background-task-completed',
              'background-task-failed',
              'background-task-suspended',
            ].includes(String(event['type']))
          ) {
            return event;
          }
        }
        throw new Error('Task event stream ended without a resume outcome');
      })();
      await manager.resume(task.id, { approved: true });
      try {
        const event = await observed;
        expect(event['type'], JSON.stringify(event)).toBe('background-task-completed');
        expect(await manager.getTask(task.id)).toMatchObject({
          result: { text: 'background-write answered' },
          status: 'completed',
        });
      } finally {
        watching.abort();
      }

      expect(effect).toHaveBeenCalledTimes(1);
      await expect(manager.resume(task.id, { approved: true })).rejects.toThrow();
      expect(effect).toHaveBeenCalledTimes(1);
    }
  );
});
