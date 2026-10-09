import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { HostCore } from '../src/core.js';
import { createProductionHostPlatform } from '../src/production-platform.js';
import { scriptedToolSequence } from '../src/test-fixtures/scripted-model.js';

const RUNS = 6;
const modelId = 'gpt-6-sol';
const configuration: RuntimeData = { model: modelId, provider: 'openai' };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

setFlagsFromString('--expose-gc');
const collectGarbage = runInNewContext('gc') as () => void;

/**
 * The desktop host's admission keeps each run's Memory owner by run ID, and
 * Core keeps every run. A seeded desktop host held one public Memory, with its
 * xxhash WebAssembly instance, per finished run until "Cannot allocate Wasm
 * memory for new instance": each later instantiation forced a full GC first.
 */
test('a finished production run releases its admission, its Memory and their WebAssembly', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  let instantiated = 0;
  let collected = 0;
  const wasm = new FinalizationRegistry<undefined>(() => {
    collected += 1;
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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-production-release-')));
  const store = await StateStore.open(root, {
    memoryCalculatorModule: join(
      import.meta.dirname,
      '../dist/adapters/memory-storage-calculator.js'
    ),
  });
  const platform = await createProductionHostPlatform({
    close: async () => undefined,
    readConfiguration: async () => ({
      configuration,
      durableConfiguration: { model: modelId, provider: 'openai' },
      maxSteps: 3,
      memory: {
        native: {
          options: {
            lastMessages: 7,
            observationalMemory: false,
            semanticRecall: false,
            workingMemory: { enabled: true, scope: 'resource' },
          },
        },
        observerModelId: 'openai::gpt-4.1-mini',
        recordPrompt: async () => undefined,
        resourceId: 'production-release-fixture',
      },
      providerRequestContext: {
        inputTokenLimit: 50_000,
        provider: 'openai',
        runtimeData: configuration,
      },
      resolvedToolResultBudget: resolveScaledToolResultBudget(20_000),
      tools: {},
      toolTimeoutMs: 10_000,
    }),
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveModel: async () => scriptedToolSequence([]),
    resolveProviderAuth: async () => undefined,
    startup: { register: async () => undefined, signal: new AbortController().signal, store },
  });
  const core = await HostCore.open(store, platform, () => () => undefined);
  cleanup.push(async () => {
    await core.close();
    await platform.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  for (let run = 1; run <= RUNS; run += 1) {
    await core.startRun({
      commandId: randomUUID(),
      modelId: `openai::${modelId}`,
      prompt: `Production release turn ${run}.`,
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
  const outcomes = (await core.read(threadId, 0)).flatMap((row) =>
    row.event.type === 'run.finished' ? [row.event.outcome] : []
  );
  expect(outcomes).toEqual(new Array(RUNS).fill('completed'));
  expect(instantiated).toBeGreaterThanOrEqual(RUNS);
  // Once the host is idle, nothing a finished run instantiated is reachable.
  await expect
    .poll(
      async () => {
        collectGarbage();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return instantiated - collected;
      },
      { timeout: 10_000 }
    )
    .toBe(0);
  expect(unhandled).toEqual([]);
}, 120_000);
