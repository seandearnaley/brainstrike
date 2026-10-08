import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { RootLock, RootLockedError, StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';
import type { HostEvent } from '../src/protocol.js';
import { MemoryProviderOwnershipFixture } from './fixtures/memory-provider-ownership.js';
import { scriptedModel } from './fixtures/scripted-model.js';

async function setup(cleanupFailure?: Error): Promise<{
  core: HostCore;
  fixtures: MemoryProviderOwnershipFixture[];
  actorModels: ReturnType<typeof scriptedModel>[];
  root: string;
  store: StateStore;
  retained: () => number;
  teardown: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-public-memory-owner-'));
  const store = await StateStore.open(root);
  const fixtures: MemoryProviderOwnershipFixture[] = [];
  const actorModels: ReturnType<typeof scriptedModel>[] = [];
  let retained = 0;
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 3,
    openRun: async (context) => {
      const fixture = new MemoryProviderOwnershipFixture(context, cleanupFailure);
      fixtures.push(fixture);
      return fixture;
    },
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveModel: async () => {
      const model = scriptedModel('heldApproval');
      actorModels.push(model);
      return model;
    },
    tools: {
      heldApproval: {
        description: 'Pause the actor at the existing host approval boundary.',
        execute: async () => {
          throw new Error('The stopped approval must never execute');
        },
        identity: 'memory-owner-fixture',
        inputSchema: z.object({ text: z.string() }),
        risk: 'edit',
      },
    },
  };
  const core = await HostCore.open(store, platform, () => {
    retained += 1;
    return () => {
      retained -= 1;
    };
  });
  return {
    actorModels,
    core,
    fixtures,
    retained: () => retained,
    root,
    store,
    teardown: async () => {
      for (const fixture of fixtures) {
        fixture.releaseProvider.resolve();
        fixture.releaseCancel.resolve();
      }
      await core.close().catch(() => undefined);
      await store.close();
      await rm(root, { force: true, recursive: true });
    },
  };
}

async function start(
  core: HostCore,
  threadId?: string
): Promise<{
  runId: string;
  threadId: string;
}> {
  const thread = threadId ?? (await core.startThread({ commandId: randomUUID() })).threadId;
  const approval = Promise.withResolvers<void>();
  const unsubscribe = core.onCommitted((row) => {
    if (row.threadId === thread && row.event.type === 'interaction.requested') {
      approval.resolve();
    }
  });
  try {
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Wait for the existing permission decision.',
      threadId: thread,
    });
    await approval.promise;
    return { runId, threadId: thread };
  } finally {
    unsubscribe();
  }
}

async function events(core: HostCore, threadId: string): Promise<HostEvent[]> {
  return (await core.read(threadId, 0)).map((row) => row.event);
}

test('actual host Stop joins a late observer leaf and awaited original-source cancellation', async () => {
  const host = await setup();
  try {
    const ids = await start(host.core);
    const fixture = host.fixtures[0];
    expect(fixture).toBeDefined();
    if (!fixture) {
      throw new Error('Host did not open its run owner');
    }
    const providerSignal = await fixture.providerEntered.promise;
    let acknowledged = false;
    const params = { commandId: randomUUID(), ...ids };
    const stopped = host.core.stop(params).then((result) => {
      acknowledged = true;
      return result;
    });
    stopped.catch(() => undefined);
    await fixture.ownerAborted.promise;
    await fixture.closeEntered.promise;
    expect(providerSignal?.aborted).toBe(true);
    expect(acknowledged).toBe(false);
    expect(host.retained()).toBe(1);
    expect(
      (await events(host.core, ids.threadId)).some((event) => event.type === 'run.finished')
    ).toBe(false);
    fixture.releaseProvider.resolve();
    await fixture.cancelEntered.promise;
    expect(acknowledged).toBe(false);
    expect(RootLock.inspect(host.root)).toBeDefined();
    await expect(StateStore.open(host.root)).rejects.toBeInstanceOf(RootLockedError);
    fixture.releaseCancel.resolve();
    expect(await stopped).toEqual({ outcome: 'stopped' });
    expect(await host.core.stop(params)).toEqual({ outcome: 'stopped' });
    expect(fixture.closeCalls).toBe(1);
    expect(host.retained()).toBe(0);
    expect(
      (await events(host.core, ids.threadId)).filter((event) => event.type === 'run.finished')
    ).toHaveLength(1);
  } finally {
    await host.teardown();
  }
});

// The first failing receipt is retained in the worker packet. The host now
// heals its exact interrupted occurrence in the provider view before SDK conversion.
test('a stopped approval allows the next same-thread provider call with committed history intact', async () => {
  const host = await setup();
  let unsubscribe = (): void => undefined;
  try {
    const first = await start(host.core);
    const firstOwner = host.fixtures[0];
    if (!firstOwner) {
      throw new Error('First owner is missing');
    }
    await firstOwner.providerEntered.promise;
    const stopped = host.core.stop({ commandId: randomUUID(), ...first });
    await firstOwner.closeEntered.promise;
    firstOwner.releaseProvider.resolve();
    firstOwner.releaseCancel.resolve();
    await stopped;
    const original = await host.core.read(first.threadId, 0);

    const finished = Promise.withResolvers<Extract<HostEvent, { type: 'run.finished' }>>();
    unsubscribe = host.core.onCommitted((row) => {
      if (row.threadId === first.threadId && row.event.type === 'run.finished') {
        finished.resolve(row.event);
      }
    });
    const second = await host.core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Continue on the stopped thread.',
      threadId: first.threadId,
    });
    const secondOwner = host.fixtures[1];
    if (!secondOwner) {
      throw new Error('Second owner is missing');
    }
    secondOwner.releaseProvider.resolve();
    secondOwner.releaseCancel.resolve();
    await expect
      .poll(async () =>
        (await events(host.core, first.threadId)).some(
          (event) => event.type === 'interaction.requested' && event.runId === second.runId
        )
      )
      .toBe(true);
    expect(host.actorModels[1]?.doStreamCalls).toHaveLength(1);
    expect((await host.core.read(first.threadId, 0)).slice(0, original.length)).toEqual(original);
    await host.core.stop({ commandId: randomUUID(), ...second, threadId: first.threadId });
    const terminal = await finished.promise;
    expect(terminal.runId).toBe(second.runId);
    expect(terminal.outcome).toBe('stopped');
    expect(host.retained()).toBe(0);
  } finally {
    unsubscribe();
    await host.teardown();
  }
});

test('a joined source cancellation failure is the stopped run’s visible detail and releases ownership', async () => {
  const failure = new Error('Original observer source cancellation failed');
  const host = await setup(failure);
  try {
    const ids = await start(host.core);
    const fixture = host.fixtures[0];
    if (!fixture) {
      throw new Error('Host did not open its run owner');
    }
    await fixture.providerEntered.promise;
    const params = { commandId: randomUUID(), ...ids };
    const stopped = host.core.stop(params);
    stopped.catch(() => undefined);
    await fixture.closeEntered.promise;
    fixture.releaseProvider.resolve();
    await fixture.cancelEntered.promise;
    fixture.releaseCancel.resolve();
    // The raw source physically joined; its failed cancellation is the run's
    // visible outcome, and Stop replays the same acknowledged result.
    await expect(stopped).resolves.toEqual({ outcome: 'stopped' });
    await expect(host.core.stop(params)).resolves.toEqual({ outcome: 'stopped' });
    expect(host.retained()).toBe(0);
    const finished = (await events(host.core, ids.threadId)).find(
      (event) => event.type === 'run.finished'
    );
    expect(finished).toMatchObject({
      detail: expect.stringContaining(failure.message),
      outcome: 'stopped',
    });
  } finally {
    await host.teardown();
  }
});

test('a subsequent thread run receives a fresh owner and signal', async () => {
  const host = await setup();
  try {
    const first = await start(host.core);
    const firstOwner = host.fixtures[0];
    if (!firstOwner) {
      throw new Error('First owner is missing');
    }
    await firstOwner.providerEntered.promise;
    const firstStop = host.core.stop({ commandId: randomUUID(), ...first });
    await firstOwner.closeEntered.promise;
    firstOwner.releaseProvider.resolve();
    firstOwner.releaseCancel.resolve();
    await firstStop;
    const second = await start(host.core);
    const secondOwner = host.fixtures[1];
    if (!secondOwner) {
      throw new Error('Second owner is missing');
    }
    await secondOwner.providerEntered.promise;
    expect(secondOwner.context.runId).not.toBe(firstOwner.context.runId);
    expect(secondOwner.context.signal).not.toBe(firstOwner.context.signal);
    expect(firstOwner.context.signal.aborted).toBe(true);
    expect(secondOwner.context.signal.aborted).toBe(false);
    const secondStop = host.core.stop({ commandId: randomUUID(), ...second });
    await secondOwner.closeEntered.promise;
    secondOwner.releaseProvider.resolve();
    secondOwner.releaseCancel.resolve();
    await secondStop;
    expect(host.fixtures).toHaveLength(2);
    expect(host.retained()).toBe(0);
  } finally {
    await host.teardown();
  }
});
