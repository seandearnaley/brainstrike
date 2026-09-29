// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectRun,
  createLoader,
  createRunOptions,
  flush,
  generationResult,
  MODEL_ID,
  nextGeneration,
} from './local-backend-test-fixtures';

vi.mock('@brainstrike/utils', () => ({
  acquireBackgroundWorkPauseReason: async () => () => {},
}));

type AdapterModule = typeof import('../local-runtime-adapter');
type LeaseHook = typeof import('../use-local-backend-lease').useLocalBackendLease;

describe('useLocalBackendLease', () => {
  let adapter: AdapterModule;
  let useLocalBackendLease: LeaseHook;

  // The real adapter, fresh per test, with a backend already loaded and no lease held.
  async function loadBackend() {
    const loader = createLoader();
    const panel = adapter.createLocalModelAdapter({
      loadBackend: loader.loadBackend,
      modelId: MODEL_ID,
    });
    const run = collectRun(panel.run(createRunOptions()));
    (await nextGeneration(loader.generations, 0)).resolve(generationResult('loaded'));
    await run;
    return loader;
  }

  beforeEach(async () => {
    vi.resetModules();
    adapter = await import('../local-runtime-adapter');
    ({ useLocalBackendLease } = await import('../use-local-backend-lease'));
  });

  it("survives React StrictMode's simulated unmount and remount", async () => {
    const { instances } = await loadBackend();

    const { unmount } = renderHook(() => useLocalBackendLease(), { wrapper: StrictMode });
    await flush();

    expect(instances[0]?.dispose).not.toHaveBeenCalled();

    unmount();
    await vi.waitFor(() => expect(instances[0]?.dispose).toHaveBeenCalledTimes(1));
  });

  it('disposes only when the last mounted panel unmounts', async () => {
    const { instances } = await loadBackend();
    const first = renderHook(() => useLocalBackendLease());
    const second = renderHook(() => useLocalBackendLease());

    first.unmount();
    await flush();

    expect(instances[0]?.dispose).not.toHaveBeenCalled();

    second.unmount();
    await vi.waitFor(() => expect(instances[0]?.dispose).toHaveBeenCalledTimes(1));
  });
});
