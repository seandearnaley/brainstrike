import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openIndexer } from '@brainstrike/indexer';
import { expect, it } from 'vitest';

for (const distance of ['cosine', 'l2', 'ip'] as const) {
  it(`retains collection ${distance} metric and exact non-binary-aligned dimensions through SQLite restart`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-parity-'));
    const profile = {
      dimensions: 3,
      distance,
      modelId: 'text-embedding-3-small',
      provider: 'openai',
    } as const;
    const scope = { embeddingSetId: 'existing-collection', kind: 'collection' } as const;
    const bindings = ['near', 'large'].map((fileId) => ({
      embeddingSetId: scope.embeddingSetId,
      fileId,
      profile,
      relativePath: null,
      rootId: null,
      sourcePath: `/imports/${fileId}.txt`,
    }));
    const options = {
      dbPath: join(directory, 'index.sqlite'),
      embedding: { indexMode: 'text-only' as const },
      fileBindings: bindings,
      rootIds: [],
      scopes: [scope],
    };
    const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
    let port = await openIndexer(options, deadlines);
    try {
      for (const binding of bindings) {
        const { profile: _profile, ...source } = binding;
        const plan = await port.prepareScopedFile({
          profile,
          snapshot: {
            ...source,
            chunkLines: 10,
            content: `Original collection ${binding.fileId} document`,
          },
        });
        await port.commitScopedFile({
          embeddings: plan.embeddingChunkIds.map((chunkId) => ({
            chunkId,
            vector: binding.fileId === 'near' ? [1, 0.1, 0] : [10, 10, 0],
          })),
          plan,
          profile,
        });
      }
      const query = {
        limit: 2,
        mode: 'vector' as const,
        profile,
        scopes: [scope],
        vector: [1, 0, 0],
      };
      const before = await port.searchScopes(query);
      expect(before.hits).toHaveLength(2);
      expect(before.hits[0]?.fileId).toBe(distance === 'ip' ? 'large' : 'near');
      expect(before.profileHash).toBeTruthy();
      await port.close();
      port = await openIndexer(
        { ...options, embedding: { indexMode: 'open-existing' } },
        deadlines
      );
      expect((await port.searchScopes(query)).hits).toEqual(before.hits);
      expect((await port.coverageScope({ profile, scope })).vectorCoverageComplete).toBe(true);
    } finally {
      await port.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
}
