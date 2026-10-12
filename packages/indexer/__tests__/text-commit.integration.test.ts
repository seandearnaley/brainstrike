import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FileSyntax, ProvidedChunk } from '@brainstrike/indexer';
import { openIndexer } from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { expect, it } from 'vitest';

const profile = {
  dimensions: 384,
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 512,
} as const;
const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const vector = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));

it('explicit text commits need no inference, preserve valid vectors and permit strict later backfill', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-text-index-'));
  const port = await openIndexer(
    {
      dbPath: path.join(directory, 'index.sqlite'),
      embedding: { indexMode: 'vector-configured', profile },
      rootIds: ['r'],
    },
    deadlines
  );
  const snapshot = {
    chunkLines: 1,
    content: 'alpha first\nbeta second\n',
    fileId: 'f',
    relativePath: 'f.ts',
    rootId: 'r',
  };
  const query = { limit: 100, mode: 'vector', profile, rootIds: ['r'], vector };
  try {
    const plan = await port.prepareFile(snapshot);
    await expect(port.commitFile({ embeddings: [], plan, profile })).rejects.toThrow();
    await port.commitTextFile({ plan });
    expect(
      (await port.search({ limit: 100, mode: 'bm25', rootIds: ['r'], text: 'alpha' })).hits
    ).toHaveLength(1);
    expect((await port.search(query)).hits).toHaveLength(0);
    const backfill = await port.prepareFile(snapshot);
    expect(backfill.unchanged).toBe(true);
    expect(backfill.embeddingChunkIds).toHaveLength(2);
    await expect(port.commitFile({ embeddings: [], plan: backfill, profile })).rejects.toThrow();
    await expect(
      port.commitFile({ embeddings: [], plan: { ...backfill, embeddingChunkIds: [] }, profile })
    ).rejects.toThrow();
    await port.commitFile({
      embeddings: backfill.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
      plan: backfill,
      profile,
    });
    expect((await port.search(query)).hits).toHaveLength(2);
    const changed = await port.prepareFile({
      ...snapshot,
      content: 'alpha first\ngamma changed\n',
    });
    await expect(port.commitTextFile({ embeddings: [], plan: changed })).rejects.toThrow();
    await port.commitTextFile({ plan: changed });
    expect((await port.search(query)).hits).toHaveLength(1);
    const missing = await port.prepareFile({
      ...snapshot,
      content: 'alpha first\ngamma changed\n',
    });
    expect(missing.embeddingChunkIds).toHaveLength(1);
    expect(
      (await port.search({ limit: 100, mode: 'bm25', rootIds: ['r'], text: 'gamma' })).hits
    ).toHaveLength(1);
    await port.removeFile({ fileId: 'f', rootId: 'r' });
    expect((await port.search(query)).hits).toHaveLength(0);
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});

it('retains captured canonical symbols and refs during unchanged vector backfill and text reopen', async () => {
  const captured = JSON.parse(
    readFileSync(new URL('./fixtures/canonical-provided-chunks.json', import.meta.url), 'utf8')
  ) as {
    content: string;
    relativePath: string;
    fileId: string;
    result: {
      chunks: ProvidedChunk[];
      symbols: Omit<FileSyntax['symbols'][number], 'seq' | 'fileRecordId'>[];
      symbolRefs: Array<
        Omit<FileSyntax['refs'][number], 'seq' | 'fileRecordId' | 'fromSymbolSeq'> & {
          enclosingSymbolIndex?: number;
        }
      >;
    };
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-text-graph-'));
  const dbPath = path.join(directory, 'index.sqlite');
  const options = { dbPath, embedding: { indexMode: 'text-only' }, rootIds: ['r'] };
  let port = await openIndexer(options, deadlines);
  try {
    const snapshot = {
      content: captured.content,
      fileId: captured.fileId,
      providedChunks: captured.result.chunks,
      relativePath: captured.relativePath,
      rootId: 'r',
    };
    const plan = await port.prepareFile(snapshot);
    await port.commitTextFile({
      plan,
      syntax: {
        refs: captured.result.symbolRefs.map(({ enclosingSymbolIndex, ...ref }, seq) => ({
          ...ref,
          fileRecordId: captured.fileId,
          seq,
          ...(enclosingSymbolIndex === undefined ? {} : { fromSymbolSeq: enclosingSymbolIndex }),
        })),
        symbols: captured.result.symbols.map((symbol, seq) => ({
          ...symbol,
          fileRecordId: captured.fileId,
          seq,
        })),
      },
    });
    await port.close();
    port = await openIndexer(options, deadlines);
    const before = openConnection(dbPath, { readonly: true });
    const symbols = before.prepare('SELECT * FROM file_symbols ORDER BY seq').all();
    const refs = before.prepare('SELECT * FROM file_symbol_refs ORDER BY seq').all();
    before.close();
    await port.configureVectorProfile(profile);
    const after = openConnection(dbPath, { readonly: true });
    expect(after.prepare('SELECT * FROM file_symbols ORDER BY seq').all()).toEqual(symbols);
    expect(after.prepare('SELECT * FROM file_symbol_refs ORDER BY seq').all()).toEqual(refs);
    after.close();
    const backfill = await port.prepareFile(snapshot);
    const result = await port.commitFile({
      embeddings: backfill.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
      plan: backfill,
      profile,
    });
    expect(result.syntaxStatus).toBe('retained');
    const db = openConnection(dbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM file_symbols').get()).toEqual({
        n: captured.result.symbols.length,
      });
      expect(db.prepare('SELECT count(*) AS n FROM file_symbol_refs').get()).toEqual({
        n: captured.result.symbolRefs.length,
      });
    } finally {
      db.close();
    }
    await port.close();
    const corrupt = openConnection(dbPath);
    try {
      const id = corrupt.prepare('SELECT pk FROM file_chunks LIMIT 1').pluck().get();
      if (typeof id !== 'number') {
        throw new TypeError('Expected real persisted chunk id.');
      }
      corrupt.prepare('DELETE FROM vec_chunks WHERE id=?').run(BigInt(id));
    } finally {
      corrupt.close();
    }
    await expect(
      openIndexer({ ...options, embedding: { indexMode: 'open-existing' } }, deadlines)
    ).rejects.toThrow('Derived chunk/vector counts disagree');
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});
