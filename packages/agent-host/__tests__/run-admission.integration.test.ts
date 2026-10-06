import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { RootLock, StateStore } from '@brainstrike/state-store';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform, HostRunAdmission, HostRunAdmissionRequest } from '../src/ports.js';
import type { HostEvent } from '../src/protocol.js';
import { scriptedModel } from './fixtures/scripted-model.js';

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
    throw new Error('Expected committed event');
  }
  return event;
}

test('an approved live run retains its admitted model, executor and step limit after platform edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-run-selection-'));
  const store = await StateStore.open(root);
  const model = scriptedModel('write_file');
  const resolveModel = vi.fn(async () => model);
  const replacement = vi.fn(async () => null);
  const tools: HostPlatform['tools'] = {
    write_file: {
      description: 'Write a permitted file',
      execute: async (input) => {
        await writeFile(join(root, 'result.txt'), z.object({ text: z.string() }).parse(input).text);
        return { written: true };
      },
      identity: 'native-write-generation-1',
      inputSchema: z.object({ text: z.string() }),
      risk: 'edit',
    },
  };
  let currentTools = tools;
  let maxSteps = 3;
  const platform: HostPlatform = {
    close: async () => undefined,
    get maxSteps() {
      return maxSteps;
    },
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel,
    get tools() {
      return currentTools;
    },
  };
  const core = await HostCore.open(store, platform, () => () => undefined);
  try {
    const { threadId } = await core.startThread({ commandId: randomUUID() });
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Write',
      threadId,
    });
    const pending = await committed(core, threadId, 'interaction.requested');
    const previous = tools['write_file'];
    if (!previous) {
      throw new Error('Missing fixture executor');
    }
    currentTools = {
      write_file: { ...previous, execute: replacement, identity: 'native-write-generation-2' },
    };
    maxSteps = 1;
    await core.respond({
      commandId: randomUUID(),
      decision: 'approve',
      interactionId: pending.interactionId,
      runId,
      threadId,
    });
    expect((await committed(core, threadId, 'run.finished')).outcome).toBe('completed');
    expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('written by permitted host tool');
    expect(resolveModel).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(2);
    expect((await committed(core, threadId, 'run.started')).snapshot).toMatchObject({
      maxSteps: 3,
      toolIdentities: { write_file: 'native-write-generation-1' },
    });
  } finally {
    await core.close();
    await store.close();
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    await rm(root, { force: true, recursive: true });
  }
});

test('provider preparation uses the admitted configuration across approval and reopened selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-run-config-'));
  let store = await StateStore.open(root);
  const model = scriptedModel('write_file');
  const prepared: Readonly<RuntimeData>[] = [];
  const reopened: HostRunAdmissionRequest[] = [];
  let currentSettings = { temperature: 0.25 };
  let toolIdentity = 'configured-tool-generation-1';
  let effects = 0;
  const platform: HostPlatform = {
    admitRun: async (request): Promise<HostRunAdmission> => {
      reopened.push(request);
      const configuration: RuntimeData = request.snapshot
        ? {
            modelSettings: z
              .object({ temperature: z.number() })
              .parse(request.snapshot.configuration['modelSettings']),
            provider: 'openai',
          }
        : { modelSettings: currentSettings, provider: 'openai' };
      return {
        configuration,
        model,
        provider: {
          prepare: async ({ configuration: selected, messages }) => {
            prepared.push(selected);
            return {
              messages: [...messages],
              model,
              temperature: selected.modelSettings?.temperature ?? 0,
            };
          },
        },
        snapshot: {
          configuration: { modelSettings: { ...configuration.modelSettings }, provider: 'openai' },
          maxSteps: 3,
          toolIdentities: { write_file: toolIdentity },
        },
        tools: {
          write_file: {
            description: 'Count a permitted effect',
            execute: async () => {
              effects += 1;
              return { executed: true };
            },
            identity: toolIdentity,
            inputSchema: z.object({ text: z.string() }),
            risk: 'edit',
          },
        },
      };
    },
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => {
      throw new Error('Production selection must use admission');
    },
    tools: {},
  };
  let core = await HostCore.open(store, platform, () => () => undefined);
  try {
    const { threadId } = await core.startThread({ commandId: randomUUID() });
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Write',
      threadId,
    });
    const pending = await committed(core, threadId, 'interaction.requested');
    currentSettings.temperature = 0.9;
    await core.close();
    await store.close();
    currentSettings = { temperature: 1 };
    store = await StateStore.open(root);
    core = await HostCore.open(store, platform, () => () => undefined);
    await core.respond({
      commandId: randomUUID(),
      decision: 'approve',
      interactionId: pending.interactionId,
      runId,
      threadId,
    });
    expect((await committed(core, threadId, 'run.finished')).outcome).toBe('completed');
    expect(effects).toBe(1);
    expect(prepared.map((configuration) => configuration.modelSettings?.temperature)).toEqual([
      0.25, 0.25,
    ]);
    expect(model.doStreamCalls.map((call) => call.temperature)).toEqual([0.25, 0.25]);
    expect(reopened[1]?.snapshot?.configuration).toEqual({
      modelSettings: { temperature: 0.25 },
      provider: 'openai',
    });

    const second = await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Write again',
      threadId,
    });
    const rows = await core.read(threadId, 0);
    await expect
      .poll(async () =>
        (await core.read(threadId, rows.length)).some(
          (row) => row.event.type === 'interaction.requested' && row.event.runId === second.runId
        )
      )
      .toBe(true);
    const nextPending = (await core.read(threadId, rows.length))
      .map((row) => row.event)
      .find((event) => event.type === 'interaction.requested');
    if (!nextPending) {
      throw new Error('Missing second approval');
    }
    await core.close();
    await store.close();
    toolIdentity = 'configured-tool-generation-2';
    store = await StateStore.open(root);
    core = await HostCore.open(store, platform, () => () => undefined);
    await expect(
      core.respond({
        commandId: randomUUID(),
        decision: 'approve',
        interactionId: nextPending.interactionId,
        runId: second.runId,
        threadId,
      })
    ).rejects.toThrow();
    expect(effects).toBe(1);
  } finally {
    await core.close();
    await store.close();
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    await rm(root, { force: true, recursive: true });
  }
});

test('admission and execution share cancellation, and Stop retains selected resources until completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-run-cancel-'));
  const store = await StateStore.open(root);
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const nativeCompletion = Promise.withResolvers<void>();
  const model = scriptedModel('write_file');
  let admittedSignal: AbortSignal | undefined;
  let invalidCatalog = true;
  const closeSelection = vi.fn(async () => {
    if (!invalidCatalog) {
      await nativeCompletion.promise;
    }
  });
  const platform: HostPlatform = {
    admitRun: async ({ signal }) => {
      admittedSignal = signal;
      return {
        close: closeSelection,
        configuration: {},
        model,
        openRun: async (context) => {
          expect(context.signal).toBe(signal);
          return { close: async () => undefined };
        },
        snapshot: {
          configuration: {},
          maxSteps: 3,
          toolIdentities: { write_file: invalidCatalog ? 'different-executor' : 'native-write-1' },
        },
        tools: {
          write_file: {
            description: 'Hold an already-started native operation',
            execute: async (_input, context) => {
              expect(context.signal).toBe(signal);
              signal.addEventListener('abort', () => aborted.resolve(), { once: true });
              started.resolve();
              await nativeCompletion.promise;
              signal.throwIfAborted();
              return { written: true };
            },
            identity: 'native-write-1',
            inputSchema: z.object({ text: z.string() }),
            risk: 'edit',
          },
        },
      };
    },
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => model,
    tools: {},
  };
  const core = await HostCore.open(store, platform, () => () => undefined);
  try {
    const { threadId } = await core.startThread({ commandId: randomUUID() });
    const input = { modelId: 'scripted', prompt: 'Write', threadId };
    await expect(core.startRun({ commandId: randomUUID(), ...input })).rejects.toThrow(
      'Admitted tool catalog does not match'
    );
    expect(closeSelection).toHaveBeenCalledTimes(1);
    invalidCatalog = false;
    const { runId } = await core.startRun({ commandId: randomUUID(), ...input });
    const pending = await committed(core, threadId, 'interaction.requested');
    const approval = core.respond({
      commandId: randomUUID(),
      decision: 'approve',
      interactionId: pending.interactionId,
      runId,
      threadId,
    });
    await started.promise;
    let joined = false;
    const stopping = core.stop({ commandId: randomUUID(), runId, threadId }).then((result) => {
      joined = true;
      return result;
    });
    await aborted.promise;
    expect(admittedSignal?.aborted).toBe(true);
    expect(joined).toBe(false);
    expect((await core.read(threadId, 0)).some((row) => row.event.type === 'run.finished')).toBe(
      false
    );
    nativeCompletion.resolve();
    await Promise.all([approval, stopping]);
    expect((await committed(core, threadId, 'run.finished')).outcome).toBe('stopped');
    expect(closeSelection).toHaveBeenCalledTimes(2);
  } finally {
    nativeCompletion.resolve();
    await core.close();
    await store.close();
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    await rm(root, { force: true, recursive: true });
  }
});
