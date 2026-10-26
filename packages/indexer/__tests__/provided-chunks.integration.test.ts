import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openIndexer } from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProvidedChunk } from '../src/contracts.js';

const captured = JSON.parse(
  readFileSync(
    new URL(import.meta.resolve('@brainstrike/test-utils/fixtures/canonical-provided-chunks.json')),
    'utf8'
  )
) as {
  content: string;
  sourceHash: string;
  relativePath: string;
  result: { chunks: ProvidedChunk[] };
};
const deadlines = { closeMs: 5000 };
const snapshot = {
  content: captured.content,
  fileId: 'canonical-file',
  providedChunks: captured.result.chunks,
  relativePath: captured.relativePath,
  rootId: 'r',
};
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) {
    await dispose();
  }
});
async function host() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-provided-chunks-'));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const dbPath = path.join(directory, 'index.sqlite');
  const port = await openIndexer(
    { dbPath, embedding: { indexMode: 'text-only' }, rootIds: ['r'] },
    deadlines
  );
  cleanup.push(() => port.close());
  return { dbPath, port };
}
async function commit(port: Awaited<ReturnType<typeof openIndexer>>, input: unknown = snapshot) {
  const plan = await port.prepareFile(input);
  await port.commitTextFile({ plan });
  return plan;
}
/** The chunk rows the index holds, with their producer metadata. */
function storedChunks(dbPath: string): unknown[] {
  const db = openConnection(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        'SELECT content,content_hash AS contentHash,start_line AS startLine,end_line AS endLine,chunk_index AS chunkIndex,chunk_size AS chunkSize,chunk_type AS chunkType,start_offset AS startOffset,end_offset AS endOffset,token_count AS tokenCount FROM file_chunks ORDER BY chunk_index'
      )
      .all();
  } finally {
    db.close();
  }
}
describe('canonical provided chunks through actual index process', () => {
  it('preserves captured parser segmentation, spans, hashes and metadata through reopen', async () => {
    expect(createHash('sha256').update(captured.content).digest('hex')).toBe(captured.sourceHash);
    const { port, dbPath } = await host();
    const plan = await commit(port);
    expect(plan.chunks).toHaveLength(captured.result.chunks.length);
    for (const [index, chunk] of plan.chunks.entries()) {
      expect(chunk).toMatchObject(captured.result.chunks[index]!);
    }
    const stored = storedChunks(dbPath);
    for (const chunk of captured.result.chunks) {
      expect(stored).toContainEqual(expect.objectContaining(chunk));
    }
    await port.close();
    const reopened = await openIndexer(
      { dbPath, embedding: { indexMode: 'text-only' }, rootIds: ['r'] },
      deadlines
    );
    cleanup.push(() => reopened.close());
    expect(storedChunks(dbPath)).toEqual(stored);
    expect((await reopened.prepareFile(snapshot)).unchanged).toBe(true);
  });
  it('rejects malformed provided source/hash/positions without falling back to line chunks or changing rows', async () => {
    const { port, dbPath } = await host();
    await commit(port);
    const first = captured.result.chunks[0]!;
    for (const change of [
      { contentHash: '0'.repeat(64) },
      { startOffset: first.startOffset + 1 },
      { endOffset: captured.content.length + 1 },
      { startLine: first.startLine + 1 },
      { chunkIndex: -1 },
      { tokenCount: Number.NaN },
      { chunkType: 'invented' },
    ]) {
      await expect(
        port.prepareFile({
          ...snapshot,
          providedChunks: [{ ...first, ...change }, ...captured.result.chunks.slice(1)],
        })
      ).rejects.toThrow();
    }
    // Text that only drops a line break (a splitter's rejoined copy) is not the
    // span: grep would put every later line of the chunk on the wrong line
    // (BST-1989). The hash matches the changed text, so only the span refuses it.
    const multiline = captured.result.chunks.find((chunk) => /\S\n[ \t]*\S/u.test(chunk.content));
    if (!multiline) {
      throw new Error('The captured fixture needs a multi-line chunk.');
    }
    const joined = multiline.content.replace(/(\S)\n[ \t]*(\S)/u, '$1$2');
    await expect(
      port.prepareFile({
        ...snapshot,
        providedChunks: captured.result.chunks.map((chunk) =>
          chunk === multiline
            ? {
                ...chunk,
                content: joined,
                contentHash: createHash('sha256').update(joined).digest('hex'),
              }
            : chunk
        ),
      })
    ).rejects.toThrow('source span does not match');
    await expect(port.prepareFile({ ...snapshot, chunkLines: 1 })).rejects.toThrow();
    await expect(
      port.prepareFile({ ...snapshot, providedChunks: [first, first] })
    ).rejects.toThrow();
    expect(storedChunks(dbPath)).toHaveLength(captured.result.chunks.length);
  });
  it('refuses tampered prepared spans atomically and updates producer metadata in place', async () => {
    const { port, dbPath } = await host();
    const plan = await port.prepareFile(snapshot);
    await expect(
      port.commitTextFile({
        plan: { ...plan, chunks: plan.chunks.map((chunk) => ({ ...chunk, startOffset: 1 })) },
      })
    ).rejects.toThrow();
    await commit(port);
    const changed = {
      ...snapshot,
      providedChunks: captured.result.chunks.map((chunk) => ({
        ...chunk,
        chunkSize: chunk.chunkSize + 1,
      })),
    };
    const update = await port.prepareFile(changed);
    expect(update.unchanged).toBe(false);
    await port.commitTextFile({ plan: update });
    expect(
      storedChunks(dbPath).every(
        (chunk) =>
          (chunk as { chunkSize: number }).chunkSize === captured.result.chunks[0]!.chunkSize + 1
      )
    ).toBe(true);
  });
});
