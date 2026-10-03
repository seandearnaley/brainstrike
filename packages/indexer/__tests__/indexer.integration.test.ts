import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openIndexer } from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { decoder, profileSchema, vectorSchema } from '../src/contracts.js';

const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const profile = {
  dimensions: 384,
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 512,
} as const;
const query = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0.001));
const opposite = Array.from({ length: 384 }, (_, index) => (index === 0 ? 0.001 : 1));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) {
    await dispose();
  }
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-indexer-'));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const dbPath = path.join(directory, 'index.sqlite');
  const port = await openIndexer(
    {
      dbPath,
      embedding: { indexMode: 'vector-configured', profile },
      rootIds: ['root-a', 'root-b'],
    },
    deadlines
  );
  cleanup.push(() => port.close());
  return { dbPath, port };
}
function file(content: string, fileId = 'canonical-file-1', rootId = 'root-a') {
  return { chunkLines: 1, content, fileId, relativePath: `${fileId}.ts`, rootId };
}
async function add(
  port: Awaited<ReturnType<typeof openIndexer>>,
  content: string,
  fileId = 'canonical-file-1',
  rootId = 'root-a',
  vector = query
) {
  const plan = await port.prepareFile(file(content, fileId, rootId));
  await port.commitFile({
    embeddings: plan.embeddingChunkIds.map((chunkId: string) => ({ chunkId, vector })),
    plan,
    profile,
  });
  return plan;
}

describe('isolated SQLite indexer', () => {
  it('owns WAL writes in a worker inside a separate Node process and survives reopen', async () => {
    const { port, dbPath } = await fixture();
    const info = await port.info();
    expect(info.pid).not.toBe(process.pid);
    expect(info.writerThreadId).toBeGreaterThan(0);
    expect(info.journalMode).toBe('wal');
    expect(info.readerQueryOnly).toBe(1);
    expect(info.vecVersion).toBe('v0.1.9');
    const plan = await add(port, 'canonical sqlite indexing');
    const hits = await port.search({
      limit: 10,
      mode: 'bm25',
      rootIds: ['root-a'],
      text: 'sqlite',
    });
    expect(hits.hits[0]).toMatchObject({
      chunkId: plan.chunks[0]?.chunkId,
      fileId: 'canonical-file-1',
      rootId: 'root-a',
    });
    await port.close();
    const reopened = await openIndexer(
      { dbPath, embedding: { indexMode: 'vector-configured', profile }, rootIds: ['root-a'] },
      deadlines
    );
    cleanup.push(() => reopened.close());
    expect(
      (await reopened.search({ limit: 10, mode: 'trigram', rootIds: ['root-a'], text: 'ite ind' }))
        .hits[0]?.chunkId
    ).toBe(plan.chunks[0]?.chunkId);
  });

  it('filters each authorized root before coarse top100, then exactly rescores auxiliary floats', async () => {
    const { port, dbPath } = await fixture();
    await add(port, 'decoy', 'decoy', 'root-a', opposite);
    const desired = await add(port, 'desired sqlite', 'desired');
    await add(
      port,
      Array.from({ length: 110 }, () => 'sqlite unauthorized').join('\n'),
      'foreign',
      'root-b'
    );
    const scoped = await port.search({
      limit: 10,
      mode: 'vector',
      profile,
      rootIds: ['root-a'],
      vector: query,
    });
    expect(scoped.hits[0]?.chunkId).toBe(desired.chunks[0]?.chunkId);
    expect(scoped.hits[0]?.score).toBeCloseTo(0, 6);
    expect(scoped.hits).toHaveLength(2);
    expect(
      (
        await port.search({
          limit: 10,
          mode: 'vector',
          profile,
          rootIds: ['root-a', 'root-b'],
          vector: query,
        })
      ).candidateCount
    ).toBe(102);
    await expect(
      port.search({
        limit: 10,
        mode: 'vector',
        profile: { ...profile, tokenCap: 256 },
        rootIds: ['root-a'],
        vector: query,
      })
    ).rejects.toMatchObject({ code: 'rebuild-required' });
    expect(scoped.candidateCount).toBe(2);
    expect(scoped.hits.every((hit) => hit.rootId === 'root-a')).toBe(true);
    expect(
      (await port.search({ limit: 1, mode: 'bm25', rootIds: ['root-a'], text: 'sqlite' })).hits[0]
        ?.fileId
    ).toBe('desired');
    expect(
      (await port.search({ limit: 10, mode: 'vector', profile, rootIds: [], vector: query })).hits
    ).toEqual([]);
    await expect(
      port.search({ limit: 10, mode: 'bm25', rootIds: ['unmounted'], text: 'sqlite' })
    ).rejects.toMatchObject({ code: 'root-not-authorized' });
    const db = openConnection(dbPath, { readonly: true });
    try {
      expect(
        db.prepare("SELECT sql FROM sqlite_master WHERE name='vec_chunks'").get()
      ).toMatchObject({ sql: expect.stringContaining('root_id TEXT PARTITION KEY') });
      expect(
        db.prepare("SELECT sql FROM sqlite_master WHERE name='vec_chunks'").get()
      ).toMatchObject({ sql: expect.stringContaining('+emb BLOB') });
    } finally {
      db.close();
    }
  });

  it('reuses unchanged chunks, atomically replaces changed text/vector rows and rejects stale plans', async () => {
    const { port } = await fixture();
    const first = await add(port, 'first stable\nold removable');
    const unchanged = await port.prepareFile(file('first stable\nold removable'));
    expect(unchanged.unchanged).toBe(true);
    expect(unchanged.embeddingChunkIds).toEqual([]);
    expect(
      (await port.commitFile({ embeddings: [], plan: unchanged, profile })).writtenChunks
    ).toBe(0);
    const changed = await port.prepareFile(file('first stable\nnew searchable'));
    expect(changed.embeddingChunkIds).toEqual([changed.chunks[1]?.chunkId]);
    expect(changed.chunks[0]?.chunkId).toBe(first.chunks[0]?.chunkId);
    expect(changed.chunks[1]?.chunkId).toBe(first.chunks[1]?.chunkId);
    await port.commitFile({
      embeddings: [{ chunkId: changed.embeddingChunkIds[0], vector: opposite }],
      plan: changed,
      profile,
    });
    expect(
      (
        await port.search({
          limit: 10,
          mode: 'trigram',
          rootIds: ['root-a'],
          text: 'old removable',
        })
      ).hits
    ).toEqual([]);
    expect(
      (await port.search({ limit: 10, mode: 'bm25', rootIds: ['root-a'], text: 'searchable' })).hits
    ).toHaveLength(1);
    await expect(
      port.commitFile({
        embeddings: first.embeddingChunkIds.map((chunkId: string) => ({ chunkId, vector: query })),
        plan: first,
        profile,
      })
    ).rejects.toMatchObject({ code: 'stale-file-plan' });
    await port.removeFile({ fileId: 'canonical-file-1', rootId: 'root-a' });
    expect(
      (
        await port.search({
          limit: 10,
          mode: 'vector',
          profile,
          rootIds: ['root-a'],
          vector: query,
        })
      ).hits
    ).toEqual([]);
  });

  it.each([
    ['tokenCap', { ...profile, tokenCap: 256 }],
    ['dimensions', { ...profile, dimensions: 768 }],
    ['dtype', { ...profile, dtype: 'fp32' }],
    ['revision', { ...profile, revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f' }],
    ['modelId', { ...profile, modelId: 'fused/minilm' }],
  ])('refuses changed %s without deleting the existing index', async (_field, replacement) => {
    const { port, dbPath } = await fixture();
    await add(port, 'retained index data');
    await port.close();
    await expect(
      openIndexer(
        {
          dbPath,
          embedding: { indexMode: 'vector-configured', profile: replacement },
          rootIds: ['root-a'],
        },
        deadlines
      )
    ).rejects.toMatchObject({ code: 'rebuild-required' });
    const reopened = await openIndexer(
      { dbPath, embedding: { indexMode: 'vector-configured', profile }, rootIds: ['root-a'] },
      deadlines
    );
    cleanup.push(() => reopened.close());
    expect(
      (await reopened.search({ limit: 10, mode: 'bm25', rootIds: ['root-a'], text: 'retained' }))
        .hits
    ).toHaveLength(1);
  });

  it('drains writer work before reset and never deletes unknown existing databases on startup', async () => {
    const { port, dbPath } = await fixture();
    const plan = await port.prepareFile(file('reset only after commit'));
    const committed = port.commitFile({
      embeddings: [{ chunkId: plan.chunks[0]?.chunkId, vector: query }],
      plan,
      profile,
    });
    await port.destroy();
    await committed;
    for (const suffix of ['', '-wal', '-shm']) {
      await expect(access(`${dbPath}${suffix}`)).rejects.toThrow();
    }
    const foreign = openConnection(dbPath);
    foreign.exec("CREATE TABLE precious(content TEXT); INSERT INTO precious VALUES('never wipe')");
    foreign.close();
    await expect(
      openIndexer(
        { dbPath, embedding: { indexMode: 'vector-configured', profile }, rootIds: ['root-a'] },
        deadlines
      )
    ).rejects.toMatchObject({
      code: 'rebuild-required',
    });
    const retained = openConnection(dbPath, { readonly: true });
    try {
      expect(retained.prepare('SELECT content FROM precious').get()).toEqual({
        content: 'never wipe',
      });
    } finally {
      retained.close();
    }
  });

  it('rejects interrupted process requests and reopens committed text/vector rows after SIGKILL', async () => {
    const { port, dbPath } = await fixture();
    await add(port, 'committed before process death');
    const plan = await port.prepareFile(
      file(Array.from({ length: 500 }, (_, index) => `pending line ${index}`).join('\n'), 'pending')
    );
    const pending = port.commitFile({
      embeddings: plan.embeddingChunkIds.map((chunkId: string) => ({ chunkId, vector: query })),
      plan,
      profile,
    });
    const failure = expect(pending).rejects.toThrow();
    process.kill((await port.info()).pid, 'SIGKILL');
    await failure;
    await port.close();
    const reopened = await openIndexer(
      { dbPath, embedding: { indexMode: 'vector-configured', profile }, rootIds: ['root-a'] },
      deadlines
    );
    cleanup.push(() => reopened.close());
    expect(
      (await reopened.search({ limit: 10, mode: 'bm25', rootIds: ['root-a'], text: 'committed' }))
        .hits
    ).toHaveLength(1);
    const audit = openConnection(dbPath, { readonly: true });
    try {
      const counts = audit
        .prepare(
          'SELECT (SELECT count(*) FROM file_chunks) AS chunks,(SELECT count(*) FROM vec_chunks) AS vectors'
        )
        .get();
      expect(counts).toMatchObject({ chunks: expect.any(Number), vectors: expect.any(Number) });
      expect(
        audit
          .prepare(
            "SELECT ((SELECT count(*) FROM file_chunks)=(SELECT count(*) FROM vec_chunks)) AS consistent,((SELECT count(*) FROM file_chunks WHERE file_record_id='pending') IN (0,500)) AS atomic"
          )
          .get()
      ).toEqual({ atomic: 1, consistent: 1 });
    } finally {
      audit.close();
    }
  });

  it('validates envelopes/vectors and commits under an independent WAL reader snapshot', async () => {
    const { port, dbPath } = await fixture();
    await add(port, 'before snapshot');
    const plan = await port.prepareFile(file('after snapshot'));
    await expect(
      port.commitFile({
        embeddings: [{ chunkId: plan.chunks[0]?.chunkId, vector: [Number.NaN] }],
        plan,
        profile,
      })
    ).rejects.toThrow();
    await expect(
      port.commitFile({
        embeddings: [{ chunkId: plan.chunks[0]?.chunkId, vector: query.slice(0, 383) }],
        plan,
        profile,
      })
    ).rejects.toThrow();
    await expect(
      port.search({ limit: 10, mode: 'bm25', rootIds: ['root-a'], text: 'before', unknown: true })
    ).rejects.toThrow();
    const reader = openConnection(dbPath, { readonly: true });
    try {
      reader.exec('BEGIN');
      expect(reader.prepare('SELECT content FROM file_chunks').get()).toMatchObject({
        content: 'before snapshot',
      });
      await port.commitFile({
        embeddings: [{ chunkId: plan.chunks[0]?.chunkId, vector: query }],
        plan,
        profile,
      });
      expect(reader.prepare('SELECT content FROM file_chunks').get()).toMatchObject({
        content: 'before snapshot',
      });
      reader.exec('COMMIT');
      expect(reader.prepare('SELECT content FROM file_chunks').get()).toMatchObject({
        content: 'after snapshot',
      });
    } finally {
      reader.close();
    }
    expect(
      (await port.search({ limit: 10, mode: 'bm25', rootIds: ['root-a'], text: 'after' })).hits
    ).toHaveLength(1);
  });
  it('persists the actual hidden-renderer fused MiniLM vector with its complete producer identity', async () => {
    const recorded = decoder(
      Schema.Struct({
        profile: Schema.Struct({
          batchTokenBudget: Schema.Int,
          device: Schema.String,
          dimensions: Schema.Int,
          dtype: Schema.String,
          maxInputTokens: Schema.Int,
          modelId: Schema.String,
          normalization: Schema.String,
          pooling: Schema.String,
          revision: Schema.String,
          specialTokensIncluded: Schema.Boolean,
        }),
        runtime: Schema.Unknown,
        source: Schema.Struct({
          endOffset: Schema.Int,
          repositoryFile: Schema.String,
          sha256: Schema.String,
          startOffset: Schema.Int,
          text: Schema.String,
        }),
        vector: vectorSchema,
      })
    )(
      JSON.parse(readFileSync(new URL('./fixtures/fused-minilm-384.json', import.meta.url), 'utf8'))
    );
    expect(createHash('sha256').update(recorded.source.text).digest('hex')).toBe(
      recorded.source.sha256
    );
    const producer = decoder(profileSchema)({
      dimensions: recorded.profile.dimensions,
      dtype: recorded.profile.dtype,
      modelId: recorded.profile.modelId,
      revision: recorded.profile.revision,
      tokenCap: recorded.profile.maxInputTokens,
    });
    const { port: initial, dbPath } = await fixture();
    await initial.destroy();
    const port = await openIndexer(
      {
        dbPath,
        embedding: { indexMode: 'vector-configured', profile: producer },
        rootIds: ['root-a'],
      },
      deadlines
    );
    cleanup.push(() => port.close());
    const plan = await port.prepareFile({ ...file(recorded.source.text), chunkLines: 100 });
    expect(plan.chunks).toHaveLength(1);
    await port.commitFile({
      embeddings: [{ chunkId: plan.chunks[0]?.chunkId, vector: recorded.vector }],
      plan,
      profile: producer,
    });
    const hits = await port.search({
      limit: 1,
      mode: 'vector',
      profile: producer,
      rootIds: ['root-a'],
      vector: recorded.vector,
    });
    expect(hits.hits[0]?.score).toBeCloseTo(0, 6);
    const db = openConnection(dbPath, { readonly: true });
    try {
      const row = decoder(Schema.Struct({ emb: Schema.Unknown }))(
        db.prepare('SELECT emb FROM vec_chunks').get()
      );
      expect(Buffer.isBuffer(row.emb)).toBe(true);
      if (!Buffer.isBuffer(row.emb)) {
        throw new Error('Expected native Float32 blob');
      }
      const emb = row.emb;
      expect(emb.byteLength).toBe(384 * 4);
      expect(Array.from({ length: 384 }, (_, index) => emb.readFloatLE(index * 4))).toEqual(
        recorded.vector
      );
    } finally {
      db.close();
    }
  });

  it('preserves historical callers by name and atomically replaces canonical symbol/reference batches', async () => {
    const corpus = decoder(
      Schema.Struct({
        cases: Schema.Array(Schema.Unknown),
        chunks: Schema.Array(Schema.Unknown),
        dims: Schema.Unknown,
        files: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })),
        refs: Schema.Array(
          Schema.Struct({
            file_record_id: Schema.String,
            from_symbol_seq: Schema.Int,
            kind: Schema.Literal('call'),
            line: Schema.Int,
            name: Schema.String,
            seq: Schema.Int,
          })
        ),
        symbols: Schema.Array(
          Schema.Struct({
            end_line: Schema.Int,
            file_record_id: Schema.String,
            kind: Schema.Literal('function'),
            name: Schema.String,
            seq: Schema.Int,
            start_line: Schema.Int,
          })
        ),
      })
    )(JSON.parse(readFileSync(new URL('./fixtures/symbol-corpus.json', import.meta.url), 'utf8')));
    const { port, dbPath } = await fixture();
    for (const record of corpus.files) {
      const content = `canonical syntax fixture ${record.id}`;
      const plan = await port.prepareFile({
        ...file(content, record.id),
        relativePath: record.path,
      });
      const syntax = {
        refs: corpus.refs
          .filter((ref) => ref.file_record_id === record.id)
          .map((ref) => ({
            fileRecordId: record.id,
            fromSymbolSeq: ref.from_symbol_seq,
            kind: ref.kind,
            line: ref.line,
            name: ref.name,
            seq: ref.seq,
          })),
        symbols: corpus.symbols
          .filter((symbol) => symbol.file_record_id === record.id)
          .map((symbol) => ({
            endLine: symbol.end_line,
            endOffset: content.length,
            exported: false,
            fileRecordId: record.id,
            kind: symbol.kind,
            name: symbol.name,
            seq: symbol.seq,
            startLine: symbol.start_line,
            startOffset: 0,
          })),
      };
      expect(
        await port.commitFile({
          embeddings: plan.embeddingChunkIds.map((chunkId) => ({ chunkId, vector: query })),
          plan,
          profile,
          syntax,
        })
      ).toMatchObject({
        syntaxStatus: 'replaced',
        writtenRefs: syntax.refs.length,
        writtenSymbols: syntax.symbols.length,
      });
    }
    const db = openConnection(dbPath, { readonly: true });
    try {
      expect(
        db
          .prepare(
            "SELECT f.path,s.name AS caller,r.name AS target FROM file_symbol_refs r JOIN file_symbols s ON s.file_record_id=r.file_record_id AND s.seq=r.from_symbol_seq JOIN file_records f ON f.id=r.file_record_id WHERE r.name='startEmbeddingWorker'"
          )
          .all()
      ).toEqual([{ caller: 'run', path: 'src/run.ts', target: 'startEmbeddingWorker' }]);
      const plan = await port.prepareFile({
        ...file('replacement run', 'file-run'),
        relativePath: 'src/run.ts',
      });
      await expect(
        port.commitFile({
          embeddings: plan.embeddingChunkIds.map((chunkId) => ({ chunkId, vector: query })),
          plan,
          profile,
          syntax: {
            refs: [
              {
                fileRecordId: 'file-run',
                fromSymbolSeq: 0,
                kind: 'call',
                line: 1,
                name: 'invalid-cross-file',
                seq: 0,
              },
            ],
            symbols: [],
          },
        })
      ).rejects.toThrow();
      expect(
        db.prepare("SELECT name FROM file_symbol_refs WHERE file_record_id='file-run'").all()
      ).toEqual([{ name: 'startEmbeddingWorker' }]);
      expect(
        db.prepare("SELECT content FROM file_chunks WHERE file_record_id='file-run'").get()
      ).toEqual({ content: 'canonical syntax fixture file-run' });
      await port.commitFile({
        embeddings: plan.embeddingChunkIds.map((chunkId) => ({ chunkId, vector: query })),
        plan,
        profile,
        syntax: { refs: [], symbols: [] },
      });
      expect(
        db.prepare("SELECT count(*) AS n FROM file_symbols WHERE file_record_id='file-run'").get()
      ).toEqual({ n: 0 });
      expect(
        db
          .prepare("SELECT count(*) AS n FROM file_symbol_refs WHERE file_record_id='file-run'")
          .get()
      ).toEqual({ n: 0 });
      await port.removeFile({ fileId: 'file-main', rootId: 'root-a' });
      expect(
        db.prepare("SELECT count(*) AS n FROM file_symbols WHERE file_record_id='file-main'").get()
      ).toEqual({ n: 0 });
      expect(
        db
          .prepare("SELECT count(*) AS n FROM file_symbol_refs WHERE file_record_id='file-main'")
          .get()
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
