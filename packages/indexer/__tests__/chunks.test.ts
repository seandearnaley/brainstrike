import { fileChunks, vectorProfileHash } from '@brainstrike/indexer';
import { describe, expect, it } from 'vitest';

const profile = {
  dimensions: 1536,
  distance: 'cosine',
  modelId: 'text-embedding-3-small',
  provider: 'openai',
} as const;
const snapshot = {
  chunkLines: 1,
  content: 'const reader = openReader();\nawait writer.commit();\n',
  fileId: 'canonical-file',
  relativePath: 'src/worker.ts',
  rootId: 'root-a',
};
describe('file chunk and vector profile identity', () => {
  it('preserves exact source bytes and positions, with stable content-sensitive ids', () => {
    const chunks = fileChunks(snapshot);
    expect(chunks.map((chunk) => chunk.content).join('')).toBe(snapshot.content);
    expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    const changed = fileChunks({
      ...snapshot,
      content: 'const reader = openReader();\nawait writer.close();\n',
    });
    expect(changed.map((chunk) => chunk.chunkId)).toEqual(chunks.map((chunk) => chunk.chunkId));
    expect(changed[0]?.contentHash).toBe(chunks[0]?.contentHash);
    expect(changed[1]?.contentHash).not.toBe(chunks[1]?.contentHash);
    expect(fileChunks({ ...snapshot, rootId: 'root-b' })[0]?.chunkId).not.toBe(chunks[0]?.chunkId);
    expect(fileChunks({ ...snapshot, content: '' })).toEqual([]);
  });
  it('hashes every complete profile field and refuses malformed profiles and root paths', () => {
    for (const field of [
      { provider: 'voyage' },
      { modelId: 'text-embedding-3-large' },
      { dimensions: 768 },
      { distance: 'l2' },
    ]) {
      expect(vectorProfileHash({ ...profile, ...field })).not.toBe(vectorProfileHash(profile));
    }
    expect(() => vectorProfileHash({ ...profile, dimensions: 0 })).toThrow();
    expect(() => vectorProfileHash({ ...profile, extra: 'unreviewed' })).toThrow();
    expect(() => fileChunks({ ...snapshot, relativePath: '../escape.ts' })).toThrow();
  });
  it('keeps text chunks free of an embedding identity', () => {
    expect(fileChunks(snapshot)[0]?.embeddingHash).toBeNull();
  });
});
