import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  buildLineStartOffsets,
  findLineForOffset,
  matchesChunkSourceRange,
} from '@brainstrike/chunking-worker/source-range-validation';
import {
  decoder,
  type FileChunk,
  type FileSnapshot,
  type ScopedFileSnapshot,
  scopedSnapshotSchema,
  snapshotSchema,
  vectorProfileSchema,
} from './contracts.ts';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
/** The float32 little-endian bytes of `values`. */
export function float32Bytes(values: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index++) {
    view.setFloat32(index * 4, values[index] as number, true);
  }
  return bytes;
}
/** A vector profile's identity: vectors are partitioned by it. */
export function vectorProfileHash(input: unknown): string {
  const profile = decoder(vectorProfileSchema)(input);
  return sha256(
    JSON.stringify([profile.provider, profile.modelId, profile.dimensions, profile.distance])
  );
}
/** A text store's chunks: they carry no embedding identity. */
export function fileChunks(input: unknown): readonly FileChunk[] {
  return buildFileChunks(decoder(snapshotSchema)(input), null);
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
export function vectorBlob(vector: readonly number[]): Uint8Array {
  const values = Float32Array.from(vector);
  if (values.some((value) => !Number.isFinite(value)) || !values.some((value) => value !== 0)) {
    throw new TypeError('Embedding must remain finite and nonzero as float32.');
  }
  return float32Bytes(values);
}
