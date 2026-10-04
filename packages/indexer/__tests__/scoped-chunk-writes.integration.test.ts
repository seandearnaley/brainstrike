import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openIndexer } from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { Schema } from 'effect';
import { expect, it } from 'vitest';
import { providedChunkSchema } from '../src/contracts.js';

const captured = Schema.decodeUnknownSync(
  Schema.Struct({
    content: Schema.String,
    fileId: Schema.String,
    relativePath: Schema.String,
    result: Schema.Struct({ chunks: Schema.Array(providedChunkSchema) }),
  })
)(
  JSON.parse(
    readFileSync(new URL('./fixtures/canonical-provided-chunks.json', import.meta.url), 'utf8')
  )
);
const profile = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'fp16',
  modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
  provider: 'local',
  revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
  tokenCap: 256,
} as const;
const vector = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
const scope = { embeddingSetId: 'collection', kind: 'collection' } as const;
const binding = {
  embeddingSetId: scope.embeddingSetId,
  fileId: captured.fileId,
  profile,
  relativePath: null,
  rootId: null,
  sourcePath: '/imports/source.ts',
};
const { profile: _profile, ...sourceBinding } = binding;
const snapshot = {
  ...sourceBinding,
  content: captured.content,
  providedChunks: captured.result.chunks,
};
const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };

async function withStore(
  run: (
    port: Awaited<ReturnType<typeof openIndexer>>,
    db: ReturnType<typeof openConnection>
  ) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-chunk-writes-'));
  const dbPath = path.join(directory, 'index.sqlite');
  const port = await openIndexer(
    {
      dbPath,
      embedding: { indexMode: 'text-only' },
      fileBindings: [binding],
      rootIds: [],
      scopes: [scope],
    },
    deadlines
  );
  const db = openConnection(dbPath);
  try {
    // The actual writer's UPDATE fires this audit trigger alongside both FTS triggers.
    db.exec(
      'CREATE TABLE chunk_update_audit(pk INTEGER NOT NULL); CREATE TRIGGER audit_chunk_update AFTER UPDATE ON file_chunks BEGIN INSERT INTO chunk_update_audit VALUES(new.pk); END;'
    );
    await run(port, db);
  } finally {
    db.close();
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
}

it('avoids native UPDATE/FTS triggers for equal rows while backfilling and selecting new vector profiles', async () => {
  await withStore(async (port, db) => {
    const textPlan = await port.prepareScopedFile({ snapshot });
    await port.commitScopedTextFile({ plan: textPlan });
    const chunksBefore = db.prepare('SELECT * FROM file_chunks ORDER BY pk').all();
    const query = {
      limit: 10,
      mode: 'bm25',
      scopes: [scope],
      text: 'projectToolOutputArtifactPage',
    } as const;
    const trigram = { ...query, mode: 'trigram' } as const;
    const before = await port.searchScopes(query);
    const trigramBefore = await port.searchScopes(trigram);
    expect(before.hits.length).toBeGreaterThan(0);
    expect(trigramBefore.hits.length).toBeGreaterThan(0);
    for (const selectedProfile of [profile, { ...profile, tokenCap: 512 }]) {
      await port.replaceFileBindings([{ ...binding, profile: selectedProfile }]);
      const plan = await port.prepareScopedFile({ profile: selectedProfile, snapshot });
      expect(plan.embeddingChunkIds).toHaveLength(captured.result.chunks.length);
      await port.commitScopedFile({
        embeddings: plan.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
        plan,
        profile: selectedProfile,
      });
      expect(db.prepare('SELECT pk FROM chunk_update_audit').all()).toEqual([]);
      const covered = await port.prepareScopedFile({ profile: selectedProfile, snapshot });
      expect(covered.embeddingChunkIds).toEqual([]);
      const bytes = db
        .prepare('SELECT chunk_pk,profile_hash,hex(emb) AS bytes FROM scoped_vectors ORDER BY pk')
        .all();
      const coarse = db
        .prepare('SELECT id,profile_hash,hex(bin) AS bytes FROM scope_vec_384 ORDER BY id')
        .all();
      await port.commitScopedFile({ embeddings: [], plan: covered, profile: selectedProfile });
      await port.commitScopedTextFile({ plan: await port.prepareScopedFile({ snapshot }) });
      expect(db.prepare('SELECT pk FROM chunk_update_audit').all()).toEqual([]);
      expect(db.prepare('SELECT * FROM file_chunks ORDER BY pk').all()).toEqual(chunksBefore);
      expect(
        db
          .prepare('SELECT chunk_pk,profile_hash,hex(emb) AS bytes FROM scoped_vectors ORDER BY pk')
          .all()
      ).toEqual(bytes);
      expect(
        db.prepare('SELECT id,profile_hash,hex(bin) AS bytes FROM scope_vec_384 ORDER BY id').all()
      ).toEqual(coarse);
      const coverage = await port.coverageScope({ profile: selectedProfile, scope });
      expect(coverage.vectorCoverageComplete).toBe(true);
      const files = [
        {
          ...sourceBinding,
          chunks: covered.chunks.map(
            ({ content: _content, embeddingHash: _hash, ...chunk }) => chunk
          ),
          contentHash: covered.contentHash,
        },
      ];
      expect((await port.verifyScopedManifest({ files, scope })).complete).toBe(true);
    }
    expect((await port.searchScopes(query)).hits).toEqual(before.hits);
    expect((await port.searchScopes(trigram)).hits).toEqual(trigramBefore.hits);
    expect(db.prepare('SELECT count(*) FROM scoped_vectors').pluck().get()).toBe(
      captured.result.chunks.length * 2
    );
  });
});

it('updates each different actual native field despite the same file snapshot hash', async () => {
  await withStore(async (port, db) => {
    const plan = await port.prepareScopedFile({ snapshot });
    await port.commitScopedTextFile({ plan });
    const original = db.prepare('SELECT * FROM file_chunks ORDER BY pk').all();
    const first = plan.chunks[0]!;
    for (const [column, value] of [
      ['start_line', first.startLine + 1],
      ['end_line', first.endLine + 1],
      ['content', 'different stored bytes'],
      ['content_hash', 'c'.repeat(64)],
      ['chunk_index', first.chunkIndex! + 2],
      ['chunk_size', first.chunkSize! + 1],
      ['chunk_type', 'text'],
      ['start_offset', first.startOffset! + 1],
      ['end_offset', first.endOffset! - 1],
      ['token_count', first.tokenCount! + 1],
      ['embedding_hash', 'd'.repeat(64)],
      ['has_vector', 1],
    ] as const) {
      const assignments =
        column === 'has_vector' ? `has_vector=?,embedding_hash='${'d'.repeat(64)}'` : `${column}=?`;
      db.prepare(`UPDATE file_chunks SET ${assignments} WHERE id=?`).run(value, first.chunkId);
      db.exec('DELETE FROM chunk_update_audit');
      await port.commitScopedTextFile({ plan: await port.prepareScopedFile({ snapshot }) });
      expect(db.prepare('SELECT pk FROM chunk_update_audit').all()).toHaveLength(1);
      expect(db.prepare('SELECT * FROM file_chunks ORDER BY pk').all()).toEqual(original);
    }
  });
});

it('removes stale native chunk/vector/coarse rows after provided-chunk removal', async () => {
  await withStore(async (port, db) => {
    const plan = await port.prepareScopedFile({ profile, snapshot });
    await port.commitScopedFile({
      embeddings: plan.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
      plan,
      profile,
    });
    const changed = { ...snapshot, providedChunks: captured.result.chunks.slice(0, 1) };
    const next = await port.prepareScopedFile({ profile, snapshot: changed });
    await port.commitScopedFile({ embeddings: [], plan: next, profile });
    expect(db.prepare('SELECT pk FROM chunk_update_audit').all()).toEqual([]);
    expect(db.prepare('SELECT count(*) FROM file_chunks').pluck().get()).toBe(1);
    expect(db.prepare('SELECT count(*) FROM scoped_vectors').pluck().get()).toBe(1);
    expect(db.prepare('SELECT count(*) FROM scope_vec_384').pluck().get()).toBe(1);
  });
});
