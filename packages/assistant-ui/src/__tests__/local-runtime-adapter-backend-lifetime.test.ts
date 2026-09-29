/**
 * BST-1861: the browser `LocalLlmBackend` is ONE module-level instance shared by
 * every mounted local-chat panel, so its lifetime cannot belong to any single
 * panel. Each test gets a fresh copy of the adapter module: a wedged run in one
 * case (the historical failure mode) must not poison the next.
 */
import type { ChatModelRunOptions, ChatModelRunResult } from '@assistant-ui/react';
import type { LocalLlmBackend, LocalLlmGenerationResult } from '@brainstrike/assistant-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/utils', () => ({
  acquireBackgroundWorkPauseReason: async () => () => {},
}));

const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';

type AdapterModule = typeof import('../local-runtime-adapter');

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function generationResult(text: string): LocalLlmGenerationResult {
  return {
    finishReason: 'stop',
    text,
    usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 },
  };
}

function createRunOptions(): ChatModelRunOptions {
  return {
    abortSignal: new AbortController().signal,
    context: {},
    messages: [
      {
        attachments: [],
        content: [{ text: 'Tell me a joke', type: 'text' }],
        createdAt: new Date('2026-04-10T00:00:00.000Z'),
        id: 'user-1',
        metadata: { custom: {} },
        role: 'user',
      },
    ],
    runConfig: {},
    unstable_getMessage() {
      throw new Error('not needed in local adapter tests');
    },
  };
}

async function collectRun(
  runResult: Promise<ChatModelRunResult> | AsyncGenerator<ChatModelRunResult, void>
): Promise<ChatModelRunResult[]> {
  if (!(Symbol.asyncIterator in runResult)) {
    return [await runResult];
  }
  const updates: ChatModelRunResult[] = [];
  for await (const update of runResult) {
    updates.push(update);
  }
  return updates;
}

function finalText(updates: readonly ChatModelRunResult[]): string {
  const parts = updates.at(-1)?.content ?? [];
  return parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

/**
 * The runtime shape of `LocalLlmBackend` (packages/agent local-llm-backend.ts):
 * `generate` throws until `initialize` has run, `dispose` drops the engine so
 * `isReady()` turns false, and a repeated `initialize` for a ready model is a
 * no-op. A fresh instance per `loadBackend()` call, exactly as the web loader
 * constructs one.
 */
function createLoader(
  options: { gateInitialize?: Deferred<void>; gateLoad?: Deferred<void> } = {}
) {
  const instances: LocalLlmBackend[] = [];
  // Every `generate` call of every instance, in call order.
  const generations: Deferred<LocalLlmGenerationResult>[] = [];
  const loadBackend = vi.fn(async (): Promise<LocalLlmBackend> => {
    await options.gateLoad?.promise;
    let ready = false;
    const backend: LocalLlmBackend = {
      dispose: vi.fn(async () => {
        ready = false;
      }),
      generate: vi.fn(async () => {
        if (!ready) {
          throw new Error('Model not initialized. Call initialize() first.');
        }
        const generation = deferred<LocalLlmGenerationResult>();
        generations.push(generation);
        return generation.promise;
      }),
      initialize: vi.fn(async () => {
        await options.gateInitialize?.promise;
        ready = true;
      }),
      isReady: vi.fn(() => ready),
    };
    instances.push(backend);
    return backend;
  });
  return { generations, instances, loadBackend };
}

async function nextGeneration(
  generations: readonly Deferred<LocalLlmGenerationResult>[],
  index: number
): Promise<Deferred<LocalLlmGenerationResult>> {
  await vi.waitFor(() => expect(generations.length).toBeGreaterThan(index));
  const generation = generations[index];
  if (!generation) {
    throw new Error(`generation ${index} was never requested`);
  }
  return generation;
}

describe('shared local backend lifetime', () => {
  let adapter: AdapterModule;

  beforeEach(async () => {
    vi.resetModules();
    adapter = await import('../local-runtime-adapter');
  });

  // What the panel does today when ANY local-chat panel unmounts.
  const closePanel = (): Promise<void> => adapter.disposeLocalBackend();

  it('lets a generation in flight finish when another panel closes', async () => {
    const { generations, loadBackend } = createLoader();
    const panelA = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });

    const run = collectRun(panelA.run(createRunOptions()));
    const generation = await nextGeneration(generations, 0);
    void closePanel();
    generation.resolve(generationResult('A finished'));

    expect(finalText(await run)).toBe('A finished');
  });

  it('keeps the loaded backend alive when another panel closes', async () => {
    const { generations, instances, loadBackend } = createLoader();
    const panelA = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });

    const run = collectRun(panelA.run(createRunOptions()));
    const generation = await nextGeneration(generations, 0);
    void closePanel();
    generation.resolve(generationResult('A finished'));
    await run;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(instances[0]?.dispose).not.toHaveBeenCalled();
  });

  it('does not reload the model for the next turn after another panel closed', async () => {
    const { generations, instances, loadBackend } = createLoader();
    const panelA = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });

    const firstRun = collectRun(panelA.run(createRunOptions()));
    (await nextGeneration(generations, 0)).resolve(generationResult('first'));
    await firstRun;

    await closePanel();

    const secondRun = collectRun(panelA.run(createRunOptions()));
    (await nextGeneration(generations, 1)).resolve(generationResult('second'));
    await secondRun;

    expect(loadBackend).toHaveBeenCalledTimes(1);
    expect(instances[0]?.initialize).toHaveBeenCalledTimes(1);
  });

  it('does not fail a run that is still loading the backend when another panel closes', async () => {
    const gateLoad = deferred<void>();
    const { generations, loadBackend } = createLoader({ gateLoad });
    const panelA = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });

    const run = collectRun(panelA.run(createRunOptions()));
    await vi.waitFor(() => expect(loadBackend).toHaveBeenCalledTimes(1));
    void closePanel();
    gateLoad.resolve();
    (await nextGeneration(generations, 0)).resolve(generationResult('A finished'));

    expect(finalText(await run)).toBe('A finished');
  });

  it('does not wedge a run that is initializing the model when another panel closes', async () => {
    const gateInitialize = deferred<void>();
    const { generations, instances, loadBackend } = createLoader({ gateInitialize });
    const panelA = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });

    const run = collectRun(panelA.run(createRunOptions()));
    await vi.waitFor(() => expect(instances[0]?.initialize).toHaveBeenCalledTimes(1));
    void closePanel();
    gateInitialize.resolve();
    (await nextGeneration(generations, 0)).resolve(generationResult('A finished'));

    expect(finalText(await run)).toBe('A finished');
  });

  it('serves a run that starts while another panel is closing from the live backend', async () => {
    const { generations, instances, loadBackend } = createLoader();
    const panelA = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });

    const firstRun = collectRun(panelA.run(createRunOptions()));
    const firstGeneration = await nextGeneration(generations, 0);
    void closePanel();
    const secondRun = collectRun(panelA.run(createRunOptions()));
    firstGeneration.resolve(generationResult('first'));
    await firstRun;

    (await nextGeneration(generations, 1)).resolve(generationResult('second'));
    await secondRun;

    expect(loadBackend).toHaveBeenCalledTimes(1);
    expect(instances[0]?.dispose).not.toHaveBeenCalled();
  });
});
