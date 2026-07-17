/**
 * Dump/load pipeline unit tests (stubbed databases): phase ordering, dump
 * hand-off, close-on-failure, and error propagation. The real-engine proof
 * lives in browser-first-run-bootstrap.integration.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type FirstRunBootstrapDb,
  runFirstRunBootstrapPipeline,
} from '../src/browser-first-run-bootstrap-pipeline.js';

const DUMP = new Blob(['migrated-datadir']);

interface Harness {
  readonly calls: string[];
  readonly closeErrors: Array<{ stage: string; error: unknown }>;
  readonly deps: Parameters<typeof runFirstRunBootstrapPipeline>[1];
  readonly loadArgs: Array<{ dataDir: string; dump: Blob | File }>;
}

function createHarness(
  overrides: {
    dumpDataDir?: () => Promise<Blob>;
    memoryClose?: () => Promise<void>;
    storeClose?: () => Promise<void>;
    syncToFs?: () => Promise<void>;
  } = {}
): Harness {
  const calls: string[] = [];
  const loadArgs: Array<{ dataDir: string; dump: Blob | File }> = [];
  const closeErrors: Array<{ stage: string; error: unknown }> = [];

  const memoryDb: FirstRunBootstrapDb = {
    close: async () => {
      calls.push('memory.close');
      await overrides.memoryClose?.();
    },
    dumpDataDir: async () => {
      calls.push('memory.dumpDataDir');
      if (overrides.dumpDataDir) {
        return await overrides.dumpDataDir();
      }
      return DUMP;
    },
    syncToFs: async () => undefined,
  };

  const storeDb: FirstRunBootstrapDb = {
    close: async () => {
      calls.push('store.close');
      await overrides.storeClose?.();
    },
    dumpDataDir: async () => new Blob([]),
    syncToFs: async () => {
      calls.push('store.syncToFs');
      await overrides.syncToFs?.();
    },
  };

  return {
    calls,
    closeErrors,
    deps: {
      createMemoryDb: async () => {
        calls.push('createMemoryDb');
        return memoryDb;
      },
      createStoreLoadDb: async (dataDir: string, dump: Blob | File) => {
        calls.push('createStoreLoadDb');
        loadArgs.push({ dataDir, dump });
        return storeDb;
      },
      migrateDatabase: async () => {
        calls.push('migrateDatabase');
      },
      onCloseError: (stage, error) => {
        closeErrors.push({ error, stage });
      },
    },
    loadArgs,
  };
}

describe('runFirstRunBootstrapPipeline', () => {
  it('runs migrate → dump → load → strict flush and closes both databases', async () => {
    const harness = createHarness();

    await runFirstRunBootstrapPipeline('idb://pipeline-unit', harness.deps);

    expect(harness.calls).toEqual([
      'createMemoryDb',
      'migrateDatabase',
      'memory.dumpDataDir',
      'memory.close',
      'createStoreLoadDb',
      'store.syncToFs',
      'store.close',
    ]);
    expect(harness.loadArgs).toEqual([{ dataDir: 'idb://pipeline-unit', dump: DUMP }]);
  });

  it('closes the memory database when migration fails and propagates the error', async () => {
    const harness = createHarness();
    const deps = {
      ...harness.deps,
      migrateDatabase: vi.fn().mockRejectedValue(new Error('migration exploded')),
    };

    await expect(runFirstRunBootstrapPipeline('idb://pipeline-unit', deps)).rejects.toThrow(
      'migration exploded'
    );
    expect(harness.calls).toContain('memory.close');
    expect(harness.calls).not.toContain('createStoreLoadDb');
  });

  it('closes the store database when the strict flush fails and propagates the error', async () => {
    const harness = createHarness({ syncToFs: () => Promise.reject(new Error('flush exploded')) });

    await expect(runFirstRunBootstrapPipeline('idb://pipeline-unit', harness.deps)).rejects.toThrow(
      'flush exploded'
    );
    expect(harness.calls).toContain('store.close');
  });

  it('reports close failures as non-fatal via onCloseError', async () => {
    const harness = createHarness({
      memoryClose: () => Promise.reject(new Error('memory close failed')),
    });

    await runFirstRunBootstrapPipeline('idb://pipeline-unit', harness.deps);

    expect(harness.closeErrors).toHaveLength(1);
    expect(harness.closeErrors[0]?.stage).toBe('memory');
  });
});
