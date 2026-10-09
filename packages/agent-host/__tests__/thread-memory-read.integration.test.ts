import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform, HostRunAdmission, HostRunAdmissionRequest } from '../src/ports.js';
import { HOST_RESULT_SCHEMAS } from '../src/protocol.js';
import { scriptedModel } from './fixtures/scripted-model.js';

async function withCore(
  admitRun: (request: HostRunAdmissionRequest) => Promise<HostRunAdmission>,
  body: (core: HostCore, threadId: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-memory-read-'));
  const store = await StateStore.open(root);
  const platform: HostPlatform = {
    admitRun,
    close: async () => undefined,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
  };
  const core = await HostCore.open(store, platform, () => () => undefined);
  try {
    const { threadId } = await core.startThread({ commandId: randomUUID() });
    await body(core, threadId);
  } finally {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  }
}

function admission(overrides: Partial<HostRunAdmission> = {}): HostRunAdmission {
  return {
    configuration: { provider: 'openai' },
    model: scriptedModel(),
    snapshot: { configuration: {}, maxSteps: 1, toolIdentities: {} },
    tools: {},
    ...overrides,
  };
}

test('thread/memory/read is the run/start admission, released at once, with its observation', async () => {
  const requests: HostRunAdmissionRequest[] = [];
  const close = vi.fn(async () => undefined);
  const readObservation = vi.fn(async () => ({
    reason: 'no-hosted-chat-provider' as const,
    state: 'awaiting-observer' as const,
  }));
  await withCore(
    async (request) => {
      requests.push(request);
      return admission({ close, readObservation });
    },
    async (core, threadId) => {
      const configuration = { memorySettings: { semanticRecall: { enabled: true } } };
      const result = await core.readThreadMemory({
        configuration,
        modelId: 'openai::gpt-6-sol',
        threadId,
      });
      expect(HOST_RESULT_SCHEMAS['thread/memory/read'].parse(result)).toEqual({
        admission: { ready: true },
        observational: { reason: 'no-hosted-chat-provider', state: 'awaiting-observer' },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ configuration, modelId: 'openai::gpt-6-sol', threadId });
      expect(requests[0]?.prompt).toBeUndefined();
      expect(readObservation).toHaveBeenCalledWith(threadId);
      expect(close).toHaveBeenCalledTimes(1);
      // A read commits nothing: the log holds only the thread's own start.
      expect((await core.read(threadId, 0)).map((row) => row.event.type)).toEqual([
        'command.accepted',
        'thread.started',
      ]);
    }
  );
});

test('an admission without observational memory reads off', async () => {
  await withCore(
    async () => admission(),
    async (core, threadId) => {
      expect(await core.readThreadMemory({ modelId: 'openai::gpt-6-sol', threadId })).toEqual({
        admission: { ready: true },
        observational: { state: 'off' },
      });
    }
  );
});

test('the reason run/start would fail with is the readiness reason, before any send', async () => {
  const failure = 'The embedding host is not running.';
  await withCore(
    async () => {
      throw new Error(failure);
    },
    async (core, threadId) => {
      const result = await core.readThreadMemory({ modelId: 'openai::gpt-6-sol', threadId });
      expect(HOST_RESULT_SCHEMAS['thread/memory/read'].parse(result)).toEqual({
        admission: { ready: false, reason: failure },
      });
      await expect(
        core.startRun({
          commandId: randomUUID(),
          modelId: 'openai::gpt-6-sol',
          prompt: 'hello',
          threadId,
        })
      ).rejects.toThrow(failure);
    }
  );
});

test('an unknown thread has no memory readiness', async () => {
  await withCore(
    async () => admission(),
    async (core) => {
      await expect(
        core.readThreadMemory({ modelId: 'openai::gpt-6-sol', threadId: randomUUID() })
      ).rejects.toThrow('Unknown thread');
    }
  );
});

test('during an active run the readiness is that run’s own admission, not a second one', async () => {
  const admitted = vi.fn();
  const readObservation = vi.fn(async () => ({ record: null, state: 'active' as const }));
  await withCore(
    async (request) => {
      admitted(request);
      return admission({
        model: scriptedModel('write_file'),
        readObservation,
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
      });
    },
    async (core, threadId) => {
      await core.startRun({
        commandId: randomUUID(),
        modelId: 'openai::gpt-6-sol',
        prompt: 'Write',
        threadId,
      });
      // The run waits for an approval, so it holds its selection.
      await expect
        .poll(async () =>
          (await core.read(threadId, 0)).some((row) => row.event.type === 'interaction.requested')
        )
        .toBe(true);
      expect(await core.readThreadMemory({ modelId: 'openai::gpt-6-sol', threadId })).toEqual({
        admission: { ready: true },
        observational: { record: null, state: 'active' },
      });
      expect(admitted).toHaveBeenCalledTimes(1);
      expect(readObservation).toHaveBeenCalledWith(threadId);
    }
  );
});
