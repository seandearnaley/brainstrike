// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  IndexFileBinding,
  ScopedFilePlan,
  ScopedIndexerPort,
  ScopedManifestFile,
} from '@brainstrike/indexer';
import { expect, it } from 'vitest';
// The native process entry needs the built public artifact, independent of source test aliases.
import { openIndexer } from '../../../../packages/indexer/dist/index.js';
import { createNativeIndexRuntime, type NativeIndexAuthority } from '../native-index-runtime';

const local = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  provider: 'transformers',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 512,
} as const;
const hosted = {
  dimensions: 1536,
  distance: 'cosine',
  modelId: 'text-embedding-3-small',
  provider: 'openai',
} as const;
const workspace = { kind: 'workspace', rootId: 'actual-root' } as const;
const oldCollection = { embeddingSetId: 'old', kind: 'collection' } as const;
const nextCollection = { embeddingSetId: 'next', kind: 'collection' } as const;
const otherCollection = { embeddingSetId: 'other', kind: 'collection' } as const;
const oldRoot: IndexFileBinding = {
  embeddingSetId: 'old',
  fileId: 'old-root-file',
  profile: local,
  relativePath: 'file.txt',
  rootId: workspace.rootId,
  sourcePath: '/actual/root/file.txt',
};
const retained: IndexFileBinding = {
  ...oldRoot,
  fileId: 'retained-old',
  relativePath: null,
  rootId: null,
  sourcePath: null,
};
const other: IndexFileBinding = {
  ...retained,
  embeddingSetId: 'other',
  fileId: 'other-profile',
  profile: hosted,
};
const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
function manifestFile(plan: ScopedFilePlan): ScopedManifestFile {
  const { fileId, rootId, relativePath, sourcePath, embeddingSetId } = plan.snapshot;
  return {
    chunks: plan.chunks.map(
      ({ content: _content, embeddingHash: _embeddingHash, ...chunk }) => chunk
    ),
    contentHash: plan.contentHash,
    embeddingSetId,
    fileId,
    relativePath,
    rootId,
    sourcePath,
  };
}
async function publish(
  port: Pick<ScopedIndexerPort, 'prepareScopedFile' | 'commitScopedFile' | 'commitScopedTextFile'>,
  binding: IndexFileBinding,
  content: string
): Promise<ScopedFilePlan> {
  const { profile, ...identity } = binding;
  const plan = await port.prepareScopedFile({
    snapshot: { ...identity, chunkLines: 1, content },
    ...(profile === null ? {} : { profile }),
  });
  if (profile === null) {
    await port.commitScopedTextFile({ plan });
    return plan;
  }
  await port.commitScopedFile({
    embeddings: plan.embeddingChunkIds.map((chunkId) => ({
      chunkId,
      vector: Array.from({ length: profile.dimensions }, (_, index) => (index === 0 ? 1 : 0)),
    })),
    plan,
    profile,
  });
  return plan;
}

it.each(['TEXT', 'VECTOR'] as const)(
  'retires outgoing same-root rows before %s selection, preserving retained and unrelated profile vectors',
  async (mode) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-collection-retirement-'));
    const dbPath = path.join(directory, 'index.sqlite');
    let authority: NativeIndexAuthority = {
      fileBindings: [oldRoot, retained, other],
      rootIds: [workspace.rootId],
      scopes: [workspace, oldCollection, otherCollection],
    };
    const runtime = createNativeIndexRuntime({
      closeQueries: async () => {},
      createIndexOwner: async (owned) => {
        const starting = openIndexer(
          { dbPath, ...owned, embedding: { indexMode: 'text-only' } },
          deadlines
        );
        starting.catch(() => undefined);
        return {
          close: async () => (await starting).close(),
          databasePath: dbPath,
          destroy: async () => (await starting).destroy(),
          start: () => starting,
        };
      },
      createProfileOwner: () => ({ acquire: async () => {}, close: async () => {} }),
      getAuthority: async () => authority,
      getFileInvalidator: () => () => {},
      installQueryTarget: () => {},
    });
    try {
      const original = await runtime.acquire();
      await publish(original, oldRoot, 'old canonical marker');
      await publish(original, retained, 'retained canonical marker');
      await publish(original, other, 'other canonical marker');
      const storeId = (await original.info()).storeId;
      const captured = runtime.captureAcknowledgedAuthority();
      await runtime.retireWorkspaceCollectionFiles('old');
      expect(captured.readAuthority().fileBindings).toEqual([oldRoot, retained, other]);
      await runtime.retireProfile();
      const nextRoot = {
        ...oldRoot,
        embeddingSetId: 'next',
        fileId: 'next-root-file',
        profile: mode === 'TEXT' ? null : local,
      };
      authority = {
        fileBindings: [nextRoot],
        rootIds: [workspace.rootId],
        scopes: [workspace, nextCollection],
      };
      await runtime.resume();
      const next = await runtime.acquire();
      const plan = await publish(next, nextRoot, 'next canonical marker');
      expect(
        await next.verifyScopedManifest({ files: [manifestFile(plan)], scope: workspace })
      ).toMatchObject({ changed: [], complete: true, missing: [], storeId, unexpected: [] });
      expect(
        (
          await next.searchScopes({
            limit: 100,
            mode: 'bm25',
            scopes: [workspace],
            text: 'canonical',
          })
        ).hits.map((hit) => hit.fileId)
      ).toEqual([nextRoot.fileId]);
      await runtime.retireProfile();
      authority = {
        fileBindings: [retained, nextRoot, other],
        rootIds: [workspace.rootId],
        scopes: [workspace, oldCollection, nextCollection, otherCollection],
      };
      await runtime.resume();
      const reopened = await runtime.acquire();
      expect(await reopened.coverageScope({ profile: local, scope: oldCollection })).toMatchObject({
        counts: { chunks: 1, indexedFiles: 1, missingVectors: 0, vectors: 1 },
        storeId,
        vectorCoverageComplete: true,
      });
      expect(
        await reopened.coverageScope({ profile: hosted, scope: otherCollection })
      ).toMatchObject({
        counts: { chunks: 1, indexedFiles: 1, missingVectors: 0, vectors: 1 },
        storeId,
        vectorCoverageComplete: true,
      });
    } finally {
      await runtime.retireProfile();
      await rm(directory, { force: true, recursive: true });
    }
  }
);

it('the actual full native root manifest refuses a switch that omits outgoing removal', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-collection-negative-'));
  const dbPath = path.join(directory, 'index.sqlite');
  let port = await openIndexer(
    {
      dbPath,
      embedding: { indexMode: 'text-only' },
      fileBindings: [oldRoot],
      rootIds: [workspace.rootId],
      scopes: [workspace, oldCollection],
    },
    deadlines
  );
  try {
    await publish(port, oldRoot, 'old canonical marker');
    await port.close();
    const nextRoot = {
      ...oldRoot,
      embeddingSetId: 'next',
      fileId: 'next-root-file',
      relativePath: 'next.txt',
      sourcePath: '/actual/root/next.txt',
    };
    port = await openIndexer(
      {
        dbPath,
        embedding: { indexMode: 'text-only' },
        fileBindings: [nextRoot],
        rootIds: [workspace.rootId],
        scopes: [workspace, nextCollection],
      },
      deadlines
    );
    const plan = await publish(port, nextRoot, 'next canonical marker');
    const proof = await port.verifyScopedManifest({
      files: [manifestFile(plan)],
      scope: workspace,
    });
    expect(proof.complete).toBe(false);
    expect(proof.unexpected.map((file) => file.fileId)).toEqual([oldRoot.fileId]);
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});
