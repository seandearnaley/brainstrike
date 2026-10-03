import type { ChunkResult } from '@brainstrike/chunking-worker';
import type { ChunkingHostProxyRequestOptions, ChunkingWorkerPort } from './chunking-worker-port';

export interface CanonicalChunkSource {
  readonly content: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly fileRecordId: string;
}
export type CanonicalChunkEvent =
  | { readonly kind: 'empty-source'; readonly source: CanonicalChunkSource }
  | {
      readonly kind: 'worker-result';
      readonly source: CanonicalChunkSource;
      readonly result: ChunkResult;
    };
/** Explicit text policy. Sources come from the existing import batch, never another read or walk. */
export interface CanonicalTextChunkProducer {
  commit(event: CanonicalChunkEvent): Promise<void>;
  sourceForFile(fileRecordId: string): Promise<CanonicalChunkSource>;
}

export function requireOriginalContent(content: unknown): string {
  if (typeof content !== 'string') {
    throw new Error('Native text producer requires original source content.');
  }
  return content;
}
export function validateCanonicalSource(
  source: CanonicalChunkSource,
  fileRecordId: string
): CanonicalChunkSource {
  if (
    source.fileRecordId !== fileRecordId ||
    typeof source.content !== 'string' ||
    typeof source.fileName !== 'string' ||
    !source.fileName.trim() ||
    typeof source.filePath !== 'string' ||
    !source.filePath.trim()
  ) {
    throw new Error('Native text producer source identity/content is invalid.');
  }
  return source;
}
export function assertNativeTextPolicy(options: {
  canonicalTextProducer?: CanonicalTextChunkProducer;
  embedQueueEnabled?: boolean;
  enableEmbedding?: boolean;
  processEmbeddings?: unknown;
}): void {
  if (
    options.canonicalTextProducer &&
    (options.embedQueueEnabled || options.enableEmbedding || options.processEmbeddings)
  ) {
    throw new Error('Native text producer requires an explicit disabled embedding policy.');
  }
}

export async function requestCanonicalHostChunks(
  worker: ChunkingWorkerPort,
  fileRecordId: string,
  hostOptions: ChunkingHostProxyRequestOptions,
  producer: CanonicalTextChunkProducer | undefined,
  assertActive: () => void
): Promise<ChunkResult> {
  if (!producer) {
    if (!worker.chunkFileById) {
      throw new Error('Host-proxy chunking requires chunkFileById support.');
    }
    return worker.chunkFileById(fileRecordId, hostOptions);
  }
  const source = validateCanonicalSource(await producer.sourceForFile(fileRecordId), fileRecordId);
  assertActive();
  const { requestedStrategy, separators, ...workerOptions } = hostOptions;
  const result = await worker.chunkFile(
    fileRecordId,
    source.content,
    source.fileName,
    source.filePath,
    {
      ...workerOptions,
      strategy: requestedStrategy ?? 'auto',
      ...(separators === undefined ? {} : { separators: [...separators] }),
    }
  );
  if (result.fileRecordId !== source.fileRecordId) {
    throw new Error('Canonical worker result has a different file identity.');
  }
  assertActive();
  await producer.commit({ kind: 'worker-result', result, source });
  assertActive();
  return result;
}
