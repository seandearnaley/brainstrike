import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { RootLockedError, StateStore } from '@brainstrike/state-store';
import { modelMessageSchema } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { HostCore, type HostEventStore, jsonValue } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';
import { AgentHostStartupError, startAgentHost } from '../src/runtime.js';
import { foldHostRuns } from '../src/thread-view.js';
import { scriptedModel, scriptedToolSequence } from './fixtures/scripted-model.js';

function platform(overrides: Partial<HostPlatform> = {}): HostPlatform {
  return {
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => scriptedModel(),
    tools: {},
    ...overrides,
  };
}
async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bs-m3-cleanup-'));
}
async function start(core: HostCore): Promise<{ threadId: string; runId: string }> {
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  const { runId } = await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Report completion.',
    threadId,
  });
  return { runId, threadId };
}

test('terminal publication admits the next run only after its FULL commit and owner release', async () => {
  const dataRoot = await root();
  const store = await StateStore.open(dataRoot);
  const core = await HostCore.open(store, platform(), () => () => undefined);
  const next = Promise.withResolvers<{ runId: string }>();
  let requested = false;
  core.onCommitted((row) => {
    if (row.event.type === 'run.finished' && !requested) {
      requested = true;
      core
        .startRun({
          commandId: randomUUID(),
          modelId: 'scripted',
          prompt: 'Next message at terminal publication',
          threadId: row.threadId,
        })
        .then(next.resolve, next.reject);
    }
  });
  try {
    const ids = await start(core);
    expect((await next.promise).runId).not.toBe(ids.runId);
    await expect
      .poll(
        async () =>
          (await core.read(ids.threadId, 0)).filter((row) => row.event.type === 'run.finished')
            .length
      )
      .toBe(2);
  } finally {
    await core.close();
    await store.close();
    await rm(dataRoot, { force: true, recursive: true });
  }
});

test('Stop fences and joins a physical child even when accepting the durable command fails', async () => {
  const dataRoot = await root();
  const store = await StateStore.open(dataRoot);
  const ready = Promise.withResolvers<number>();
  const closed = Promise.withResolvers<void>();
  const failure = new Error('Stop acceptance rejected');
  let aborted = false;
  let active = 0;
  const core = await HostCore.open(
    {
      append: (items, committed, durability) =>
        items.some(
          (item) => item.event.type === 'command.accepted' && item.event['method'] === 'run/stop'
        )
          ? Promise.reject(failure)
          : store.append(items, committed, durability),
      read: (threadId, fromSeq) => store.read(threadId, fromSeq),
      root: store.root,
      syncBoundary: (threadId) => store.syncBoundary(threadId),
      threads: () => store.threads(),
    },
    platform({
      readPermissionPolicy: () => ({
        policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'allow' },
        yolo: false,
      }),
      resolveModel: async () => scriptedModel('child'),
      tools: {
        child: {
          description: 'Owned physical child',
          execute: async (_input, context) => {
            const child = spawn(
              process.execPath,
              ['-e', "process.stdout.write('ready');process.stdin.resume()"],
              { stdio: ['pipe', 'pipe', 'pipe'] }
            );
            child.once('close', () => closed.resolve());
            child.stdout.once('data', () => ready.resolve(child.pid ?? 0));
            context.signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                child.kill('SIGTERM');
              },
              { once: true }
            );
            await closed.promise;
            return { joined: true };
          },
          identity: 'owned-child',
          inputSchema: z.object({ text: z.string() }),
          risk: 'edit',
        },
      },
    }),
    () => {
      active += 1;
      return () => {
        active -= 1;
      };
    }
  );
  try {
    const ids = await start(core);
    const pid = await ready.promise;
    const params = { commandId: randomUUID(), ...ids };
    const stopped = core.stop(params);
    stopped.catch(() => undefined);
    await expect.poll(() => aborted).toBe(true);
    await expect(stopped).rejects.toBe(failure);
    await closed.promise;
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(core.stop(params)).rejects.toBe(failure);
    expect(active).toBe(1);
    await expect(StateStore.open(dataRoot)).rejects.toBeInstanceOf(RootLockedError);
  } finally {
    await core.close().catch(() => undefined);
    await closed.promise;
    await store.close();
    await rm(dataRoot, { force: true, recursive: true });
  }
});

test.each(['automatic', 'last-step approval', 'async refinement'] as const)(
  'SDK canonical input executes once through %s',
  async (mode) => {
    const dataRoot = await root();
    const store = await StateStore.open(dataRoot);
    let executed: unknown;
    const schema = z.object({ n: z.number().transform((n) => n + 1) });
    const core = await HostCore.open(
      store,
      platform({
        maxSteps: mode === 'last-step approval' ? 1 : 3,
        readPermissionPolicy: () => ({
          policies: {
            ...DEFAULT_PERMISSION_POLICIES,
            edit: mode === 'last-step approval' ? 'ask' : 'allow',
          },
          yolo: false,
        }),
        resolveModel: async () => scriptedToolSequence([{ input: { n: 1 }, toolId: 'canonical' }]),
        tools: {
          canonical: {
            description: 'Canonical transformed input',
            execute: async (input) => {
              executed = input;
              return input;
            },
            identity: 'canonical',
            inputSchema:
              mode === 'async refinement' ? schema.refine(async ({ n }) => n === 2) : schema,
            risk: 'edit',
          },
        },
      }),
      () => () => undefined
    );
    try {
      const ids = await start(core);
      if (mode === 'last-step approval') {
        let interaction:
          | Extract<import('../src/protocol.js').HostEvent, { type: 'interaction.requested' }>
          | undefined;
        await expect
          .poll(async () => {
            interaction = (await core.read(ids.threadId, 0))
              .map((row) => row.event)
              .find((event) => event.type === 'interaction.requested');
            return interaction !== undefined;
          })
          .toBe(true);
        if (!interaction) {
          throw new Error('Expected approval');
        }
        await core.respond({
          commandId: randomUUID(),
          decision: 'approve',
          interactionId: interaction.interactionId,
          ...ids,
        });
      }
      await expect
        .poll(async () =>
          (await core.read(ids.threadId, 0)).some((row) => row.event.type === 'run.finished')
        )
        .toBe(true);
      expect(executed).toEqual({ n: 2 });
    } finally {
      await core.close();
      await store.close();
      await rm(dataRoot, { force: true, recursive: true });
    }
  }
);

test.each([
  'automatic',
  'last-step approval',
  'restarted approval',
  'restarted last-step approval',
] as const)('validated Date input reaches the native executor through %s', async (mode) => {
  const dataRoot = await root();
  let store = await StateStore.open(dataRoot);
  let received: unknown;
  let projectedInput: unknown;
  const capabilities = platform({
    maxSteps: mode === 'last-step approval' || mode === 'restarted last-step approval' ? 1 : 3,
    readPermissionPolicy: () => ({
      policies: { ...DEFAULT_PERMISSION_POLICIES, edit: mode === 'automatic' ? 'allow' : 'ask' },
      yolo: false,
    }),
    resolveModel: async () =>
      scriptedToolSequence([{ input: { at: '2026-10-06T00:00:00.000Z' }, toolId: 'runtime_date' }]),
    tools: {
      runtime_date: {
        description: 'Runtime input type preservation',
        execute: async (input) => {
          received = input;
          if (!(input && typeof input === 'object' && 'at' in input && input.at instanceof Date)) {
            throw new TypeError('Native executor requires its validated Date');
          }
          return { time: input.at.getTime() };
        },
        identity: 'runtime-date',
        inputSchema: z.object({ at: z.iso.datetime().transform((value) => new Date(value)) }),
        risk: 'edit',
        toModelOutput: async ({ input, output }) => {
          projectedInput = input;
          return { type: 'json', value: jsonValue(output) };
        },
      },
    },
  });
  let core = await HostCore.open(store, capabilities, () => () => undefined);
  try {
    const ids = await start(core);
    if (mode !== 'automatic') {
      let interaction:
        | Extract<import('../src/protocol.js').HostEvent, { type: 'interaction.requested' }>
        | undefined;
      await expect
        .poll(async () => {
          interaction = (await core.read(ids.threadId, 0))
            .map((row) => row.event)
            .find((event) => event.type === 'interaction.requested');
          return interaction !== undefined;
        })
        .toBe(true);
      if (!interaction) {
        throw new Error('Expected Date approval');
      }
      const pending = interaction;
      expect(pending.input).toEqual({ at: '2026-10-06T00:00:00.000Z' });
      const committed = await core.read(ids.threadId, 0);
      const schemaInputs = committed
        .flatMap((row) => (row.event.type === 'model.step' ? row.event.messages : []))
        .flatMap((value) => {
          const message = modelMessageSchema.parse(value);
          return message.role === 'assistant' && typeof message.content !== 'string'
            ? message.content
                .filter((part) => part.type === 'tool-approval-request')
                .map((part) => part.inputSchemaInput)
            : [];
        });
      expect(schemaInputs).toEqual([{ at: '2026-10-06T00:00:00.000Z' }]);
      if (mode === 'restarted approval' || mode === 'restarted last-step approval') {
        await core.close();
        await store.close();
        store = await StateStore.open(dataRoot);
        core = await HostCore.open(store, capabilities, () => () => undefined);
      }
      await core.respond({
        commandId: randomUUID(),
        decision: 'approve',
        interactionId: pending.interactionId,
        ...ids,
      });
    }
    await expect
      .poll(async () =>
        (await core.read(ids.threadId, 0)).some((row) => row.event.type === 'run.finished')
      )
      .toBe(true);
    expect(received).toEqual({ at: new Date('2026-10-06T00:00:00.000Z') });
    expect(projectedInput).toEqual({ at: new Date('2026-10-06T00:00:00.000Z') });
    expect(
      (await core.read(ids.threadId, 0)).find((row) => row.event.type === 'run.finished')?.event
    ).toMatchObject({ outcome: 'completed' });
  } finally {
    await core.close();
    await store.close();
    await rm(dataRoot, { force: true, recursive: true });
  }
});

test('an answerable approval always has its complete committed public SDK context, including after restart', async () => {
  const dataRoot = await root();
  let store = await StateStore.open(dataRoot);
  const finish = Promise.withResolvers<void>();
  const source = scriptedModel('write_file');
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const result = await source.doStream(options);
      const reader = result.stream.getReader();
      return {
        ...result,
        stream: new ReadableStream({
          start: async (controller) => {
            try {
              while (true) {
                const next = await reader.read();
                if (next.done) {
                  break;
                }
                if (next.value.type === 'finish') {
                  await finish.promise;
                }
                controller.enqueue(next.value);
              }
              controller.close();
            } catch (cause) {
              controller.error(cause);
            }
          },
        }),
      };
    },
  });
  let effects = 0;
  const capabilities = platform({
    resolveModel: async () => model,
    tools: {
      write_file: {
        description: 'Recorded SDK tool',
        execute: async () => {
          effects += 1;
          return { effects };
        },
        identity: 'native',
        inputSchema: z.object({ text: z.string() }),
        risk: 'edit',
      },
    },
  });
  let core = await HostCore.open(store, capabilities, () => () => undefined);
  try {
    const ids = await start(core);
    await expect
      .poll(async () =>
        (await core.read(ids.threadId, 0)).some(
          (row) =>
            row.event.type === 'stream.chunk' &&
            typeof row.event.chunk === 'object' &&
            row.event.chunk !== null &&
            !Array.isArray(row.event.chunk) &&
            row.event.chunk['type'] === 'tool-approval-request'
        )
      )
      .toBe(true);
    expect(
      (await core.read(ids.threadId, 0)).some((row) => row.event.type === 'interaction.requested')
    ).toBe(false);
    finish.resolve();
    let interaction:
      | Extract<import('../src/protocol.js').HostEvent, { type: 'interaction.requested' }>
      | undefined;
    await expect
      .poll(async () => {
        interaction = (await core.read(ids.threadId, 0))
          .map((row) => row.event)
          .find((event) => event.type === 'interaction.requested');
        return interaction !== undefined;
      })
      .toBe(true);
    if (!interaction) {
      throw new Error('Expected committed approval');
    }
    const pending = interaction;
    const rows = await core.read(ids.threadId, 0);
    const parts = rows
      .flatMap((row) =>
        row.event.type === 'model.step'
          ? row.event.messages.map((message) => modelMessageSchema.parse(message))
          : []
      )
      .flatMap((message) =>
        message.role === 'assistant' && Array.isArray(message.content) ? message.content : []
      );
    expect(parts).toContainEqual(
      expect.objectContaining({ toolCallId: pending.toolCallId, type: 'tool-call' })
    );
    expect(parts).toContainEqual(
      expect.objectContaining({
        approvalId: pending.interactionId,
        toolCallId: pending.toolCallId,
        type: 'tool-approval-request',
      })
    );
    await core.close();
    await store.close();
    store = await StateStore.open(dataRoot);
    core = await HostCore.open(store, capabilities, () => () => undefined);
    await core.respond({
      commandId: randomUUID(),
      decision: 'approve',
      interactionId: pending.interactionId,
      ...ids,
    });
    await expect.poll(() => effects).toBe(1);
    await expect
      .poll(async () =>
        (await core.read(ids.threadId, 0)).some((row) => row.event.type === 'run.finished')
      )
      .toBe(true);
    expect(effects).toBe(1);
  } finally {
    finish.resolve();
    await core.close();
    await store.close();
    await rm(dataRoot, { force: true, recursive: true });
  }
});

test('held run cleanup blocks terminal commit, repeated Stop and release until every tail joins', async () => {
  const dataRoot = await root();
  const store = await StateStore.open(dataRoot);
  const entered = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.stdout.write('ready'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const childClosed = Promise.withResolvers<void>();
  child.once('close', () => childClosed.resolve());
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
  });
  if (!child.pid) {
    throw new Error('Owned fixture child did not start');
  }
  const childPid = child.pid;
  let active = 0;
  let ownerCloses = 0;
  let signal: AbortSignal | undefined;
  const core = await HostCore.open(
    store,
    platform({
      openRun: async (context) => {
        signal = context.signal;
        return {
          close: async () => {
            ownerCloses += 1;
            entered.resolve();
            await drained.promise;
            child.stdin.end();
            await childClosed.promise;
          },
        };
      },
    }),
    () => {
      active += 1;
      return () => {
        active -= 1;
      };
    }
  );
  try {
    const ids = await start(core);
    await entered.promise;
    expect(
      (await core.read(ids.threadId, 0)).some((row) => row.event.type === 'run.finished')
    ).toBe(false);
    const command = { commandId: randomUUID(), ...ids };
    let acknowledged = false;
    const stopped = core.stop(command).then((result) => {
      acknowledged = true;
      return result;
    });
    await expect.poll(() => signal?.aborted).toBe(true);
    expect(active).toBe(1);
    expect(acknowledged).toBe(false);
    expect(() => process.kill(childPid, 0)).not.toThrow();
    await expect(StateStore.open(dataRoot)).rejects.toBeInstanceOf(RootLockedError);
    drained.resolve();
    expect(await stopped).toEqual({ outcome: 'stopped' });
    expect(await core.stop(command)).toEqual({ outcome: 'stopped' });
    expect(ownerCloses).toBe(1);
    expect(active).toBe(0);
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(
      (await core.read(ids.threadId, 0)).filter((row) => row.event.type === 'run.finished')
    ).toHaveLength(1);
    expect(
      (await core.read(ids.threadId, 0)).find((row) => row.event.type === 'run.finished')?.event
    ).toMatchObject({ outcome: 'stopped' });
    await core.close();
  } finally {
    drained.resolve();
    await core.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
    }
    await childClosed.promise;
    await store.close();
    await rm(dataRoot, { force: true, recursive: true });
  }
});

test('rejected platform shutdown holds the real store and reports the same failure on repeated close', async () => {
  const dataRoot = await root();
  let closes = 0;
  const host = await startAgentHost(
    { lifetime: 'persistent', root: dataRoot },
    platform({
      close: async () => {
        closes += 1;
        throw new Error('platform drain failed');
      },
    })
  );
  const store = host.core.store;
  if (!(store instanceof StateStore)) {
    throw new Error('Fixture lost its store owner');
  }
  try {
    await expect(host.close()).rejects.toThrow();
    await expect(host.close()).rejects.toThrow();
    expect(closes).toBe(1);
    await expect(StateStore.open(dataRoot)).rejects.toBeInstanceOf(RootLockedError);
    expect(await host.core.store.threads()).toEqual([]);
  } finally {
    await store.close();
    await rm(dataRoot, { force: true, recursive: true });
  }
});

test('completed actors remain registered and are fenced on shutdown after their owner drains', async () => {
  const dataRoot = await root();
  const store = await StateStore.open(dataRoot);
  const drained = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  let closes = 0;
  const core = await HostCore.open(
    store,
    platform({
      openRun: async (context) => {
        signal = context.signal;
        return {
          close: async () => {
            closes += 1;
            drained.resolve();
          },
        };
      },
    }),
    () => () => undefined
  );
  try {
    const ids = await start(core);
    await drained.promise;
    await expect
      .poll(async () =>
        (await core.read(ids.threadId, 0)).some((row) => row.event.type === 'run.finished')
      )
      .toBe(true);
    expect(signal?.aborted).toBe(false);
    await core.close();
    expect(signal?.aborted).toBe(true);
    expect(closes).toBe(1);
  } finally {
    await store.close();
    await rm(dataRoot, { force: true, recursive: true });
  }
});

test('rejected run cleanup remains owned and repeated Stop never returns cached success', async () => {
  const dataRoot = await root();
  const store = await StateStore.open(dataRoot);
  const failed = Promise.withResolvers<void>();
  let active = 0;
  let ownerCloses = 0;
  const cleanupFailure = new Error('recorded hook cleanup failed');
  const core = await HostCore.open(
    store,
    platform({
      openRun: async () => ({
        close: async () => {
          ownerCloses += 1;
          failed.resolve();
          throw cleanupFailure;
        },
      }),
    }),
    () => {
      active += 1;
      return () => {
        active -= 1;
      };
    }
  );
  try {
    const ids = await start(core);
    await failed.promise;
    const command = { commandId: randomUUID(), ...ids };
    await expect(core.stop(command)).rejects.toBe(cleanupFailure);
    await expect(core.stop(command)).rejects.toBe(cleanupFailure);
    expect(ownerCloses).toBe(1);
    expect(active).toBe(1);
    expect(
      (await core.read(ids.threadId, 0)).some((row) => row.event.type === 'run.finished')
    ).toBe(false);
    await expect(core.close()).rejects.toThrow('Host cleanup failed');
    await expect(StateStore.open(dataRoot)).rejects.toBeInstanceOf(RootLockedError);
  } finally {
    // This fixture owns no physical resources; explicitly dispose its retained real store.
    await store.close();
    await rm(dataRoot, { force: true, recursive: true });
  }
});

test('failed terminal append retains run admission and does not retry persistence on Stop or close', async () => {
  const dataRoot = await root();
  const store = await StateStore.open(dataRoot);
  const attempted = Promise.withResolvers<void>();
  const failure = new Error('terminal writer rejected');
  let terminals = 0;
  let active = 0;
  const port: HostEventStore = {
    append: async (items, committed, durability) => {
      if (items.some((item) => item.event.type === 'run.finished')) {
        terminals += 1;
        attempted.resolve();
        throw failure;
      }
      return store.append(items, committed, durability);
    },
    read: (threadId, fromSeq) => store.read(threadId, fromSeq),
    root: store.root,
    syncBoundary: (threadId) => store.syncBoundary(threadId),
    threads: () => store.threads(),
  };
  const core = await HostCore.open(port, platform(), () => {
    active += 1;
    return () => {
      active -= 1;
    };
  });
  try {
    const ids = await start(core);
    await attempted.promise;
    const command = { commandId: randomUUID(), ...ids };
    await expect(core.stop(command)).rejects.toBe(failure);
    await expect(core.stop(command)).rejects.toBe(failure);
    await expect(
      core.startRun({
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: 'Another run',
        threadId: ids.threadId,
      })
    ).rejects.toThrow('active root run');
    await expect(core.close()).rejects.toThrow('Host cleanup failed');
    expect(terminals).toBe(1);
    expect(active).toBe(1);
    expect(
      (await core.read(ids.threadId, 0)).some((row) => row.event.type === 'run.finished')
    ).toBe(false);
  } finally {
    await store.close();
    await rm(dataRoot, { force: true, recursive: true });
  }
});

test('held platform cleanup keeps the SQLite owner live through host shutdown', async () => {
  const dataRoot = await root();
  const entered = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  const host = await startAgentHost(
    { lifetime: 'persistent', root: dataRoot },
    platform({
      close: async () => {
        entered.resolve();
        await drained.promise;
      },
    })
  );
  try {
    const closing = host.close();
    await entered.promise;
    await expect(StateStore.open(dataRoot)).rejects.toBeInstanceOf(RootLockedError);
    expect(await host.core.store.threads()).toEqual([]);
    drained.resolve();
    await closing;
    const reopened = await StateStore.open(dataRoot);
    await reopened.close();
  } finally {
    drained.resolve();
    await host.close();
    await rm(dataRoot, { force: true, recursive: true });
  }
});

test('rejected startup cleanup exposes and retains the durable owner instead of releasing it', async () => {
  const dataRoot = await root();
  const original = await StateStore.open(dataRoot);
  await original.append([{ event: { type: 'thread.started' }, threadId: randomUUID() }]);
  await original.close();
  let owned: StateStore | undefined;
  try {
    try {
      await startAgentHost(
        { lifetime: 'persistent', root: dataRoot },
        platform({
          close: async () => {
            throw new Error('platform cleanup rejected');
          },
        })
      );
      throw new Error('Expected startup rejection');
    } catch (cause) {
      expect(cause).toBeInstanceOf(AgentHostStartupError);
      if (!(cause instanceof AgentHostStartupError)) {
        throw cause;
      }
      owned = cause.store;
      expect(cause.core).toBeInstanceOf(HostCore);
      await expect(StateStore.open(dataRoot)).rejects.toBeInstanceOf(RootLockedError);
      expect(await owned.threads()).toHaveLength(1);
    }
  } finally {
    await owned?.close();
    await rm(dataRoot, { force: true, recursive: true });
  }
});

test('failed atomic terminal FULL commit keeps live and replay views running and retains ownership', async () => {
  const dataRoot = await root();
  const store = await StateStore.open(dataRoot);
  const attempted = Promise.withResolvers<void>();
  const failure = new Error('terminal FULL boundary rejected');
  let terminals = 0;
  const live: import('../src/protocol.js').HostLogRow[] = [];
  let active = 0;
  const port: HostEventStore = {
    append: async (items, committed, durability) => {
      if (items.some((item) => item.event.type === 'run.finished')) {
        expect(durability).toBe('full');
        terminals += 1;
        attempted.resolve();
        throw failure;
      }
      return store.append(items, committed, durability);
    },
    read: (threadId, fromSeq) => store.read(threadId, fromSeq),
    root: store.root,
    syncBoundary: (threadId) => store.syncBoundary(threadId),
    threads: () => store.threads(),
  };
  const core = await HostCore.open(port, platform(), () => {
    active += 1;
    return () => {
      active -= 1;
    };
  });
  core.onCommitted((row) => live.push(row));
  try {
    const ids = await start(core);
    await attempted.promise;
    expect(foldHostRuns(await core.read(ids.threadId, 0))[0]?.status).toBe('running');
    expect(foldHostRuns(live)[0]?.status).toBe('running');
    const command = { commandId: randomUUID(), ...ids };
    await expect(core.stop(command)).rejects.toBe(failure);
    await expect(core.stop(command)).rejects.toBe(failure);
    expect(active).toBe(1);
    expect(
      (await core.read(ids.threadId, 0)).filter((row) => row.event.type === 'run.finished')
    ).toHaveLength(0);
    expect(terminals).toBe(1);
    await expect(core.close()).rejects.toThrow('Host cleanup failed');
    await expect(StateStore.open(dataRoot)).rejects.toBeInstanceOf(RootLockedError);
  } finally {
    await store.close();
    await rm(dataRoot, { force: true, recursive: true });
  }
});
