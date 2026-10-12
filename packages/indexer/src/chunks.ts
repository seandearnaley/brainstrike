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
  type EmbeddingState,
  embeddingStateSchema,
  type FileChunk,
  type FileSnapshot,
  profileSchema,
  type ScopedFileSnapshot,
  scopedSnapshotSchema,
  snapshotSchema,
} from './contracts.js';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
/**
 * The one rule for pooling in a profile identity: absent means 'mean', and the
 * default adds nothing, so every mean profile keeps the identity it had before
 * pooling was recorded, while 'cls' vectors get their own (BST-1993).
 */
export function poolingIdentity(pooling: 'mean' | 'cls' | undefined): readonly 'cls'[] {
  return pooling === 'cls' ? ['cls'] : [];
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
      ...poolingIdentity(profile.pooling),
    ])
  );
}
function chunkProfileHash(input: EmbeddingProfile | EmbeddingState): string | null {
  if (!('indexMode' in input)) {
    return embeddingProfileHash(input);
  }
  const embedding = decoder(embeddingStateSchema)(input);
  if (embedding.indexMode === 'text-only') {
    return null;
  }
  if (embedding.profileHash !== embeddingProfileHash(embedding.profile)) {
    throw new TypeError('Chunk embedding profile hash disagrees with its complete profile.');
  }
  return embedding.profileHash;
}
export function fileChunks(
  input: unknown,
  profile: EmbeddingProfile | EmbeddingState
): readonly FileChunk[] {
  return buildFileChunks(decoder(snapshotSchema)(input), chunkProfileHash(profile));
}
export function scopedFileChunks(input: unknown, profileHash: string | null): readonly FileChunk[] {
  return buildFileChunks(decoder(scopedSnapshotSchema)(input), profileHash);
}
function buildFileChunks(
  snapshot: FileSnapshot | ScopedFileSnapshot,
  profileHash: string | null
): readonly FileChunk[] {
  validateSnapshot(snapshot);
  if ('providedChunks' in snapshot) {
    const lines = buildLineStartOffsets(snapshot.content);
    const indices = new Set<number>();
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
            ...('embeddingSetId' in snapshot
              ? ['provided-file-chunk-v2']
              : ['provided-file-chunk-v1', snapshot.rootId]),
            snapshot.fileId,
            chunk.chunkIndex,
            chunk.startOffset,
            chunk.endOffset,
          ])
        ),
        embeddingHash:
          profileHash === null ? null : sha256(JSON.stringify([profileHash, chunk.contentHash])),
      };
    });
  }
  if (snapshot.content.length === 0) {
    return [];
  }
  const lines = snapshot.content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const chunks: FileChunk[] = [];
  for (let start = 0; start < lines.length; start += snapshot.chunkLines) {
    const end = Math.min(start + snapshot.chunkLines, lines.length);
    const content = lines.slice(start, end).join('');
    const contentHash = sha256(content);
    chunks.push({
      chunkId: sha256(
        JSON.stringify([
          ...('embeddingSetId' in snapshot
            ? ['file-chunk-v2']
            : ['file-chunk-v1', snapshot.rootId]),
          snapshot.fileId,
          start + 1,
          end,
        ])
      ),
      chunkIndex: null,
      chunkSize: null,
      chunkType: null,
      content,
      contentHash,
      embeddingHash:
        profileHash === null ? null : sha256(JSON.stringify([profileHash, contentHash])),
      endLine: end,
      endOffset: null,
      startLine: start + 1,
      startOffset: null,
      tokenCount: null,
    });
  }
  return chunks;
}
export function validateSnapshot(snapshot: FileSnapshot | ScopedFileSnapshot): void {
  if (snapshot.rootId === null) {
    if (snapshot.relativePath !== null) {
      throw new TypeError('Rootless files cannot have workspace-relative paths.');
    }
    return;
  }
  if (snapshot.relativePath === null) {
    throw new TypeError('Workspace files require a normalized relative path.');
  }
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
