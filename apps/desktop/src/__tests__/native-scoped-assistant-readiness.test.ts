// @vitest-environment node

import { ToolInputError } from '@brainstrike/assistant-contract';
import { vectorProfileHash } from '@brainstrike/indexer';
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

it.each(['profile', 'store'] as const)(
  'keeps a mismatched reader %s fatal instead of treating it as an input refusal',
  async (change) => {
    const f = fixture(profile);
    if (change === 'store') {
      f.replaceStore();
    } else {
      f.replaceAuthority({ ...f.getAuthority(), profile: { ...profile, tokenCap: 512 } });
    }
    const pending = f.capability.coverageBatch([{ collectionId: 'selected', rootIds: [] }]);
    await expect(pending).rejects.toBeInstanceOf(Error);
    await expect(pending).rejects.not.toBeInstanceOf(ToolInputError);
    expect(f.searchScopes).not.toHaveBeenCalled();
  }
);

it.each(['owner-generation', 'profile', 'store', 'roots'] as const)(
  'refuses assistant retrieval when %s changes during query inference',
  async (change) => {
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
    f.replaceAuthority({ ...f.getAuthority(), queryPlan });
    // A replaced authority has its own matching reader. Stale reader rows instead
    // exercise the separate storage-integrity failure, before the query refusal.
    const coverage = f.coverageBatch.getMockImplementation()!;
    f.coverageBatch.mockImplementation(async (requests) => {
      const rows = await coverage(requests);
      const currentProfile = f.getAuthority().profile;
      const { storeId } = await f.port.info();
      return rows.map((row) => ({
        ...row,
        profile: currentProfile,
        profileHash: currentProfile === null ? null : vectorProfileHash(currentProfile),
        storeId,
      }));
    });
    const queryEmbedding = vi.fn(async () => {
      const authority = f.getAuthority();
      if (change === 'store') {
        f.replaceStore();
      } else {
        f.replaceAuthority({
          ...authority,
          ...(change === 'owner-generation' ? { generation: authority.generation + 1 } : {}),
          ...(change === 'profile' ? { profile: { ...profile, tokenCap: 512 } } : {}),
          ...(change === 'roots' ? { rootIds: ['replacement-root'] } : {}),
        });
      }
      return Array.from({ length: 384 }, () => 0.1);
    });
    await expect(
      searchNativeAssistantChunks({
        capability: f.capability,
        embeddingHostManager: { queryEmbedding },
        embeddingSet: {
          dimensions: profile.dimensions,
          distance: profile.distance,
          modelId: profile.modelId,
          modelKey: queryPlan.modelKey,
        },
        embeddingSetId: 'selected',
        mode: 'semantic',
        query: 'retained marker',
        threshold: 0,
      })
    ).rejects.toBeInstanceOf(ToolInputError);
    expect(queryEmbedding).toHaveBeenCalledOnce();
    expect(f.searchScopes).not.toHaveBeenCalled();
  }
);
