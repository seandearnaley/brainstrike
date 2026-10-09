/**
 * Gap 17: a profile whose legacy resource observations were not imported is
 * told once per root. The committed notice is the delivered fact, so a second
 * run and a host restart commit no second one.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { expect, test } from 'vitest';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

function answer() {
  return {
    stream: simulateReadableStream({
      chunkDelayInMs: null,
      chunks: [
        { type: 'stream-start' as const, warnings: [] },
        { id: 'text-1', type: 'text-start' as const },
        { delta: 'An answer.', id: 'text-1', type: 'text-delta' as const },
        { id: 'text-1', type: 'text-end' as const },
        { finishReason: { raw: 'stop', unified: 'stop' as const }, type: 'finish' as const, usage },
      ],
      initialDelayInMs: null,
    }),
  };
}

/** Every admission carries the import's finding, as the production platform does. */
function platform(model: MockLanguageModelV4): HostPlatform {
  return {
    admitRun: async () => ({
      configuration: {},
      legacyObservationsWithheld: true,
      model,
      snapshot: { configuration: {}, maxSteps: 1, toolIdentities: {} },
      tools: {},
    }),
    close: async () => undefined,
    maxSteps: 1,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveModel: async () => model,
  };
}

test('the legacy observations notice commits once per root, across runs and a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-legacy-notice-'));
  const model = new MockLanguageModelV4({ doStream: async () => answer() });
  let store = await StateStore.open(root);
  let core = await HostCore.open(store, platform(model), () => () => undefined);
  const threads: string[] = [];
  const run = async (threadId: string): Promise<string> => {
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Hello.',
      threadId,
    });
    await expect
      .poll(
        async () =>
          (await core.read(threadId, 0)).some(
            (row) => row.event.type === 'run.finished' && row.event.runId === runId
          ),
        { timeout: 30_000 }
      )
      .toBe(true);
    return runId;
  };
  const newThread = async (): Promise<string> => {
    const { threadId } = await core.startThread({ commandId: randomUUID() });
    threads.push(threadId);
    return threadId;
  };
  const notices = async () =>
    (await Promise.all(threads.map((threadId) => core.read(threadId, 0))))
      .flat()
      .filter((row) => row.event.type === 'memory.observation.withheld')
      .map(({ event, threadId }) => ({ event, threadId }));
  try {
    const first = await newThread();
    const firstRun = await run(first);
    const delivered = [
      {
        event: expect.objectContaining({
          reason: 'legacy-resource-observations',
          runId: firstRun,
          type: 'memory.observation.withheld',
        }),
        threadId: first,
      },
    ];
    expect(await notices()).toEqual(delivered);

    // A second run, on another thread, commits none.
    await run(await newThread());
    expect(await notices()).toEqual(delivered);

    // Nor does a run after the host restarts: the fold finds the committed notice.
    await core.close();
    await store.close();
    store = await StateStore.open(root);
    core = await HostCore.open(store, platform(model), () => () => undefined);
    await run(first);
    expect(await notices()).toEqual(delivered);
  } finally {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  }
});
