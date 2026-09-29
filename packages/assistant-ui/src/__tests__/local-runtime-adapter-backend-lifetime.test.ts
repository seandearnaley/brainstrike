/**
 * BST-1861: the browser `LocalLlmBackend` is ONE module-level instance shared by
 * every mounted local-chat panel, so its lifetime belongs to the last panel, not
 * to whichever one closes. Each test gets a fresh copy of the adapter module: a
 * wedged run in one case (the historical failure mode) must not poison the next.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectRun,
  createLoader,
  createRunOptions,
  deferred,
  finalText,
  flush,
  generationResult,
  MODEL_ID,
  nextGeneration,
} from './local-backend-test-fixtures';

vi.mock('@brainstrike/utils', () => ({
  acquireBackgroundWorkPauseReason: async () => () => {},
}));

type AdapterModule = typeof import('../local-runtime-adapter');

describe('shared local backend lifetime', () => {
  let adapter: AdapterModule;

  beforeEach(async () => {
    vi.resetModules();
    adapter = await import('../local-runtime-adapter');
  });

  describe('while another panel is still mounted', () => {
    it('lets a generation in flight finish when the other panel closes', async () => {
      const { generations, loadBackend } = createLoader();
      const panel = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });
      adapter.acquireLocalBackend();
      const releaseOther = adapter.acquireLocalBackend();

      const run = collectRun(panel.run(createRunOptions()));
      const generation = await nextGeneration(generations, 0);
      releaseOther();
      generation.resolve(generationResult('A finished'));

      expect(finalText(await run)).toBe('A finished');
    });

    it('keeps the loaded backend alive when the other panel closes', async () => {
      const { generations, instances, loadBackend } = createLoader();
      const panel = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });
      adapter.acquireLocalBackend();
      const releaseOther = adapter.acquireLocalBackend();

      const run = collectRun(panel.run(createRunOptions()));
      const generation = await nextGeneration(generations, 0);
      releaseOther();
      generation.resolve(generationResult('A finished'));
      await run;
      await flush();

      expect(instances[0]?.dispose).not.toHaveBeenCalled();
    });

    it('does not reload the model for the next turn after the other panel closed', async () => {
      const { generations, instances, loadBackend } = createLoader();
      const panel = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });
      adapter.acquireLocalBackend();
      const releaseOther = adapter.acquireLocalBackend();

      const firstRun = collectRun(panel.run(createRunOptions()));
      (await nextGeneration(generations, 0)).resolve(generationResult('first'));
      await firstRun;

      releaseOther();
      await flush();

      const secondRun = collectRun(panel.run(createRunOptions()));
      (await nextGeneration(generations, 1)).resolve(generationResult('second'));
      await secondRun;

      expect(loadBackend).toHaveBeenCalledTimes(1);
      expect(instances[0]?.initialize).toHaveBeenCalledTimes(1);
    });

    it('does not fail a run that is still loading the backend when the other panel closes', async () => {
      const load = deferred<void>();
      const { generations, loadBackend } = createLoader({ load });
      const panel = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });
      adapter.acquireLocalBackend();
      const releaseOther = adapter.acquireLocalBackend();

      const run = collectRun(panel.run(createRunOptions()));
      await vi.waitFor(() => expect(loadBackend).toHaveBeenCalledTimes(1));
      releaseOther();
      load.resolve();
      (await nextGeneration(generations, 0)).resolve(generationResult('A finished'));

      expect(finalText(await run)).toBe('A finished');
    });

    it('does not wedge a run that is initializing the model when the other panel closes', async () => {
      const initialize = deferred<void>();
      const { generations, instances, loadBackend } = createLoader({ initialize });
      const panel = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });
      adapter.acquireLocalBackend();
      const releaseOther = adapter.acquireLocalBackend();

      const run = collectRun(panel.run(createRunOptions()));
      await vi.waitFor(() => expect(instances[0]?.initialize).toHaveBeenCalledTimes(1));
      releaseOther();
      initialize.resolve();
      (await nextGeneration(generations, 0)).resolve(generationResult('A finished'));

      expect(finalText(await run)).toBe('A finished');
    });

    it('serves a run that starts as the other panel closes from the live backend', async () => {
      const { generations, instances, loadBackend } = createLoader();
      const panel = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });
      adapter.acquireLocalBackend();
      const releaseOther = adapter.acquireLocalBackend();

      const firstRun = collectRun(panel.run(createRunOptions()));
      const firstGeneration = await nextGeneration(generations, 0);
      releaseOther();
      const secondRun = collectRun(panel.run(createRunOptions()));
      firstGeneration.resolve(generationResult('first'));
      await firstRun;

      (await nextGeneration(generations, 1)).resolve(generationResult('second'));
      await secondRun;

      expect(loadBackend).toHaveBeenCalledTimes(1);
      expect(instances[0]?.dispose).not.toHaveBeenCalled();
    });

    it('ignores a repeated release of the same lease', async () => {
      const { generations, instances, loadBackend } = createLoader();
      const panel = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });
      adapter.acquireLocalBackend();
      const releaseOther = adapter.acquireLocalBackend();

      const run = collectRun(panel.run(createRunOptions()));
      (await nextGeneration(generations, 0)).resolve(generationResult('A finished'));
      await run;
      releaseOther();
      releaseOther();
      await flush();

      expect(instances[0]?.dispose).not.toHaveBeenCalled();
    });
  });

  describe('when the last panel closes', () => {
    it('disposes the backend once, and only after the generation queue drained', async () => {
      const { generations, instances, loadBackend } = createLoader();
      const panel = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });
      const release = adapter.acquireLocalBackend();

      const run = collectRun(panel.run(createRunOptions()));
      const generation = await nextGeneration(generations, 0);
      release();
      await flush();

      expect(instances[0]?.dispose).not.toHaveBeenCalled();

      generation.resolve(generationResult('finished'));
      await run;

      await vi.waitFor(() => expect(instances[0]?.dispose).toHaveBeenCalledTimes(1));
      await flush();
      expect(instances[0]?.dispose).toHaveBeenCalledTimes(1);
    });

    it('also waits for a generation queued behind the drain', async () => {
      const { generations, instances, loadBackend } = createLoader();
      const panel = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });
      const release = adapter.acquireLocalBackend();

      const firstRun = collectRun(panel.run(createRunOptions()));
      const firstGeneration = await nextGeneration(generations, 0);
      release();
      const secondRun = collectRun(panel.run(createRunOptions()));
      firstGeneration.resolve(generationResult('first'));
      await firstRun;
      const secondGeneration = await nextGeneration(generations, 1);
      await flush();

      expect(instances[0]?.dispose).not.toHaveBeenCalled();

      secondGeneration.resolve(generationResult('second'));

      expect(finalText(await secondRun)).toBe('second');
      await vi.waitFor(() => expect(instances[0]?.dispose).toHaveBeenCalledTimes(1));
      expect(loadBackend).toHaveBeenCalledTimes(1);
    });

    it('does not wedge the run of a panel that closes while the model is initializing', async () => {
      const initialize = deferred<void>();
      const { generations, instances, loadBackend } = createLoader({ initialize });
      const panel = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });
      const release = adapter.acquireLocalBackend();

      const run = collectRun(panel.run(createRunOptions()));
      await vi.waitFor(() => expect(instances[0]?.initialize).toHaveBeenCalledTimes(1));
      release();
      initialize.resolve();
      (await nextGeneration(generations, 0)).resolve(generationResult('finished'));

      expect(finalText(await run)).toBe('finished');
      await vi.waitFor(() => expect(instances[0]?.dispose).toHaveBeenCalledTimes(1));
    });

    it('does not dispose across a synchronous release and re-acquire (StrictMode remount)', async () => {
      const { generations, instances, loadBackend } = createLoader();
      const panel = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });
      const release = adapter.acquireLocalBackend();
      const run = collectRun(panel.run(createRunOptions()));
      (await nextGeneration(generations, 0)).resolve(generationResult('first'));
      await run;

      release();
      adapter.acquireLocalBackend();
      await flush();

      expect(instances[0]?.dispose).not.toHaveBeenCalled();
    });

    it('keeps the backend for a panel that mounts while the queue is still draining', async () => {
      const { generations, instances, loadBackend } = createLoader();
      const panel = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });
      const release = adapter.acquireLocalBackend();

      const run = collectRun(panel.run(createRunOptions()));
      const generation = await nextGeneration(generations, 0);
      release();
      const releaseNext = adapter.acquireLocalBackend();
      generation.resolve(generationResult('finished'));
      await run;
      await flush();

      expect(instances[0]?.dispose).not.toHaveBeenCalled();
      expect(loadBackend).toHaveBeenCalledTimes(1);

      releaseNext();
      await vi.waitFor(() => expect(instances[0]?.dispose).toHaveBeenCalledTimes(1));
    });

    it('gives a panel that mounts while the backend is being disposed a live backend', async () => {
      const disposal = deferred<void>();
      const { generations, instances, loadBackend } = createLoader({ dispose: disposal });
      const panel = adapter.createLocalModelAdapter({ loadBackend, modelId: MODEL_ID });
      const release = adapter.acquireLocalBackend();
      const firstRun = collectRun(panel.run(createRunOptions()));
      (await nextGeneration(generations, 0)).resolve(generationResult('first'));
      await firstRun;

      release();
      await vi.waitFor(() => expect(instances[0]?.dispose).toHaveBeenCalledTimes(1));
      adapter.acquireLocalBackend();
      const secondRun = collectRun(panel.run(createRunOptions()));
      await flush();

      expect(loadBackend).toHaveBeenCalledTimes(1);

      disposal.resolve();
      (await nextGeneration(generations, 1)).resolve(generationResult('second'));

      expect(finalText(await secondRun)).toBe('second');
      expect(loadBackend).toHaveBeenCalledTimes(2);
      expect(instances[1]?.dispose).not.toHaveBeenCalled();
    });
  });

  describe('with the desktop llm-host bridge', () => {
    it('keeps the warmed-model cache when another panel closes', async () => {
      const warmup = vi.fn().mockResolvedValue(undefined);
      const generate = vi.fn().mockResolvedValue(generationResult('hosted'));
      Object.assign(window, {
        llmHost: {
          generate,
          onProgress: vi.fn(() => () => {}),
          onStatus: vi.fn(() => () => {}),
          warmup,
        },
      });
      try {
        const panel = adapter.createLocalModelAdapter({ modelId: MODEL_ID });
        adapter.acquireLocalBackend();
        const releaseOther = adapter.acquireLocalBackend();

        await collectRun(panel.run(createRunOptions()));
        releaseOther();
        await flush();
        await collectRun(panel.run(createRunOptions()));

        expect(warmup).toHaveBeenCalledTimes(1);
        expect(generate).toHaveBeenCalledTimes(2);
      } finally {
        Object.assign(window, { llmHost: undefined });
      }
    });
  });
});
