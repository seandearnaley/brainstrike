import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  buildLineStartOffsets,
  findLineForOffset,
  matchesChunkSourceRange,
} from '@brainstrike/chunking-worker/source-range-validation';
import {
  decoder,
  type EmbeddingProfile,
  type FileChunk,
  type FileSnapshot,
  profileSchema,
  snapshotSchema,
} from './contracts.js';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function embeddingProfileHash(input: unknown): string {
  const profile = decoder(profileSchema)(input);
  return sha256(
    JSON.stringify([
      profile.modelId,
      profile.revision,
      profile.dtype,
      profile.dimensions,
      profile.tokenCap,
    ])
  );
}
export function fileChunks(input: unknown, profile: EmbeddingProfile): readonly FileChunk[] {
  const snapshot = decoder(snapshotSchema)(input);
  validateSnapshot(snapshot);
  if ('providedChunks' in snapshot) {
    const lines = buildLineStartOffsets(snapshot.content);
    const indices = new Set<number>();
    const profileHash = embeddingProfileHash(profile);
    return snapshot.providedChunks.map((chunk) => {
      if (
        indices.has(chunk.chunkIndex) ||
        sha256(chunk.content) !== chunk.contentHash ||
        !matchesChunkSourceRange(
          snapshot.content,
          chunk.content,
          chunk.startOffset,
          chunk.endOffset
        ) ||
        findLineForOffset(lines, chunk.startOffset) !== chunk.startLine ||
        findLineForOffset(lines, chunk.endOffset - 1) !== chunk.endLine
      ) {
        throw new TypeError(
          'Provided chunk identity/hash/source span does not match its canonical snapshot.'
        );
      }
      indices.add(chunk.chunkIndex);
      return {
        ...chunk,
        chunkId: sha256(
          JSON.stringify([
            'provided-file-chunk-v1',
            snapshot.rootId,
            snapshot.fileId,
            chunk.chunkIndex,
            chunk.startOffset,
            chunk.endOffset,
          ])
        ),
        embeddingHash: sha256(JSON.stringify([profileHash, chunk.contentHash])),
      };
    });
  }
  if (snapshot.content.length === 0) {
    return [];
  }
  const profileHash = embeddingProfileHash(profile);
  const lines = snapshot.content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const chunks: FileChunk[] = [];
  for (let start = 0; start < lines.length; start += snapshot.chunkLines) {
    const end = Math.min(start + snapshot.chunkLines, lines.length);
    const content = lines.slice(start, end).join('');
    const contentHash = sha256(content);
    chunks.push({
      chunkId: sha256(
        JSON.stringify(['file-chunk-v1', snapshot.rootId, snapshot.fileId, start + 1, end])
      ),
      chunkIndex: null,
      chunkSize: null,
      chunkType: null,
      content,
      contentHash,
      embeddingHash: sha256(JSON.stringify([profileHash, contentHash])),
      endLine: end,
      endOffset: null,
      startLine: start + 1,
      startOffset: null,
      tokenCount: null,
    });
  }
  return chunks;
}
export function validateSnapshot(snapshot: FileSnapshot): void {
  if (
    path.posix.isAbsolute(snapshot.relativePath) ||
    snapshot.relativePath.includes('\\') ||
    snapshot.relativePath.split('/').some((part) => part === '..' || part === '' || part === '.')
  ) {
    throw new TypeError('Indexer file paths must be normalized root-relative paths.');
  }
}
export function vectorBlob(vector: readonly number[]): Buffer {
  const values = Float32Array.from(vector);
  if (values.some((value) => !Number.isFinite(value)) || !values.some((value) => value !== 0)) {
    throw new TypeError('Embedding must remain finite and nonzero as float32.');
  }
  const blob = Buffer.alloc(values.length * 4);
  for (const [index, value] of values.entries()) {
    blob.writeFloatLE(value, index * 4);
  }
  return blob;
}
