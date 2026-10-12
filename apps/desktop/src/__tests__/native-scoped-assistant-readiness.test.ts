// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { searchNativeAssistantChunks } from '../assistant-server/native-assistant-retrieval';
import { fixture, profile, progressAuthority } from './native-scoped-search-fixture';

it.each(
  (['semantic', 'hybrid'] as const).flatMap((mode) =>
    (['new-scan', 'completion', 'commits', 'request', 'removed-proof'] as const).flatMap((change) =>
      [1, 3].map((readNumber) => ({ change, mode, readNumber }))
    )
  )
)(
  'completes assistant $mode through $change on coverage read $readNumber',
  async ({ mode, change, readNumber }) => {
    const f = fixture(profile);
    const queryPlan = {
      inferencePlan: {
        device: 'wasm' as const,
        dimensions: profile.dimensions,
        dtype: profile.dtype,
        modelId: profile.modelId,
        revision: profile.revision,
      },
      modelKey: `local::${profile.modelId}`,
    };
    f.replaceAuthority({
      ...f.getAuthority(),
      queryPlan,
      readiness: progressAuthority(f).readiness.map((entry) => ({
        ...entry,
        scanComplete: change !== 'completion',
      })),
    });
    const original = f.coverageBatch.getMockImplementation()!;
    let reads = 0;
    f.coverageBatch.mockImplementation(async (requests) => {
      const rows = await original(requests);
      if (++reads === readNumber || (change === 'commits' && reads > readNumber)) {
        f.replaceAuthority({
          ...f.getAuthority(),
          readiness:
            change === 'removed-proof'
              ? []
              : f.getAuthority().readiness.map(({ publication, ...entry }) => ({
                  ...entry,
                  generation: entry.generation + Number(change === 'new-scan'),
                  mutationRevision: entry.mutationRevision + Number(change === 'commits'),
                  scanComplete: change !== 'new-scan',
                  ...(change === 'request'
                    ? { publication: { ...publication!, requestId: `request-${reads}` } }
                    : change === 'new-scan'
                      ? {}
                      : { publication }),
                })),
        });
      }
      return rows;
    });
    const queryEmbedding = vi.fn(async () => Array.from({ length: 384 }, () => 0.1));
    const result = await searchNativeAssistantChunks({
      capability: f.capability,
      embeddingHostManager: { queryEmbedding },
      embeddingSet: {
        dimensions: profile.dimensions,
        distance: profile.distance,
        modelId: profile.modelId,
        modelKey: queryPlan.modelKey,
      },
      embeddingSetId: 'selected',
      mode,
      query: 'retained marker',
      threshold: 0,
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.hit.content).toBe('retained marker');
    expect(result.hint).toMatch(/Partial index coverage/);
    expect(queryEmbedding).toHaveBeenCalledOnce();
    expect(f.searchScopes).toHaveBeenCalledTimes(mode === 'hybrid' ? 2 : 1);
    await expect(result.assertCurrent()).resolves.toBeUndefined();
  }
);
