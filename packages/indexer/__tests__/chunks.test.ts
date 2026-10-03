import { embeddingProfileHash, fileChunks } from '@brainstrike/indexer';
import { describe, expect, it } from 'vitest';

const profile = {
  dimensions: 384,
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 512,
} as const;
const snapshot = {
  chunkLines: 1,
  content: 'const reader = openReader();\nawait writer.commit();\n',
  fileId: 'canonical-file',
  relativePath: 'src/worker.ts',
  rootId: 'root-a',
};
describe('file chunk and embedding identity', () => {
  it('preserves exact source bytes and positions, with stable ids and content-sensitive embeddings', () => {
    const chunks = fileChunks(snapshot, profile);
    expect(chunks.map((chunk) => chunk.content).join('')).toBe(snapshot.content);
    expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    const changed = fileChunks(
      { ...snapshot, content: 'const reader = openReader();\nawait writer.close();\n' },
      profile
    );
    expect(changed.map((chunk) => chunk.chunkId)).toEqual(chunks.map((chunk) => chunk.chunkId));
    expect(changed[0]?.embeddingHash).toBe(chunks[0]?.embeddingHash);
    expect(changed[1]?.embeddingHash).not.toBe(chunks[1]?.embeddingHash);
    expect(fileChunks({ ...snapshot, rootId: 'root-b' }, profile)[0]?.chunkId).not.toBe(
      chunks[0]?.chunkId
    );
    expect(fileChunks({ ...snapshot, content: '' }, profile)).toEqual([]);
  });
  it('hashes every complete profile field and refuses malformed profiles and root paths', () => {
    for (const field of [
      { modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX' },
      { revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f' },
      { dtype: 'fp16' },
      { dimensions: 768 },
      { tokenCap: 256 },
    ]) {
      expect(embeddingProfileHash({ ...profile, ...field })).not.toBe(
        embeddingProfileHash(profile)
      );
    }
    expect(() => embeddingProfileHash({ ...profile, tokenCap: 0 })).toThrow();
    expect(() => embeddingProfileHash({ ...profile, extra: 'unreviewed' })).toThrow();
    expect(() => fileChunks({ ...snapshot, relativePath: '../escape.ts' }, profile)).toThrow();
  });
  it('keeps text identity explicit and refuses fabricated configured profile hashes', () => {
    expect(fileChunks(snapshot, { indexMode: 'text-only' })[0]?.embeddingHash).toBeNull();
    const configured = {
      indexMode: 'vector-configured',
      profile,
      profileHash: embeddingProfileHash(profile),
    } as const;
    expect(fileChunks(snapshot, configured)).toEqual(fileChunks(snapshot, profile));
    expect(() => fileChunks(snapshot, { ...configured, profileHash: 'f'.repeat(64) })).toThrow(
      'disagrees'
    );
  });
});
