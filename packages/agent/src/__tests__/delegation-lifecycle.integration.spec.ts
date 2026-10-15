import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { PGlite } from '@electric-sql/pglite';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import type { ChunkType } from '@mastra/core/stream';
import { createTool, ToolStream } from '@mastra/core/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { withBackgroundIdleLoop } from '../mastra/background-idle-loop';
import { createBackgroundLedgerSource } from '../mastra/background-ledger';
import { saveBackgroundResult } from '../mastra/background-results';
import { createPgliteMastraMemory, type PgliteDatabase } from '../pglite-mastra-memory';
import {
  hasToolResult,
  parallelToolCallParts,
  scriptedAgentModel,
  textParts,
  toolCallParts,
  toolThenAnswer,
} from '../test-fixtures/scripted-agent-model';
import { createPristineEngineTestDb } from './helpers/migrated-agent-test-db';

async function collect(stream: AsyncIterable<ChunkType>): Promise<ChunkType[]> {
  const chunks: ChunkType[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Exercise the production parent coordinator against native task/storage APIs. */
async function coordinatedStream(
  parent: Agent,
  host: Mastra,
  threadId: string,
  abortSignal?: AbortSignal
) {
  const manager = host.backgroundTaskManager;
  if (!manager) {
    throw new Error('Missing native manager');
  }
  const scope = { resourceId: 'owner', threadId };
  const options = {
    ...(abortSignal ? { abortSignal } : {}),
    memory: { resource: scope.resourceId, thread: scope.threadId },
  };
  const first = await parent.stream('Run', options);
  const nativeRunIds = new Set([first.runId]);
  return withBackgroundIdleLoop(first, {
    abortSignal,
    agent: parent,
    ledger: createBackgroundLedgerSource({
      generation: async () => ({ generationRunId: first.runId, nativeRunIds: [...nativeRunIds] }),
      manager,
      personaLabel: (name) => name,
      rejectedDelegations: undefined,
      resolveInvocation: undefined,
      scope,
    }),
    manager,
    maxInvocations: 8,
    options,
    recordNativeRootRun: async (runId) => {
      nativeRunIds.add(runId);
    },
    rejectedDelegations: undefined,
    scope,
  });
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

describe('native public delegation lifecycle', () => {
  let database: PGlite;
  let workspace: string;
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
    workspace = await mkdtemp(join(tmpdir(), 'brainstrike-native-slice-'));
    await writeFile(join(workspace, 'input.txt'), 'NATIVE_INPUT');
    database = await createPristineEngineTestDb();
    backing = await createPgliteMastraMemory({
      database: memoryDatabase(),
      memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
    });
  });

  afterEach(async () => {
    const results = await Promise.allSettled([...hosts].map(shutdownHost));
    await database.close();
    await rm(workspace, { force: true, recursive: true });
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Mastra fixture shutdown failed');
    }
  });

  it('delivers child data once through its native task without parent contamination', async () => {
    const written = Promise.withResolvers<void>();
    let probeWrites = 0;
    const nativeContexts: unknown[] = [];
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
    const parentModel = scriptedAgentModel(async (options) => {
      if (hasToolResult(options, 'agent-worker')) {
        // Keep the dispatching turn open until the child has written.
        await written.promise;
        return textParts('Parent continues useful work');
      }
      return toolCallParts('agent-worker', 'background-delegation', {
        prompt: 'Inspect the workspace',
      });
    });
    const parent = new Agent({
      agents: { worker: child },
      backgroundTasks: { tools: { worker: { enabled: true } }, waitTimeoutMs: 0 },
      defaultOptions: {
        hooks: {
          beforeToolCall({ context }) {
            nativeContexts.push(context);
          },
        },
        maxSteps: 4,
      },
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
    expect(nativeContexts).toEqual([
      expect.objectContaining({
        background: expect.objectContaining({ taskId: expect.any(String) }),
        isBackgroundTask: true,
      }),
    ]);
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

  it('does not reinvoke a parent parked on its own approval when a child completes', async () => {
    const release = Promise.withResolvers<void>();
    let writes = 0;
    const child = new Agent({
      id: 'worker',
      instructions: 'Read once',
      memory: backing.memory,
      model: toolThenAnswer('read', 'child-read', {}).model,
      name: 'Worker',
      tools: {
        read: createTool({
          description: 'Held read',
          execute: async () => {
            await release.promise;
            return { text: 'read result' };
          },
          id: 'read',
          inputSchema: z.object({}),
        }),
      },
    });
    const model = scriptedAgentModel((options) => {
      if (!hasToolResult(options, 'agent-worker')) {
        return toolCallParts('agent-worker', 'delegate-worker', { prompt: 'Read' });
      }
      if (!hasToolResult(options, 'write')) {
        return toolCallParts('write', 'parent-write', {});
      }
      return textParts('Parent done');
    });
    const parent = new Agent({
      agents: { worker: child },
      backgroundTasks: { tools: { worker: { enabled: true } }, waitTimeoutMs: 0 },
      id: 'parent',
      instructions: 'Delegate then write',
      memory: backing.memory,
      model: model.model,
      name: 'Parent',
      tools: {
        write: createTool({
          description: 'Parent write',
          execute: async () => {
            writes += 1;
            return { written: true };
          },
          id: 'write',
          inputSchema: z.object({}),
          requireApproval: true,
        }),
      },
    });
    const host = new Mastra({
      agents: { parent },
      backgroundTasks: { defaultRetries: { maxRetries: 0 }, enabled: true },
      logger: false,
      storage: backing.storage,
    });
    hosts.add(host);
    try {
      const output = await coordinatedStream(parent, host, 'root-paused');
      let approvals = 0;
      for await (const chunk of output.fullStream) {
        if (chunk.type === 'tool-call-approval' && chunk.payload.toolCallId === 'parent-write') {
          approvals += 1;
          release.resolve();
        }
      }
      expect(approvals).toBe(1);
      expect(writes).toBe(0);
      expect(model.prompts).toHaveLength(2);
      expect(output.status).toBe('suspended');
    } finally {
      release.resolve();
    }
  });

  it('reads concurrent children, reconstructs parked approvals, and writes each file once', async () => {
    backing = await createPgliteMastraMemory({
      backgroundTaskScope: { resourceId: 'owner', threadId: 'root' },
      backgroundTaskTimeoutMs: 30_000,
      database: memoryDatabase(),
      memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
    });
    const jobs = ['alpha', 'beta'];
    const reads: string[] = [];
    const writes: string[] = [];
    const readBarrier = Promise.withResolvers<void>();
    const chunks: Record<string, unknown>[] = [];
    const resumedOutputs = new Map<string, unknown[]>();
    let parentCalls = 0;
    const makeParent = (): Agent => {
      const children = Object.fromEntries(
        jobs.map((job) => [
          job,
          new Agent({
            defaultOptions: { maxSteps: 5 },
            id: job,
            instructions: `Read then write ${job}.`,
            memory: backing.memory,
            model: scriptedAgentModel((options) => {
              if (!hasToolResult(options, 'read')) {
                return toolCallParts('read', `${job}-read`, {});
              }
              if (!hasToolResult(options, 'write')) {
                return toolCallParts('write', `${job}-write`, {});
              }
              return textParts(`${job} done`);
            }).model,
            name: job,
            tools: {
              read: createTool({
                description: 'Read the input',
                execute: async () => {
                  reads.push(job);
                  if (reads.length === jobs.length) {
                    readBarrier.resolve();
                  }
                  await readBarrier.promise;
                  return { text: await readFile(join(workspace, 'input.txt'), 'utf8') };
                },
                id: 'read',
                inputSchema: z.object({}),
              }),
              write: createTool({
                description: 'Append exactly once',
                execute: async (_input, context) => {
                  writes.push(job);
                  await appendFile(join(workspace, `${job}.txt`), `${job}\n`);
                  const writer: unknown = context['writer'];
                  if (!(writer instanceof ToolStream)) {
                    throw new Error('Missing writer');
                  }
                  // Identical repeated output is legitimate and must not be deduplicated.
                  await writer.custom({ data: { job, value: 'same' }, type: 'data-child-probe' });
                  await writer.custom({ data: { job, value: 'same' }, type: 'data-child-probe' });
                  return { written: job };
                },
                id: 'write',
                inputSchema: z.object({}),
                requireApproval: true,
              }),
            },
          }),
        ])
      );
      return new Agent({
        agents: children,
        backgroundTasks: {
          tools: Object.fromEntries(jobs.map((job) => [job, { enabled: true }])),
          waitTimeoutMs: 0,
        },
        defaultOptions: { maxSteps: 4 },
        id: 'parent',
        instructions: 'Delegate both jobs.',
        memory: backing.memory,
        model: scriptedAgentModel((options) => {
          parentCalls += 1;
          return hasToolResult(options, 'agent-alpha')
            ? textParts('Parent remains available')
            : parallelToolCallParts(
                jobs.map((job) => ({
                  args: { prompt: job },
                  toolCallId: `delegate-${job}`,
                  toolName: `agent-${job}`,
                }))
              );
        }).model,
        name: 'Parent',
      });
    };
    const makeHost = (parent: Agent): Mastra => {
      const host = new Mastra({
        agents: { parent },
        backgroundTasks: { defaultRetries: { maxRetries: 0 }, enabled: true },
        logger: false,
        storage: backing.storage,
      });
      hosts.add(host);
      return host;
    };
    const parent = makeParent();
    const host = makeHost(parent);
    const output = await coordinatedStream(parent, host, 'root');
    await collect(output.fullStream);
    expect(reads.toSorted()).toEqual(jobs);
    expect(writes).toEqual([]);
    const tasks = (await host.backgroundTaskManager?.listTasks({ threadId: 'root' }))?.tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks?.every((task) => task.status === 'suspended')).toBe(true);
    expect(parentCalls, 'Suspension must not wake an extra parent inference').toBe(2);
    if (!tasks) {
      throw new Error('Missing tasks');
    }
    await shutdownHost(host);
    const persisted = await database.dumpDataDir();
    await database.close();
    database = await createEnginePglite({ loadDataDir: persisted });
    backing = await createPgliteMastraMemory({
      backgroundTaskScope: { resourceId: 'owner', threadId: 'root' },
      backgroundTaskTimeoutMs: 30_000,
      database: memoryDatabase(),
      memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
    });
    const restoredParent = makeParent();
    const restoredHost = makeHost(restoredParent);
    const manager = restoredHost.backgroundTaskManager;
    if (!manager) {
      throw new Error('Missing reconstructed manager');
    }
    const watching = new AbortController();
    const terminal = new Set<string>();
    const stream = manager.stream({
      abortSignal: watching.signal,
      includeExisting: false,
      threadId: 'root',
    });
    const observed = (async () => {
      for await (const chunk of stream) {
        chunks.push(chunk);
        if (chunk['type'] === 'background-task-completed') {
          const payload = chunk['payload'];
          if (
            typeof payload !== 'object' ||
            !payload ||
            typeof Reflect.get(payload, 'taskId') !== 'string'
          ) {
            throw new Error('Missing task identity');
          }
          terminal.add(Reflect.get(payload, 'taskId'));
          if (terminal.size === 2) {
            return;
          }
        }
        if (
          chunk['type'] === 'background-task-failed' ||
          chunk['type'] === 'background-task-suspended'
        ) {
          throw new Error(JSON.stringify(chunk));
        }
      }
    })();
    const deliveryFailure = Promise.withResolvers<never>();
    const delivered = Promise.race([observed, deliveryFailure.promise]);
    try {
      for (const task of tasks) {
        if (!(task.resourceId && task.threadId)) {
          throw new Error('Missing persisted task scope');
        }
        const ownedOutput: unknown[] = [];
        resumedOutputs.set(task.id, ownedOutput);
        const tools = await restoredParent.getToolsForExecution({
          methodType: 'stream',
          resourceId: task.resourceId,
          runId: task.runId,
          threadId: task.threadId,
        });
        const execute = tools[task.toolName]?.execute;
        if (!execute) {
          throw new Error('Missing native executor');
        }
        manager.registerTaskContext(task.id, {
          executor: {
            execute: (args, options) =>
              execute(args, {
                messages: [],
                toolCallId: task.toolCallId,
                ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
                ...(options?.resumeData === undefined ? {} : { resumeData: options.resumeData }),
                ...(options?.suspendedToolRunId
                  ? { suspendedToolRunId: options.suspendedToolRunId }
                  : {}),
                ...(options?.suspend ? { suspend: options.suspend } : {}),
                outputWriter: async (chunk: unknown) => {
                  ownedOutput.push(chunk);
                },
              }),
          },
          onResult: async (result) => {
            try {
              await saveBackgroundResult(backing.memory, task, result);
            } catch (error) {
              deliveryFailure.reject(error);
              throw error;
            }
          },
        });
      }
      await Promise.all(tasks.map((task) => manager.resume(task.id, { approved: true })));
      await delivered;
      for (const task of tasks) {
        await expect(manager.resume(task.id, { approved: true })).rejects.toThrow(
          "Cannot resume task in status 'completed'"
        );
      }
    } finally {
      watching.abort();
    }
    expect(reads.toSorted()).toEqual(jobs);
    expect(writes.toSorted()).toEqual(jobs);
    const parentTranscript = await backing.memory.recall({
      perPage: false,
      resourceId: 'owner',
      threadId: 'root',
    });
    const savedParent = JSON.stringify(parentTranscript.messages);
    expect(savedParent).toContain('alpha done');
    expect(savedParent).toContain('beta done');
    for (const job of jobs) {
      expect(await readFile(join(workspace, `${job}.txt`), 'utf8')).toBe(`${job}\n`);
    }
    for (const task of tasks) {
      const output = resumedOutputs.get(task.id);
      if (!output) {
        throw new Error('Missing exact task output owner');
      }
      const data = output.filter(
        (chunk) =>
          typeof chunk === 'object' && chunk && 'type' in chunk && chunk.type === 'data-child-probe'
      );
      const job = task.toolName.slice('agent-'.length);
      expect(data).toEqual([
        expect.objectContaining({ data: { job, value: 'same' } }),
        expect.objectContaining({ data: { job, value: 'same' } }),
      ]);
    }
    const rows = await database.query<{ thread_id: string; content: unknown }>(
      "SELECT thread_id, content FROM mastra_messages WHERE content::text LIKE '%data-child-probe%'"
    );
    expect(rows.rows.some((row) => row.thread_id === 'root')).toBe(false);
    expect(new Set(rows.rows.map((row) => row.thread_id)).size).toBe(2);
    const counts = new Map<string, number>();
    for (const row of rows.rows) {
      counts.set(
        row.thread_id,
        (counts.get(row.thread_id) ?? 0) +
          (JSON.stringify(row.content).match(/data-child-probe/gu)?.length ?? 0)
      );
    }
    expect([...counts.values()]).toEqual([2, 2]);
  });
  it.each([false, true])(
    'joins selected child effects and settles the parent even when cleanup fails (%s)',
    async (failDeletion) => {
      const started = new Map(
        ['alpha', 'beta'].map((job) => [
          job,
          Promise.withResolvers<{ threadId: string; resourceId: string; signal: AbortSignal }>(),
        ])
      );
      const release = new Map(['alpha', 'beta'].map((job) => [job, Promise.withResolvers<void>()]));
      const cleaned = new Map(['alpha', 'beta'].map((job) => [job, Promise.withResolvers<void>()]));
      const runningJobs = new Set<string>();
      const cleanupEntered = Promise.withResolvers<void>();
      const cleanupRelease = Promise.withResolvers<void>();
      const child = new Agent({
        defaultOptions: { maxSteps: 4 },
        id: 'worker',
        instructions: 'Work once',
        memory: backing.memory,
        model: scriptedAgentModel((options) => {
          const lastUser = JSON.stringify(
            options.prompt.findLast((message) => message.role === 'user')
          );
          const job = ['alpha', 'beta'].find((candidate) => lastUser?.includes(candidate));
          if (!job) {
            throw new Error('Missing exact scripted child task');
          }
          return hasToolResult(options, 'work')
            ? textParts(`${job} done`)
            : toolCallParts('work', `${job}-work`, { job });
        }).model,
        name: 'Worker',
        tools: {
          work: createTool({
            description: 'Held filesystem effect',
            execute: async ({ job }, context) => {
              const signal = context?.['abortSignal'];
              const scope = context?.['agent'];
              if (!(signal && scope?.threadId && scope.resourceId)) {
                throw new Error('Missing child execution scope');
              }
              runningJobs.add(job);
              started
                .get(job)
                ?.resolve({ resourceId: scope.resourceId, signal, threadId: scope.threadId });
              const aborted = Promise.withResolvers<void>();
              const onAbort = (): void => {
                aborted.resolve();
              };
              signal.addEventListener('abort', onAbort, { once: true });
              try {
                await Promise.race([release.get(job)?.promise, aborted.promise]);
                signal.throwIfAborted();
                await appendFile(join(workspace, `${job}.txt`), `${job}\n`);
                return { written: job };
              } finally {
                signal.removeEventListener('abort', onAbort);
                if (job === 'alpha') {
                  cleanupEntered.resolve();
                  await cleanupRelease.promise;
                }
                cleaned.get(job)?.resolve();
              }
            },
            id: 'work',
            inputSchema: z.object({ job: z.enum(['alpha', 'beta']) }),
          }),
        },
      });
      const cleanupFailure = new Error('Selected cancellation storage cleanup failed');
      let failedTaskId: string | undefined;
      const remove = backing.workflows.deleteWorkflowRunById.bind(backing.workflows);
      const deletion = vi
        .spyOn(backing.workflows, 'deleteWorkflowRunById')
        .mockImplementation(async (input) => {
          if (failDeletion && input.runId === failedTaskId) {
            throw cleanupFailure;
          }
          await remove(input);
        });
      const parentStop = new AbortController();
      const parent = new Agent({
        agents: { worker: child },
        backgroundTasks: { tools: { worker: { enabled: true } }, waitTimeoutMs: 0 },
        defaultOptions: { maxSteps: 4 },
        id: 'parent',
        instructions: 'Delegate both',
        memory: backing.memory,
        model: scriptedAgentModel((options) =>
          hasToolResult(options, 'agent-worker')
            ? textParts('Parent available')
            : parallelToolCallParts(
                ['alpha', 'beta'].map((job) => ({
                  args: { prompt: job },
                  toolCallId: `delegate-${job}`,
                  toolName: 'agent-worker',
                }))
              )
        ).model,
        name: 'Parent',
      });
      const host = new Mastra({
        agents: { parent },
        backgroundTasks: { defaultRetries: { maxRetries: 0 }, enabled: true },
        storage: backing.storage,
      });
      hosts.add(host);
      const output = failDeletion
        ? await coordinatedStream(parent, host, 'stop-root', parentStop.signal)
        : await parent.stream('Run both', {
            abortSignal: parentStop.signal,
            memory: { resource: 'owner', thread: 'stop-root' },
            untilIdle: true,
          });
      let streamSettled = false;
      const consuming = collect(output.fullStream).finally(() => {
        streamSettled = true;
      });
      try {
        const [alpha, beta] = await Promise.race([
          Promise.all([started.get('alpha')?.promise, started.get('beta')?.promise]),
          consuming.then((chunks) => {
            throw new Error(`Stream ended before both jobs: ${JSON.stringify(chunks)}`);
          }),
        ]);
        if (!(alpha && beta)) {
          throw new Error('Missing started children');
        }
        let acknowledged = false;
        const manager = host.backgroundTaskManager;
        if (!manager) {
          throw new Error('Missing native task manager');
        }
        const tasks = await manager.listTasks({ threadId: 'stop-root' });
        const selected = tasks.tasks.find((task) => task.toolCallId === 'delegate-alpha');
        if (!selected) {
          throw new Error('Missing selected native task');
        }
        failedTaskId = selected.id;
        const joined = manager.cancel(selected.id).then(() => {
          acknowledged = true;
        });
        const outcome = joined.then(
          () => undefined,
          (error: unknown) => error
        );
        await cleanupEntered.promise;
        await nextTurn();
        expect(acknowledged).toBe(false);
        expect(alpha.signal.aborted).toBe(true);
        expect(beta.signal.aborted).toBe(false);
        expect(parentStop.signal.aborted).toBe(false);
        // Sibling effects remain runnable even while selected cleanup is held.
        release.get('beta')?.resolve();
        await cleaned.get('beta')?.promise;
        expect(await readFile(join(workspace, 'beta.txt'), 'utf8')).toBe('beta\n');
        cleanupRelease.resolve();
        if (failDeletion) {
          expect(await outcome).toBe(cleanupFailure);
        } else {
          await joined;
        }
        await expect.poll(() => streamSettled, { timeout: 1500 }).toBe(true);
        release.get('alpha')?.resolve();
        await consuming;
        await expect(readFile(join(workspace, 'alpha.txt'), 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(acknowledged).toBe(!failDeletion);
      } finally {
        parentStop.abort();
        cleanupRelease.resolve();
        for (const entry of release.values()) {
          entry.resolve();
        }
        await consuming;
        await Promise.all([...runningJobs].map((job) => cleaned.get(job)?.promise));
        deletion.mockRestore();
        if (failDeletion) {
          await expect(shutdownHost(host)).rejects.toMatchObject({ errors: [cleanupFailure] });
        }
      }
    }
  );
  it('documents native EOF during a host decision commit, with resume continuing outside that stream', async () => {
    const siblingRelease = Promise.withResolvers<void>();
    const decisionCommit = Promise.withResolvers<void>();
    let writes = 0;
    const writer = new Agent({
      id: 'writer',
      instructions: 'Write once',
      memory: backing.memory,
      model: toolThenAnswer('write', 'child-write', {}).model,
      name: 'Writer',
      tools: {
        write: createTool({
          description: 'Approved write',
          execute: async () => {
            writes += 1;
            return { written: true };
          },
          id: 'write',
          inputSchema: z.object({}),
          requireApproval: true,
        }),
      },
    });
    const reader = new Agent({
      id: 'reader',
      instructions: 'Read once',
      memory: backing.memory,
      model: toolThenAnswer('read', 'child-read', {}).model,
      name: 'Reader',
      tools: {
        read: createTool({
          description: 'Read',
          execute: async () => {
            await siblingRelease.promise;
            return { read: true };
          },
          id: 'read',
          inputSchema: z.object({}),
        }),
      },
    });
    const parentModel = scriptedAgentModel((options) =>
      hasToolResult(options, 'agent-writer')
        ? textParts('Parent response')
        : parallelToolCallParts(
            ['writer', 'reader'].map((name) => ({
              args: { prompt: name },
              toolCallId: `delegate-${name}`,
              toolName: `agent-${name}`,
            }))
          )
    );
    const parent = new Agent({
      agents: { reader, writer },
      backgroundTasks: { tools: { reader: { enabled: true }, writer: { enabled: true } } },
      id: 'parent',
      instructions: 'Delegate both',
      memory: backing.memory,
      model: parentModel.model,
      name: 'Parent',
    });
    const host = new Mastra({
      agents: { parent },
      backgroundTasks: { defaultRetries: { maxRetries: 0 }, enabled: true },
      logger: false,
      storage: backing.storage,
    });
    hosts.add(host);
    const manager = host.backgroundTaskManager;
    if (!manager) {
      throw new Error('Missing manager');
    }
    const output = await parent.stream('Run', {
      memory: { resource: 'owner', thread: 'approval-boundary' },
      untilIdle: true,
    });
    let approvedTaskId: string | undefined;
    let pendingDecision: Promise<void> | undefined;
    const chunks: ChunkType[] = [];
    try {
      for await (const chunk of output.fullStream) {
        chunks.push(chunk);
        if (chunk.type !== 'background-task-suspended') {
          continue;
        }
        const taskId = chunk.payload.taskId;
        approvedTaskId = taskId;
        // The host has accepted this decision, but must persist it before
        // allowing a side effect. No private APIs or stream-lifetime hooks.
        pendingDecision = (async () => {
          await decisionCommit.promise;
          await manager.resume(taskId, { approved: true });
        })();
        siblingRelease.resolve();
      }
      if (!(approvedTaskId && pendingDecision)) {
        throw new Error('No parked writer');
      }
      // Characterize the capability boundary; this is not acceptance of the
      // product behavior. The original stream ended before commit or write.
      expect(writes).toBe(0);
      const callsAtEof = parentModel.prompts.length;
      const observation = new AbortController();
      const observed = (async () => {
        for await (const chunk of manager.stream({
          abortSignal: observation.signal,
          includeExisting: false,
          threadId: 'approval-boundary',
        })) {
          const payload = chunk['payload'];
          if (
            chunk['type'] === 'background-task-completed' &&
            typeof payload === 'object' &&
            payload !== null &&
            'taskId' in payload &&
            payload.taskId === approvedTaskId
          ) {
            return;
          }
          if (chunk['type'] === 'background-task-failed') {
            throw new Error(JSON.stringify(chunk));
          }
        }
        throw new Error('Task stream closed without the resumed result');
      })();
      try {
        decisionCommit.resolve();
        await pendingDecision;
        await observed;
        expect(writes).toBe(1);
        expect(parentModel.prompts).toHaveLength(callsAtEof);
        expect(
          chunks.some(
            (chunk) =>
              chunk.type === 'background-task-completed' && chunk.payload.taskId === approvedTaskId
          )
        ).toBe(false);
      } finally {
        observation.abort();
      }
    } finally {
      siblingRelease.resolve();
      decisionCommit.resolve();
      await pendingDecision;
    }
  });
});
