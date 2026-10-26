import { readFileSync } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openIndexer } from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { decoder } from '../src/contracts.js';

const deadlines = { closeMs: 5000 };
const embedding = { indexMode: 'text-only' } as const;
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
      embedding,
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
  rootId = 'root-a'
) {
  const plan = await port.prepareFile(file(content, fileId, rootId));
  await port.commitTextFile({ plan });
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
    const reopened = await openIndexer({ dbPath, embedding, rootIds: ['root-a'] }, deadlines);
    cleanup.push(() => reopened.close());
    expect(
      (await reopened.search({ limit: 10, mode: 'trigram', rootIds: ['root-a'], text: 'ite ind' }))
        .hits[0]?.chunkId
    ).toBe(plan.chunks[0]?.chunkId);
  });

  it('reuses unchanged chunks, atomically replaces changed text rows and rejects stale plans', async () => {
    const { port } = await fixture();
    const first = await add(port, 'first stable\nold removable');
    const unchanged = await port.prepareFile(file('first stable\nold removable'));
    expect(unchanged.unchanged).toBe(true);
    expect((await port.commitTextFile({ plan: unchanged })).writtenChunks).toBe(0);
    const changed = await port.prepareFile(file('first stable\nnew searchable'));
    expect(changed.chunks[0]?.chunkId).toBe(first.chunks[0]?.chunkId);
    expect(changed.chunks[1]?.chunkId).toBe(first.chunks[1]?.chunkId);
    await port.commitTextFile({ plan: changed });
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
    await expect(port.commitTextFile({ plan: first })).rejects.toMatchObject({
      code: 'stale-file-plan',
    });
    await port.removeFile({ fileId: 'canonical-file-1', rootId: 'root-a' });
    expect(
      (await port.search({ limit: 10, mode: 'bm25', rootIds: ['root-a'], text: 'stable' })).hits
    ).toEqual([]);
  });

  it('drains writer work before reset and never deletes unknown existing databases on startup', async () => {
    const { port, dbPath } = await fixture();
    const plan = await port.prepareFile(file('reset only after commit'));
    const committed = port.commitTextFile({ plan });
    await port.destroy();
    await committed;
    for (const suffix of ['', '-wal', '-shm']) {
      await expect(access(`${dbPath}${suffix}`)).rejects.toThrow();
    }
    const foreign = openConnection(dbPath);
    foreign.exec("CREATE TABLE precious(content TEXT); INSERT INTO precious VALUES('never wipe')");
    foreign.close();
    await expect(
      openIndexer({ dbPath, embedding, rootIds: ['root-a'] }, deadlines)
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

  it('rejects interrupted process requests and reopens committed text rows after SIGKILL', async () => {
    const { port, dbPath } = await fixture();
    await add(port, 'committed before process death');
    const plan = await port.prepareFile(
      file(Array.from({ length: 500 }, (_, index) => `pending line ${index}`).join('\n'), 'pending')
    );
    const pending = port.commitTextFile({ plan });
    const failure = expect(pending).rejects.toThrow();
    process.kill((await port.info()).pid, 'SIGKILL');
    await failure;
    await port.close();
    const reopened = await openIndexer({ dbPath, embedding, rootIds: ['root-a'] }, deadlines);
    cleanup.push(() => reopened.close());
    expect(
      (await reopened.search({ limit: 10, mode: 'bm25', rootIds: ['root-a'], text: 'committed' }))
        .hits
    ).toHaveLength(1);
    const audit = openConnection(dbPath, { readonly: true });
    try {
      expect(
        audit
          .prepare(
            "SELECT ((SELECT count(*) FROM file_chunks WHERE file_record_id='pending') IN (0,500)) AS atomic"
          )
          .get()
      ).toEqual({ atomic: 1 });
    } finally {
      audit.close();
    }
  });

  it('validates envelopes and commits under an independent WAL reader snapshot', async () => {
    const { port, dbPath } = await fixture();
    await add(port, 'before snapshot');
    const plan = await port.prepareFile(file('after snapshot'));
    await expect(
      port.search({ limit: 10, mode: 'bm25', rootIds: ['root-a'], text: 'before', unknown: true })
    ).rejects.toThrow();
    const reader = openConnection(dbPath, { readonly: true });
    try {
      reader.exec('BEGIN');
      expect(reader.prepare('SELECT content FROM file_chunks').get()).toMatchObject({
        content: 'before snapshot',
      });
      await port.commitTextFile({ plan });
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
      expect(await port.commitTextFile({ plan, syntax })).toMatchObject({
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
        port.commitTextFile({
          plan,
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
      await port.commitTextFile({ plan, syntax: { refs: [], symbols: [] } });
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
