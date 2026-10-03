import { createHash } from 'node:crypto';
import path from 'node:path';
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
      content,
      contentHash,
      embeddingHash: sha256(JSON.stringify([profileHash, contentHash])),
      endLine: end,
      startLine: start + 1,
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
