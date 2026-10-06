import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { RootLockedError, StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { HostCore, type HostEventStore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';
import { AgentHostStartupError, startAgentHost } from '../src/runtime.js';
import { scriptedModel } from './fixtures/scripted-model.js';

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
    append: async (items, committed) => {
      if (items.some((item) => item.event.type === 'run.finished')) {
        terminals += 1;
        attempted.resolve();
        throw failure;
      }
      return store.append(items, committed);
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

test('failed terminal FULL boundary keeps ownership and repeated Stop does not duplicate the committed event', async () => {
  const dataRoot = await root();
  const store = await StateStore.open(dataRoot);
  const attempted = Promise.withResolvers<void>();
  const failure = new Error('terminal FULL boundary rejected');
  let terminalCommitted = false;
  let active = 0;
  const port: HostEventStore = {
    append: async (items, committed) => {
      const rows = await store.append(items, committed);
      terminalCommitted ||= items.some((item) => item.event.type === 'run.finished');
      return rows;
    },
    read: (threadId, fromSeq) => store.read(threadId, fromSeq),
    root: store.root,
    syncBoundary: async (threadId) => {
      if (terminalCommitted) {
        attempted.resolve();
        throw failure;
      }
      await store.syncBoundary(threadId);
    },
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
    expect(active).toBe(1);
    expect(
      (await core.read(ids.threadId, 0)).filter((row) => row.event.type === 'run.finished')
    ).toHaveLength(1);
    await expect(core.close()).rejects.toThrow('Host cleanup failed');
    await expect(StateStore.open(dataRoot)).rejects.toBeInstanceOf(RootLockedError);
  } finally {
    await store.close();
    await rm(dataRoot, { force: true, recursive: true });
  }
});
