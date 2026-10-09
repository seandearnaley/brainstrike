import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import {
  StateStoreHostMemory,
  type StateStoreHostMemoryOptions,
} from '../src/adapters/state-store-host-memory.js';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';
import { scriptedModel } from './fixtures/scripted-model.js';

const RUNS_PER_THREAD = 3;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

/** Resource-scoped Memory, so every thread of the resource is the run's history. */
const native: StateStoreHostMemoryOptions['native'] = {
  options: {
    lastMessages: 10,
    observationalMemory: false,
    semanticRecall: false,
    workingMemory: { enabled: true, scope: 'resource' },
  },
};

/**
 * The rows one Memory-composed run reads from the store, after `seededThreads`
 * other threads of its resource each committed their own runs.
 */
async function rowsReadByOneRun(seededThreads: number): Promise<{ readAll: number; rows: number }> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-memory-history-'));
  const store = await StateStore.open(root, {
    memoryCalculatorModule: fileURLToPath(
      new URL('../dist/adapters/memory-storage-calculator.js', import.meta.url)
    ),
  });
  const counted = { readAll: 0, rows: 0 };
  let counting = false;
  const readAll = store.readAll.bind(store);
  const read = store.read.bind(store);
  store.readAll = async () => {
    const rows = await readAll();
    if (counting) {
      counted.readAll += 1;
      counted.rows += rows.length;
    }
    return rows;
  };
  store.read = async (...args: Parameters<StateStore['read']>) => {
    const rows = await read(...args);
    if (counting) {
      counted.rows += rows.length;
    }
    return rows;
  };
  const model = scriptedModel();
  const platform: HostPlatform = {
    admitRun: async () => ({
      configuration: {},
      model,
      provider: { prepare: async ({ messages }) => ({ messages: [...messages], model }) },
      snapshot: { configuration: {}, maxSteps: 3, toolIdentities: {} },
      tools: {},
    }),
    close: async () => undefined,
    maxSteps: 3,
    openRun: (context) =>
      StateStoreHostMemory.open(context, {
        native,
        providerRequestContext: () => ({ inputTokenLimit: 200_000, provider: 'openai' }),
        recordPrompt: async () => undefined,
        resourceId: 'brainstrike:workspace',
        store,
      }),
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveModel: async () => model,
  };
  const core = await HostCore.open(store, platform, () => () => undefined);
  cleanup.push(async () => {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const run = async (threadId: string, prompt: string, finished: number): Promise<void> => {
    await core.startRun({ commandId: randomUUID(), modelId: 'scripted', prompt, threadId });
    await expect
      .poll(
        async () =>
          (await core.read(threadId, 0)).filter((row) => row.event.type === 'run.finished').length,
        { timeout: 30_000 }
      )
      .toBe(finished);
  };
  for (let thread = 0; thread < seededThreads; thread += 1) {
    const { threadId } = await core.startThread({ commandId: randomUUID() });
    for (let turn = 1; turn <= RUNS_PER_THREAD; turn += 1) {
      await run(threadId, `Seeded thread ${thread}, turn ${turn}.`, turn);
    }
  }
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  counting = true;
  await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Measured.',
    threadId,
  });
  // Read the measured thread through the uncounted store, so the poll itself is not counted.
  await expect
    .poll(async () => (await read(threadId, 1)).some((row) => row.event.type === 'run.finished'), {
      timeout: 30_000,
    })
    .toBe(true);
  counting = false;
  return counted;
}

test("a Memory-composed run's store reads do not grow with its resource's history", async () => {
  const small = await rowsReadByOneRun(2);
  const large = await rowsReadByOneRun(12);
  // The run's Memory reads its resource's committed history from Core's
  // projection: the store is never scanned whole, and what the run reads from
  // it is its own thread, however much the resource's other threads hold.
  expect(large).toEqual(small);
  expect(large.readAll).toBe(0);
}, 120_000);
