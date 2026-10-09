import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform, HostRunAdmission } from '../src/ports.js';
import { HOST_RESULT_SCHEMAS, type HostEvent, type HostResults } from '../src/protocol.js';
import { scriptedModel } from './fixtures/scripted-model.js';

type MemoryRead = HostResults['thread/memory/read'];
const MODEL = 'openai::gpt-6-sol';
const AWAITING: MemoryRead = {
  admission: { ready: true },
  observational: { reason: 'no-hosted-chat-provider', state: 'awaiting-observer' },
};

function platform(overrides: Partial<HostPlatform>): HostPlatform {
  return {
    close: async () => undefined,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    ...overrides,
  };
}

/** An admission whose run pauses for an approval of an edit, so it stays active. */
function pausingAdmission(overrides: Partial<HostRunAdmission> = {}): HostRunAdmission {
  return {
    configuration: { provider: 'openai' },
    model: scriptedModel('write_file'),
    snapshot: { configuration: {}, maxSteps: 2, toolIdentities: { write_file: 'write-1' } },
    tools: {
      write_file: {
        description: 'Write a permitted file',
        execute: async () => ({ written: true }),
        identity: 'write-1',
        inputSchema: z.object({ text: z.string() }),
        risk: 'edit',
      },
    },
    ...overrides,
  };
}

async function committed<T extends HostEvent['type']>(
  core: HostCore,
  threadId: string,
  type: T
): Promise<Extract<HostEvent, { type: T }>> {
  let event: Extract<HostEvent, { type: T }> | undefined;
  await expect
    .poll(async () => {
      event = (await core.read(threadId, 0))
        .map((row) => row.event)
        .find((candidate): candidate is Extract<HostEvent, { type: T }> => candidate.type === type);
      return event !== undefined;
    })
    .toBe(true);
  if (!event) {
    throw new Error(`Expected a committed ${type}`);
  }
  return event;
}

async function withStore(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-memory-read-'));
  try {
    await body(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function withCore(
  root: string,
  host: HostPlatform,
  body: (core: HostCore) => Promise<void>
): Promise<void> {
  const store = await StateStore.open(root);
  const core = await HostCore.open(store, host, () => () => undefined);
  try {
    await body(core);
  } finally {
    await core.close();
    await store.close();
  }
}

test('a read evaluates run/start’s request with the pure preconditions and admits nothing', async () => {
  const admitRun = vi.fn<NonNullable<HostPlatform['admitRun']>>();
  const readMemoryReadiness = vi.fn<NonNullable<HostPlatform['readMemoryReadiness']>>(
    async () => AWAITING
  );
  await withStore((root) =>
    withCore(root, platform({ admitRun, readMemoryReadiness }), async (core) => {
      const { threadId } = await core.startThread({ commandId: randomUUID() });
      const configuration = { memorySettings: { semanticRecall: { enabled: true } } };
      const result = await core.readThreadMemory({ configuration, modelId: MODEL, threadId });
      expect(HOST_RESULT_SCHEMAS['thread/memory/read'].parse(result)).toEqual(AWAITING);
      const [request, readThread] = readMemoryReadiness.mock.calls[0] ?? [];
      expect(request).toMatchObject({ configuration, modelId: MODEL, threadId });
      expect(request?.prompt).toBeUndefined();
      expect(readThread).toBe(threadId);
      expect(admitRun).not.toHaveBeenCalled();
      // Nothing is committed: the log holds only the thread's own start.
      expect((await core.read(threadId, 0)).map((row) => row.event.type)).toEqual([
        'command.accepted',
        'thread.started',
      ]);
    })
  );
});

test('a read never queues behind a send whose admission is still in flight', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<HostRunAdmission>();
  const host = platform({
    admitRun: async () => {
      entered.resolve();
      return await release.promise;
    },
    readMemoryReadiness: async () => AWAITING,
  });
  await withStore((root) =>
    withCore(root, host, async (core) => {
      const { threadId } = await core.startThread({ commandId: randomUUID() });
      const send = core.startRun({
        commandId: randomUUID(),
        modelId: MODEL,
        prompt: 'hi',
        threadId,
      });
      await entered.promise;
      // The send holds the command queue until its admission settles; the read
      // must answer first, or this test deadlocks.
      expect(await core.readThreadMemory({ modelId: MODEL, threadId })).toEqual(AWAITING);
      release.reject(new Error('The send was only here to hold the queue'));
      await expect(send).rejects.toThrow('The send was only here to hold the queue');
    })
  );
}, 15_000);

test('during an active run the read answers from that run’s own admission', async () => {
  const admitted = vi.fn();
  const readMemoryReadiness = vi.fn<NonNullable<HostPlatform['readMemoryReadiness']>>();
  const readObservation = vi.fn(async () => ({ record: null, state: 'active' as const }));
  const host = platform({
    admitRun: async (request) => {
      admitted(request);
      return pausingAdmission({ readObservation });
    },
    readMemoryReadiness,
  });
  await withStore((root) =>
    withCore(root, host, async (core) => {
      const { threadId } = await core.startThread({ commandId: randomUUID() });
      await core.startRun({ commandId: randomUUID(), modelId: MODEL, prompt: 'Write', threadId });
      await committed(core, threadId, 'interaction.requested');
      expect(await core.readThreadMemory({ modelId: MODEL, threadId })).toEqual({
        admission: { ready: true },
        observational: { record: null, state: 'active' },
      });
      expect(admitted).toHaveBeenCalledTimes(1);
      expect(readObservation).toHaveBeenCalledWith(threadId);
      expect(readMemoryReadiness).not.toHaveBeenCalled();
    })
  );
});

test('a paused run whose admission is not open reads its committed snapshot, never a throw', async () => {
  await withStore(async (root) => {
    let threadId = '';
    let snapshot: Extract<HostEvent, { type: 'run.started' }>['snapshot'] | undefined;
    await withCore(root, platform({ admitRun: async () => pausingAdmission() }), async (core) => {
      ({ threadId } = await core.startThread({ commandId: randomUUID() }));
      await core.startRun({ commandId: randomUUID(), modelId: MODEL, prompt: 'Write', threadId });
      snapshot = (await committed(core, threadId, 'run.started')).snapshot;
      await committed(core, threadId, 'interaction.requested');
    });
    // After a restart the paused run is recovered without reopening its selection.
    const readMemoryReadiness = vi.fn<NonNullable<HostPlatform['readMemoryReadiness']>>(
      async () => AWAITING
    );
    const admitRun = vi.fn<NonNullable<HostPlatform['admitRun']>>();
    await withCore(root, platform({ admitRun, readMemoryReadiness }), async (core) => {
      expect(
        await core.readThreadMemory({
          configuration: { ignored: true },
          modelId: 'other',
          threadId,
        })
      ).toEqual(AWAITING);
      const [request] = readMemoryReadiness.mock.calls[0] ?? [];
      expect(request).toMatchObject({ modelId: MODEL, snapshot, threadId });
      expect(request?.configuration).toBeUndefined();
      expect(admitRun).not.toHaveBeenCalled();
    });
  });
});

test('an unknown thread has no memory readiness', async () => {
  await withStore((root) =>
    withCore(root, platform({ readMemoryReadiness: async () => AWAITING }), async (core) => {
      await expect(
        core.readThreadMemory({ modelId: MODEL, threadId: randomUUID() })
      ).rejects.toThrow('Unknown thread');
    })
  );
});
