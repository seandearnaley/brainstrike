import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { hostMemoryTools } from '../src/adapters/memory-tools.js';
import {
  StateStoreHostMemory,
  type StateStoreHostMemoryOptions,
} from '../src/adapters/state-store-host-memory.js';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';
import { scriptedModel } from './fixtures/scripted-model.js';

const RUNS = 6;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

setFlagsFromString('--expose-gc');
const collectGarbage = runInNewContext('gc') as () => void;

/** The observer's recorded stream: one observation and its usage. */
const observer = new MockLanguageModelV4({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunkDelayInMs: null,
      chunks: [
        { type: 'stream-start', warnings: [] },
        { id: 'observation', type: 'text-start' },
        {
          delta: '<observations>\n- Paris.\n</observations>',
          id: 'observation',
          type: 'text-delta',
        },
        { id: 'observation', type: 'text-end' },
        {
          finishReason: { raw: 'stop', unified: 'stop' },
          type: 'finish',
          usage: {
            inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 4, total: 4 },
            outputTokens: { reasoning: 0, text: 1, total: 1 },
          },
        },
      ],
      initialDelayInMs: null,
    }),
  }),
});

/**
 * Each public Memory (and its observational memory) instantiates its own
 * xxhash WebAssembly module. A long-lived host that kept finished runs' Memory
 * reachable exhausted the process's WebAssembly memory after a few hundred
 * runs ("Cannot allocate Wasm memory for new instance").
 */
test('a finished run releases its public Memory and the WebAssembly it instantiated', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  let instantiated = 0;
  let collectedWasm = 0;
  const wasm = new FinalizationRegistry<undefined>(() => {
    collectedWasm += 1;
  });
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = function (this: unknown, ...args: unknown[]) {
    instantiated += 1;
    const result = Reflect.apply(instantiate, this, args) as Promise<{ instance: object }>;
    return result.then((value) => {
      wasm.register(value.instance, undefined);
      return value;
    });
  } as typeof WebAssembly.instantiate;
  cleanup.push(async () => {
    WebAssembly.instantiate = instantiate;
    process.off('unhandledRejection', onUnhandled);
  });
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-memory-release-'));
  const store = await StateStore.open(root, {
    memoryCalculatorModule: fileURLToPath(
      new URL('../dist/adapters/memory-storage-calculator.js', import.meta.url)
    ),
  });
  let opened = 0;
  let collectedMemory = 0;
  const memories = new FinalizationRegistry<undefined>(() => {
    collectedMemory += 1;
  });
  const resourceId = randomUUID();
  const native: StateStoreHostMemoryOptions['native'] = {
    options: {
      lastMessages: 10,
      observationalMemory: {
        model: observer,
        observation: { bufferOnIdle: false, bufferTokens: false, messageTokens: 30 },
        reflection: { observationTokens: 50_000 },
      },
      semanticRecall: false,
      workingMemory: { enabled: true, scope: 'thread' },
    },
  };
  const model = scriptedModel();
  const platform: HostPlatform = {
    // The production composition: Memory's own tools at admission, Memory per run.
    admitRun: async () => {
      const tools = hostMemoryTools(native, () =>
        Promise.reject(new Error('This proof calls no Memory tool'))
      );
      return {
        configuration: {},
        model,
        provider: { prepare: async ({ messages }) => ({ messages: [...messages], model }) },
        snapshot: {
          configuration: {},
          maxSteps: 3,
          toolIdentities: Object.fromEntries(
            Object.entries(tools).map(([name, tool]) => [name, tool.identity])
          ),
        },
        tools,
      };
    },
    close: async () => undefined,
    maxSteps: 3,
    openRun: async (context) => {
      const owner = await StateStoreHostMemory.open(context, {
        native,
        observerModelId: 'openai::recorded-observer',
        providerRequestContext: () => ({ inputTokenLimit: 30_000, provider: 'openai' }),
        recordObserverUsage: async () => undefined,
        recordPrompt: async () => undefined,
        resourceId,
        store,
      });
      opened += 1;
      memories.register(owner.memory, undefined);
      return owner;
    },
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveModel: async () => model,
  };
  const core = await HostCore.open(store, platform, () => () => undefined);
  cleanup.push(async () => {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  for (let run = 1; run <= RUNS; run += 1) {
    await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Paris weather. '.repeat(40),
      threadId,
    });
    await expect
      .poll(
        async () =>
          (await core.read(threadId, 0)).filter((row) => row.event.type === 'run.finished').length,
        { timeout: 30_000 }
      )
      .toBe(run);
  }
  const finished = (await core.read(threadId, 0)).filter(
    (row) => row.event.type === 'run.finished'
  );
  expect(finished.map((row) => row.event.type === 'run.finished' && row.event.outcome)).toEqual(
    new Array(RUNS).fill('completed')
  );
  expect(opened).toBe(RUNS);
  // Every finished run's Memory, and every WebAssembly instance the runs made,
  // is collectable once the host is idle: nothing grows with the run count.
  await expect
    .poll(
      async () => {
        collectGarbage();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { liveMemories: opened - collectedMemory, liveWasm: instantiated - collectedWasm };
      },
      { timeout: 10_000 }
    )
    .toEqual({ liveMemories: 0, liveWasm: 0 });
  expect(unhandled).toEqual([]);
}, 120_000);
