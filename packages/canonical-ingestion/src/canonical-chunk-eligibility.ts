import type { NodeChunker } from '@brainstrike/chunking-worker/node';
import type { CanonicalChunkEvent } from '@brainstrike/file-import';
import {
  type CanonicalIndexPayload,
  canonicalIndexPayload,
} from '@brainstrike/file-import/canonical-index-publication';
import type { CanonicalScanRequest, CanonicalSourceExclusion } from './ports.js';
import type { CanonicalPreparedRead } from './source-preparation.js';

export type CanonicalChunkOutcome =
  | { readonly kind: 'excluded'; readonly exclusion: CanonicalSourceExclusion }
  | { readonly kind: 'payload'; readonly payload: CanonicalIndexPayload };

/**
 * Content the chunker deliberately skips (lockfiles, oversized or generated files)
 * is excluded and reported like ineligible source, never a scan failure. Any other
 * skip stays fatal in canonicalIndexPayload.
 */
function chunkExclusion(
  result: Extract<CanonicalChunkEvent, { kind: 'worker-result' }>['result']
): CanonicalSourceExclusion['reason'] | undefined {
  if (!result.skipped) {
    return undefined;
  }
  switch (result.skipCode) {
    case 'binary-content':
    case 'dependency-manifest':
    case 'generated-content':
    case 'too-large':
      return result.skipCode;
    default:
      return undefined;
  }
}

/** Chunk one canonical read into its index payload, or its visible exclusion. */
export async function chunkCanonicalRead(
  chunk: NodeChunker,
  read: CanonicalPreparedRead,
  request: Pick<CanonicalScanRequest, 'chunkingOptions' | 'requestId'>
): Promise<CanonicalChunkOutcome> {
  const source = {
    content: read.content,
    fileName: read.file.fileName,
    filePath: read.file.relativePath ?? read.file.sourcePath ?? read.file.fileName,
    fileRecordId: read.file.fileId,
  };
  if (read.content === '') {
    return { kind: 'payload', payload: canonicalIndexPayload({ kind: 'empty-source', source }) };
  }
  const result = {
    ...(await chunk(read.content, {
      ...request.chunkingOptions,
      fileName: source.fileName,
      filePath: source.filePath,
    })),
    fileRecordId: read.file.fileId,
    id: request.requestId,
    type: 'result' as const,
  };
  const reason = chunkExclusion(result);
  if (reason) {
    return {
      exclusion: {
        fileId: read.file.fileId,
        reason,
        relativePath: read.file.relativePath,
        rootId: read.file.rootId,
      },
      kind: 'excluded',
    };
  }
  return {
    kind: 'payload',
    payload: canonicalIndexPayload({ kind: 'worker-result', result, source }),
  };
}
