import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceIndexStageApi } from '../workspace-index-stage-harness';

vi.mock('../workspace-index-debug-benchmark', () => ({
  runWorkspaceIndexStageBenchmark: vi.fn(async (args: unknown) => args),
}));

import { runWorkspaceIndexStageBenchmark } from '../workspace-index-debug-benchmark';

describe('component stage benchmark API', () => {
  it('admits database measurement without the retired collection sync service', async () => {
    const runTransaction = vi.fn();
    const api = createWorkspaceIndexStageApi(() => ({ electronRunTransaction: runTransaction }));
    expect(api.readiness('db-completion-ceiling')).toEqual({
      missingDependencies: [],
      ready: true,
    });
    await api.run({ chunkCount: 512, dimensions: 384, mode: 'db-completion-ceiling' });
    expect(runWorkspaceIndexStageBenchmark).toHaveBeenCalledWith(
      expect.objectContaining({
        electronRunTransaction: runTransaction,
        request: { chunkCount: 512, dimensions: 384, mode: 'db-completion-ceiling' },
      })
    );
  });

  it('checks each mode and rejects missing capabilities before measurement', async () => {
    const api = createWorkspaceIndexStageApi(() => ({
      chunkingHost: { chunkBatch: vi.fn() },
    }));
    expect(api.readiness('chunking-ceiling').ready).toBe(true);
    expect(api.readiness('import-ceiling')).toEqual({
      missingDependencies: ['transactional database', 'managed-cache apply'],
      ready: false,
    });
    expect(api.readiness('embedding-ceiling').ready).toBe(false);
    await expect(api.run({ mode: 'db-completion-ceiling' })).rejects.toThrow(
      'transactional database'
    );
  });

  it('reads current capabilities rather than retaining initial readiness', () => {
    let available = false;
    const api = createWorkspaceIndexStageApi(() =>
      available ? { electronRunTransaction: vi.fn() } : {}
    );
    expect(api.readiness('db-completion-ceiling').ready).toBe(false);
    available = true;
    expect(api.readiness('db-completion-ceiling').ready).toBe(true);
  });
});
