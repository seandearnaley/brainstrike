import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FileSyntax, ProvidedChunk } from '@brainstrike/indexer';
import { openIndexer } from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { expect, it } from 'vitest';

const deadlines = { closeMs: 5000 };

it('explicit text commits need no inference and replace changed rows', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-text-index-'));
  const port = await openIndexer(
    {
      dbPath: path.join(directory, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
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
  try {
    const plan = await port.prepareFile(snapshot);
    await port.commitTextFile({ plan });
    expect(
      (await port.search({ limit: 100, mode: 'bm25', rootIds: ['r'], text: 'alpha' })).hits
    ).toHaveLength(1);
    expect((await port.prepareFile(snapshot)).unchanged).toBe(true);
    const changed = await port.prepareFile({
      ...snapshot,
      content: 'alpha first\ngamma changed\n',
    });
    await expect(port.commitTextFile({ embeddings: [], plan: changed })).rejects.toThrow();
    await port.commitTextFile({ plan: changed });
    expect(
      (await port.search({ limit: 100, mode: 'bm25', rootIds: ['r'], text: 'beta' })).hits
    ).toHaveLength(0);
    expect(
      (await port.search({ limit: 100, mode: 'bm25', rootIds: ['r'], text: 'gamma' })).hits
    ).toHaveLength(1);
    await port.removeFile({ fileId: 'f', rootId: 'r' });
    expect(
      (await port.search({ limit: 100, mode: 'bm25', rootIds: ['r'], text: 'alpha' })).hits
    ).toHaveLength(0);
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});

it('retains captured canonical symbols and refs during an unchanged recommit and text reopen', async () => {
  const captured = JSON.parse(
    readFileSync(
      new URL(
        import.meta.resolve('@brainstrike/test-utils/fixtures/canonical-provided-chunks.json')
      ),
      'utf8'
    )
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
    const recommit = await port.prepareFile(snapshot);
    const result = await port.commitTextFile({ plan: recommit });
    expect(result.syntaxStatus).toBe('retained');
    const db = openConnection(dbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT * FROM file_symbols ORDER BY seq').all()).toEqual(symbols);
      expect(db.prepare('SELECT * FROM file_symbol_refs ORDER BY seq').all()).toEqual(refs);
      expect(db.prepare('SELECT count(*) AS n FROM file_symbols').get()).toEqual({
        n: captured.result.symbols.length,
      });
      expect(db.prepare('SELECT count(*) AS n FROM file_symbol_refs').get()).toEqual({
        n: captured.result.symbolRefs.length,
      });
    } finally {
      db.close();
    }
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});
