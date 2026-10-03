import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openIndexer } from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { Schema } from 'effect';
import { expect, it } from 'vitest';
import { providedChunkSchema, refSchema, symbolSchema } from '../src/contracts.js';

const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const local = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'fp16',
  modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
  provider: 'local',
  revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
  tokenCap: 256,
} as const;
const hosted = {
  dimensions: 1536,
  distance: 'cosine',
  modelId: 'text-embedding-3-small',
  provider: 'openai',
} as const;
const bindings = [
  {
    embeddingSetId: 'a',
    fileId: 'workspace-file',
    profile: local,
    relativePath: 'source.ts',
    rootId: 'root',
    sourcePath: null,
  },
  {
    embeddingSetId: 'a',
    fileId: 'import-a',
    profile: local,
    relativePath: null,
    rootId: null,
    sourcePath: '/imports/source.ts',
  },
  {
    embeddingSetId: 'b',
    fileId: 'import-b',
    profile: hosted,
    relativePath: null,
    rootId: null,
    sourcePath: '/imports/source.ts',
  },
];
const scopes = [
  { kind: 'workspace', rootId: 'root' },
  { embeddingSetId: 'a', kind: 'collection' },
  { embeddingSetId: 'b', kind: 'collection' },
] as const;

it('coexists with workspace storage, preserves canonical collection IDs, authorizes and reopens rootless files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-scopes-'));
  const options = {
    dbPath: path.join(directory, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    fileBindings: bindings,
    rootIds: ['root'],
    scopes,
  };
  let port = await openIndexer(options, deadlines);
  const search = (selected: readonly unknown[]) =>
    port.searchScopes({ limit: 10, mode: 'bm25', scopes: selected, text: 'canonical' });
  try {
    for (const { profile: _profile, ...binding } of bindings) {
      const plan = await port.prepareScopedFile({
        snapshot: { ...binding, chunkLines: 1, content: 'canonical content\n' },
      });
      await port.commitScopedTextFile({ plan });
    }
    await port.commitTextFile({
      plan: await port.prepareFile({
        chunkLines: 1,
        content: 'canonical old source\n',
        fileId: 'old-workspace',
        relativePath: 'old.ts',
        rootId: 'root',
      }),
    });
    expect((await search([scopes[1]])).hits.map((hit) => hit.fileId).sort()).toEqual([
      'import-a',
      'workspace-file',
    ]);
    expect((await search([scopes[2]])).hits.map((hit) => hit.fileId)).toEqual(['import-b']);
    const combined = await search(scopes);
    expect(combined.hits.map((hit) => hit.fileId).sort()).toEqual([
      'import-a',
      'import-b',
      'old-workspace',
      'workspace-file',
    ]);
    expect(combined.hits.find((hit) => hit.fileId === 'import-a')).toMatchObject({
      embeddingSetId: 'a',
      relativePath: null,
      rootId: null,
      sourcePath: '/imports/source.ts',
    });
    expect((await search([])).hits).toEqual([]);
    expect(
      (await port.searchScopes({ fileIds: [], limit: 10, mode: 'bm25', scopes, text: 'canonical' }))
        .hits
    ).toEqual([]);
    await expect(
      search([{ embeddingSetId: 'unauthorized', kind: 'collection' }])
    ).rejects.toMatchObject({ code: 'scope-not-authorized' });
    await expect(
      search([{ embeddingSetId: 'a', kind: 'collection', rootId: 'root' }])
    ).rejects.toThrow();
    await expect(
      port.prepareScopedFile({
        snapshot: {
          chunkLines: 1,
          content: 'canonical',
          embeddingSetId: 'a',
          fileId: 'unknown',
          relativePath: null,
          rootId: null,
          sourcePath: null,
        },
      })
    ).rejects.toMatchObject({ code: 'file-not-authorized' });
    await expect(
      port.prepareScopedFile({
        ...bindings[1],
        chunkLines: 1,
        content: 'canonical',
        embeddingSetId: 'b',
        profile: undefined,
      })
    ).rejects.toThrow();
    await expect(
      port.removeScopedFile({ fileId: 'import-b', scope: scopes[1] })
    ).rejects.toMatchObject({ code: 'file-not-authorized' });
    expect(await port.removeScopedFile({ fileId: 'import-a', scope: scopes[1] })).toBe(true);
    expect((await search([scopes[2]])).hits).toHaveLength(1);
    await port.close();
    port = await openIndexer({ ...options, embedding: { indexMode: 'open-existing' } }, deadlines);
    expect((await search([scopes[1]])).hits.map((hit) => hit.fileId)).toEqual(['workspace-file']);
    expect((await search([scopes[2]])).hits.map((hit) => hit.fileId)).toEqual(['import-b']);
    await port.destroy();
    await expect(access(options.dbPath)).rejects.toThrow();
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});

it('adopts an existing canonical workspace file into scoped collection storage and persists membership', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-adopt-scope-'));
  const binding = bindings[0]!;
  const options = {
    dbPath: path.join(directory, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    fileBindings: [binding],
    rootIds: ['root'],
    scopes,
  };
  let port = await openIndexer(options, deadlines);
  const legacy = {
    chunkLines: 1,
    content: 'canonical adopted content\n',
    fileId: binding.fileId,
    relativePath: binding.relativePath,
    rootId: binding.rootId,
  };
  const query = { limit: 10, mode: 'bm25', scopes: [scopes[1]], text: 'canonical' };
  try {
    await port.commitTextFile({ plan: await port.prepareFile(legacy) });
    const { profile: _profile, ...snapshot } = binding;
    await port.commitScopedTextFile({
      plan: await port.prepareScopedFile({ snapshot: { ...snapshot, ...legacy } }),
    });
    expect((await port.searchScopes(query)).hits).toMatchObject([
      { embeddingSetId: 'a', fileId: binding.fileId, relativePath: 'source.ts', rootId: 'root' },
    ]);
    await expect(
      port.commitTextFile({ plan: await port.prepareFile(legacy) })
    ).rejects.toMatchObject({ code: 'scoped-file-required' });
    await port.close();
    port = await openIndexer({ ...options, embedding: { indexMode: 'open-existing' } }, deadlines);
    expect((await port.searchScopes(query)).hits.map((hit) => hit.fileId)).toEqual([
      binding.fileId,
    ]);
    await port.destroy();
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});

it('isolates full profiles and real supported dimensions before binary top100 and retains vectors through TEXT edits/reopen', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-profile-scopes-'));
  // Deterministic storage probes at production provider dimensions; this does not qualify model inference.
  const outside = [
    { ...bindings[1]!, embeddingSetId: 'other', fileId: 'other-same-profile', profile: local },
    {
      ...bindings[1]!,
      embeddingSetId: 'other-profile',
      fileId: 'other-profile',
      profile: {
        ...local,
        dtype: 'q8' as const,
        modelId: 'Xenova/all-MiniLM-L6-v2',
        revision: '751bff37182d3f1213fa05d7196b954e230abad9',
        tokenCap: 512,
      },
    },
  ];
  const options = {
    dbPath: path.join(directory, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    fileBindings: [...bindings, ...outside],
    rootIds: ['root'],
    scopes: [
      ...scopes,
      { embeddingSetId: 'other', kind: 'collection' },
      { embeddingSetId: 'other-profile', kind: 'collection' },
    ],
  };
  let port = await openIndexer(options, deadlines);
  const vector = (dimensions: number): number[] =>
    Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0));
  try {
    for (const { profile, ...binding } of [...bindings, ...outside]) {
      const snapshot = {
        ...binding,
        chunkLines: 1,
        content: binding.fileId.startsWith('other-')
          ? 'canonical profile distractor\n'.repeat(105)
          : 'canonical profile content\n',
      };
      const plan = await port.prepareScopedFile({ profile, snapshot });
      await port.commitScopedFile({
        embeddings: plan.embeddingChunkIds.map((chunkId) => ({
          chunkId,
          vector: vector(profile.dimensions),
        })),
        plan,
        profile,
      });
    }
    const queryA = {
      limit: 10,
      mode: 'vector',
      profile: local,
      scopes: [scopes[1]],
      vector: vector(384),
    };
    const queryB = {
      limit: 10,
      mode: 'vector',
      profile: hosted,
      scopes: [scopes[2]],
      vector: vector(1536),
    };
    expect((await port.searchScopes(queryA)).hits.map((hit) => hit.fileId).sort()).toEqual([
      'import-a',
      'workspace-file',
    ]);
    expect((await port.searchScopes(queryA)).candidateCount).toBe(2);
    expect((await port.searchScopes(queryA)).candidatesTruncated).toBe(false);
    expect((await port.searchScopes(queryB)).hits.map((hit) => hit.fileId)).toEqual(['import-b']);
    expect(
      (
        await port.searchScopes({
          ...queryA,
          fileIds: ['workspace-file'],
          scopes: [scopes[0], scopes[1]],
        })
      ).hits
    ).toHaveLength(1);
    const { profile: _profile, ...binding } = bindings[1]!;
    const snapshot = { ...binding, chunkLines: 1, content: 'canonical profile content\n' };
    const unchanged = await port.prepareScopedFile({ profile: local, snapshot });
    expect(unchanged.embeddingChunkIds).toEqual([]);
    await port.commitScopedTextFile({ plan: await port.prepareScopedFile({ snapshot }) });
    expect((await port.searchScopes(queryA)).hits).toHaveLength(2);
    await port.commitScopedTextFile({
      plan: await port.prepareScopedFile({
        snapshot: { ...snapshot, content: 'replacement canonical source\n' },
      }),
    });
    expect((await port.searchScopes(queryA)).hits.map((hit) => hit.fileId)).toEqual([
      'workspace-file',
    ]);
    await expect(
      port.commitScopedFile({ embeddings: [], plan: unchanged, profile: local })
    ).rejects.toMatchObject({ code: 'stale-file-plan' });
    await expect(port.searchScopes({ ...queryA, vector: vector(1536) })).rejects.toThrow(
      'dimensions'
    );
    await expect(
      port.searchScopes({ ...queryA, profile: { ...local, tokenCap: 512 } })
    ).rejects.toThrow('profile');
    await expect(
      port.prepareScopedFile({ profile: { ...local, revision: undefined }, snapshot })
    ).rejects.toThrow();
    const unsupported = { ...bindings[1]!, profile: { ...local, distance: 'l2' as const } };
    await port.replaceFileBindings([unsupported]);
    await expect(
      port.prepareScopedFile({ profile: unsupported.profile, snapshot })
    ).rejects.toMatchObject({ code: 'unsupported-profile' });
    await port.replaceFileBindings([...bindings, ...outside]);
    await port.close();
    port = await openIndexer({ ...options, embedding: { indexMode: 'open-existing' } }, deadlines);
    expect((await port.searchScopes(queryB)).hits).toHaveLength(1);
    expect(
      (await port.prepareScopedFile({ profile: local, snapshot })).embeddingChunkIds
    ).toHaveLength(1);
    expect(await port.removeScopedFile({ fileId: 'import-b', scope: scopes[2] })).toBe(true);
    expect((await port.searchScopes(queryB)).hits).toHaveLength(0);
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});

it('fences prepared and queued commits after binding revocation, replacement and removal', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-binding-revocation-'));
  const port = await openIndexer(
    {
      dbPath: path.join(directory, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      fileBindings: bindings,
      rootIds: ['root'],
      scopes,
    },
    deadlines
  );
  const { profile: _profile, ...binding } = bindings[1]!;
  const request = {
    snapshot: { ...binding, chunkLines: 1, content: 'authorized canonical source\n' },
  };
  try {
    const plan = await port.prepareScopedFile(request);
    const revoke = port.replaceFileBindings([]);
    const commit = port.commitScopedTextFile({ plan });
    await revoke;
    await expect(commit).rejects.toMatchObject({ code: 'file-not-authorized' });
    await port.replaceFileBindings(bindings);
    await expect(port.commitScopedTextFile({ plan })).rejects.toMatchObject({
      code: 'stale-file-plan',
    });
    const fresh = await port.prepareScopedFile(request);
    await port.commitScopedTextFile({ plan: fresh });
    const pending = await port.prepareScopedFile(request);
    await port.removeScopedFile({ fileId: binding.fileId, scope: scopes[1] });
    await expect(port.commitScopedTextFile({ plan: pending })).rejects.toMatchObject({
      code: 'stale-file-plan',
    });
    expect(
      (await port.searchScopes({ limit: 10, mode: 'bm25', scopes: [scopes[1]], text: 'canonical' }))
        .hits
    ).toHaveLength(0);
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});

it('preserves captured canonical parser chunks and syntax for rootless files and refuses corrupt/replaced stores', async () => {
  const captured = Schema.decodeUnknownSync(
    Schema.Struct({
      content: Schema.String,
      result: Schema.Struct({
        chunks: Schema.Array(providedChunkSchema),
        symbolRefs: Schema.Array(
          Schema.Struct({
            ...refSchema.fields,
            fileRecordId: Schema.optional(Schema.String),
            seq: Schema.optional(Schema.Int),
          })
        ),
        symbols: Schema.Array(
          Schema.Struct({
            ...symbolSchema.fields,
            fileRecordId: Schema.optional(Schema.String),
            seq: Schema.optional(Schema.Int),
          })
        ),
      }),
      sourceHash: Schema.String,
    })
  )(
    JSON.parse(
      await readFile(new URL('./fixtures/canonical-provided-chunks.json', import.meta.url), 'utf8')
    )
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-scoped-canonical-'));
  const options = {
    dbPath: path.join(directory, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    fileBindings: bindings,
    rootIds: ['root'],
    scopes,
  };
  let port = await openIndexer(options, deadlines);
  const { profile: _profile, ...binding } = bindings[1]!;
  const snapshot = {
    ...binding,
    content: captured.content,
    providedChunks: captured.result.chunks,
  };
  const syntax = {
    refs: captured.result.symbolRefs.map((ref, seq) => ({
      ...ref,
      fileRecordId: binding.fileId,
      seq,
    })),
    symbols: captured.result.symbols.map((symbol, seq) => ({
      ...symbol,
      fileRecordId: binding.fileId,
      seq,
    })),
  };
  try {
    const plan = await port.prepareScopedFile({ snapshot });
    expect(plan.contentHash).toBe(captured.sourceHash);
    expect(plan.chunks.map(({ embeddingHash: _hash, chunkId: _id, ...chunk }) => chunk)).toEqual(
      captured.result.chunks
    );
    await expect(
      port.commitScopedTextFile({
        plan,
        syntax: {
          ...syntax,
          symbols: syntax.symbols.map((symbol) => ({ ...symbol, fileRecordId: 'other-file' })),
        },
      })
    ).rejects.toThrow('committed file');
    await port.commitScopedTextFile({ plan, syntax });
    const vectorPlan = await port.prepareScopedFile({ profile: local, snapshot });
    const vector = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
    await port.commitScopedFile({
      embeddings: vectorPlan.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
      plan: vectorPlan,
      profile: local,
    });
    const query = { limit: 10, mode: 'vector', profile: local, scopes: [scopes[1]], vector };
    const before = await port.searchScopes(query);
    expect(before.hits).toHaveLength(captured.result.chunks.length);
    await port.close();
    port = await openIndexer({ ...options, embedding: { indexMode: 'open-existing' } }, deadlines);
    await expect(port.commitScopedTextFile({ plan })).rejects.toMatchObject({
      code: 'stale-file-plan',
    });
    expect((await port.searchScopes(query)).hits).toEqual(before.hits);
    const db = openConnection(options.dbPath);
    expect(
      db
        .prepare('SELECT count(*) FROM file_symbols WHERE file_record_id=?')
        .pluck()
        .get(binding.fileId)
    ).toBe(syntax.symbols.length);
    expect(
      db
        .prepare('SELECT count(*) FROM file_symbol_refs WHERE file_record_id=?')
        .pluck()
        .get(binding.fileId)
    ).toBe(syntax.refs.length);
    await expect(
      port.prepareScopedFile({
        snapshot: {
          ...snapshot,
          providedChunks: [{ ...snapshot.providedChunks[0]!, contentHash: '0'.repeat(64) }],
        },
      })
    ).rejects.toThrow('canonical snapshot');
    await port.close();
    db.prepare('UPDATE index_metadata SET schema_version=4').run();
    await expect(
      openIndexer({ ...options, embedding: { indexMode: 'open-existing' } }, deadlines)
    ).rejects.toMatchObject({ code: 'rebuild-required' });
    expect(db.prepare('SELECT count(*) FROM file_chunks').pluck().get()).toBe(
      captured.result.chunks.length
    );
    db.prepare('UPDATE index_metadata SET schema_version=5').run();
    const profileJson = db.prepare('SELECT profile_json FROM vector_profiles').pluck().get();
    db.prepare("UPDATE vector_profiles SET profile_json='{}'").run();
    await expect(
      openIndexer({ ...options, embedding: { indexMode: 'open-existing' } }, deadlines)
    ).rejects.toMatchObject({ code: 'rebuild-required' });
    db.prepare('UPDATE vector_profiles SET profile_json=?').run(profileJson);
    db.prepare('DELETE FROM scope_vec_384').run();
    await expect(
      openIndexer({ ...options, embedding: { indexMode: 'open-existing' } }, deadlines)
    ).rejects.toMatchObject({ code: 'rebuild-required' });
    expect(db.prepare('SELECT count(*) FROM scoped_vectors').pluck().get()).toBe(
      captured.result.chunks.length
    );
    db.close();
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});

it('retains vectors for two explicit profiles on one canonical file across selection changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-retained-profiles-'));
  const file = bindings[1]!;
  const { profile: _profile, ...binding } = file;
  const snapshot = { ...binding, chunkLines: 1, content: 'canonical retained vectors\n' };
  const second = {
    dimensions: 3072,
    distance: 'cosine',
    modelId: 'text-embedding-3-large',
    provider: 'openai',
  } as const;
  const port = await openIndexer(
    {
      dbPath: path.join(directory, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      fileBindings: [file],
      rootIds: ['root'],
      scopes,
    },
    deadlines
  );
  try {
    for (const profile of [local, second]) {
      await port.replaceFileBindings([{ ...file, profile }]);
      const plan = await port.prepareScopedFile({ profile, snapshot });
      const vector = Array.from({ length: profile.dimensions }, (_, i) => (i === 0 ? 1 : 0));
      await port.commitScopedFile({
        embeddings: plan.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
        plan,
        profile,
      });
      expect(
        (
          await port.searchScopes({
            limit: 10,
            mode: 'vector',
            profile,
            scopes: [scopes[1]],
            vector,
          })
        ).hits
      ).toHaveLength(1);
    }
    await port.replaceFileBindings([file]);
    const retained = await port.prepareScopedFile({ profile: local, snapshot });
    expect(retained.embeddingChunkIds).toEqual([]);
    expect(
      (await port.commitScopedFile({ embeddings: [], plan: retained, profile: local }))
        .reusedEmbeddings
    ).toBe(1);
    await port.commitScopedTextFile({ plan: await port.prepareScopedFile({ snapshot }) });
    await port.replaceFileBindings([{ ...file, profile: second }]);
    expect((await port.prepareScopedFile({ profile: second, snapshot })).embeddingChunkIds).toEqual(
      []
    );
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});
