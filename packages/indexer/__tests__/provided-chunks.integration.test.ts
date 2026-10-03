import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openIndexer } from '@brainstrike/indexer';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProvidedChunk } from '../src/contracts.js';

const captured = JSON.parse(
  readFileSync(new URL('./fixtures/canonical-provided-chunks.json', import.meta.url), 'utf8')
) as {
  content: string;
  sourceHash: string;
  relativePath: string;
  result: { chunks: ProvidedChunk[] };
};
const profile = {
  dimensions: 384,
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 512,
} as const;
const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const vector = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
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
    { dbPath, embedding: { indexMode: 'vector-configured', profile }, rootIds: ['r'] },
    deadlines
  );
  cleanup.push(() => port.close());
  return { dbPath, port };
}
async function commit(port: Awaited<ReturnType<typeof openIndexer>>, input: unknown = snapshot) {
  const plan = await port.prepareFile(input);
  await port.commitFile({
    embeddings: plan.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
    plan,
    profile,
  });
  return plan;
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
    const query = { limit: 100, mode: 'vector', profile, rootIds: ['r'], vector };
    const hits = (await port.search(query)).hits;
    for (const chunk of captured.result.chunks) {
      expect(hits).toContainEqual(expect.objectContaining(chunk));
    }
    await port.close();
    const reopened = await openIndexer(
      { dbPath, embedding: { indexMode: 'vector-configured', profile }, rootIds: ['r'] },
      deadlines
    );
    cleanup.push(() => reopened.close());
    expect((await reopened.search(query)).hits).toEqual(hits);
    expect((await reopened.prepareFile(snapshot)).embeddingChunkIds).toEqual([]);
  });
  it('rejects malformed provided source/hash/positions without falling back to line chunks or changing rows', async () => {
    const { port } = await host();
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
    await expect(port.prepareFile({ ...snapshot, chunkLines: 1 })).rejects.toThrow();
    await expect(
      port.prepareFile({ ...snapshot, providedChunks: [first, first] })
    ).rejects.toThrow();
    expect(
      (await port.search({ limit: 100, mode: 'vector', profile, rootIds: ['r'], vector })).hits
    ).toHaveLength(captured.result.chunks.length);
  });
  it('refuses tampered prepared spans atomically and updates producer metadata while reusing vector bytes', async () => {
    const { port } = await host();
    const plan = await port.prepareFile(snapshot);
    await expect(
      port.commitFile({
        embeddings: plan.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
        plan: { ...plan, chunks: plan.chunks.map((chunk) => ({ ...chunk, startOffset: 1 })) },
        profile,
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
    expect(update.embeddingChunkIds).toEqual([]);
    await port.commitFile({ embeddings: [], plan: update, profile });
    const hits = (
      await port.search({ limit: 100, mode: 'vector', profile, rootIds: ['r'], vector })
    ).hits;
    expect(hits.every((hit) => hit.chunkSize === captured.result.chunks[0]!.chunkSize + 1)).toBe(
      true
    );
  });
});
