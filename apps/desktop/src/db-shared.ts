import type {
  ApplyManagedCacheInvalidationsArgs,
  ManagedCacheInvalidationTarget,
} from '@brainstrike/db';
import type {
  DatabaseChunkInsert,
  InsertChunksAndEnqueueEmbeddingJobsOptions,
} from '@brainstrike/types';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';

export const DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL = DESKTOP_IPC_CHANNELS.db.applyManagedCacheBatch;
export const DB_INSERT_CHUNKS_AND_ENQUEUE_JOBS_CHANNEL =
  DESKTOP_IPC_CHANNELS.db.insertChunksAndEnqueueEmbeddingJobs;
export const DB_INVALIDATE_MANAGED_CACHE_ENTRIES_BY_IDENTITY_CHANNEL =
  DESKTOP_IPC_CHANNELS.db.invalidateManagedCacheEntriesByIdentity;

type ElectronEmbeddingProvider = NonNullable<
  InsertChunksAndEnqueueEmbeddingJobsOptions['provider']
>;
type ElectronDimensionParameter = NonNullable<
  InsertChunksAndEnqueueEmbeddingJobsOptions['dimensionParameter']
>;

export interface ParsedInsertChunksAndEnqueueEmbeddingJobsArgs {
  readonly chunks: readonly DatabaseChunkInsert[];
  readonly dimensionParameter?: ElectronDimensionParameter | null;
  readonly fileRecordId: string;
  readonly model: string;
  readonly provider?: ElectronEmbeddingProvider | null;
  readonly targetDimension: number;
  readonly targetEmbeddingSetId?: string | null;
}

const EMBEDDING_PROVIDERS = new Set<ElectronEmbeddingProvider>([
  'local',
  'transformers',
  'openai',
  'google',
  'cohere',
  'voyage',
  'ollama',
  'lmstudio',
]);
const DIMENSION_PARAMETERS = new Set<ElectronDimensionParameter>([
  'dimensions',
  'output_dimensionality',
  'output_dimension',
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(message);
  }
  return value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string') {
    throw new Error(message);
  }
  return value;
}

function requireInteger(value: unknown, message: string): number {
  if (!(typeof value === 'number' && Number.isInteger(value))) {
    throw new Error(message);
  }
  return value;
}

function requirePositiveInteger(value: unknown, message: string): number {
  const integer = requireInteger(value, message);
  if (integer <= 0) {
    throw new Error(message);
  }
  return integer;
}

function parseOptionalInteger(value: unknown, message: string): number | undefined {
  if (value === undefined) {
    return;
  }
  return requireInteger(value, message);
}

function parseOptionalString(value: unknown, message: string): string | undefined {
  if (value === undefined) {
    return;
  }
  return requireNonEmptyString(value, message);
}

function parseOptionalNumberArray(value: unknown, message: string): number[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'number')) {
    throw new Error(message);
  }
  return value;
}

function parseProvider(value: unknown): ElectronEmbeddingProvider | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !EMBEDDING_PROVIDERS.has(value as ElectronEmbeddingProvider)) {
    throw new Error('Atomic chunk/job enqueue provider is invalid.');
  }
  return value as ElectronEmbeddingProvider;
}

function parseDimensionParameter(value: unknown): ElectronDimensionParameter | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !DIMENSION_PARAMETERS.has(value as ElectronDimensionParameter)) {
    throw new Error('Atomic chunk/job enqueue dimension parameter is invalid.');
  }
  return value as ElectronDimensionParameter;
}

function parseChunkInsert(value: unknown): DatabaseChunkInsert {
  if (!(value && typeof value === 'object')) {
    throw new Error('Atomic chunk/job enqueue payload contains an invalid chunk.');
  }
  const candidate = value as Record<string, unknown>;
  const chunk: DatabaseChunkInsert = {
    chunkIndex: requireInteger(candidate['chunkIndex'], 'Chunk insert requires chunkIndex.'),
    chunkSize: requirePositiveInteger(candidate['chunkSize'], 'Chunk insert requires chunkSize.'),
    chunkType: requireNonEmptyString(candidate['chunkType'], 'Chunk insert requires chunkType.') as
      | 'text'
      | 'code'
      | 'sentence'
      | 'recursive',
    content: requireString(candidate['content'], 'Chunk insert requires string content.'),
    contentHash: requireNonEmptyString(
      candidate['contentHash'],
      'Chunk insert requires a non-empty contentHash.'
    ),
    createdAt: requireNonEmptyString(candidate['createdAt'], 'Chunk insert requires createdAt.'),
    fileRecordId: requireNonEmptyString(
      candidate['fileRecordId'],
      'Chunk insert requires a non-empty fileRecordId.'
    ),
    id: requireNonEmptyString(candidate['id'], 'Chunk insert requires a non-empty id.'),
    tokenCount: requireInteger(candidate['tokenCount'], 'Chunk insert requires tokenCount.'),
    updatedAt: requireNonEmptyString(candidate['updatedAt'], 'Chunk insert requires updatedAt.'),
  };
  if (!['text', 'code', 'sentence', 'recursive'].includes(chunk.chunkType)) {
    throw new Error('Chunk insert chunkType is invalid.');
  }
  const startLine = parseOptionalInteger(candidate['startLine'], 'Chunk insert startLine invalid.');
  const endLine = parseOptionalInteger(candidate['endLine'], 'Chunk insert endLine invalid.');
  const startOffset = parseOptionalInteger(
    candidate['startOffset'],
    'Chunk insert startOffset invalid.'
  );
  const endOffset = parseOptionalInteger(candidate['endOffset'], 'Chunk insert endOffset invalid.');
  const embedding = parseOptionalNumberArray(
    candidate['embedding'],
    'Chunk insert embedding invalid.'
  );
  const embeddingSetId = parseOptionalString(
    candidate['embeddingSetId'],
    'Chunk insert embeddingSetId invalid.'
  );
  const embeddingUpdatedAt = parseOptionalString(
    candidate['embeddingUpdatedAt'],
    'Chunk insert embeddingUpdatedAt invalid.'
  );
  const embeddingHash = parseOptionalString(
    candidate['embeddingHash'],
    'Chunk insert embeddingHash invalid.'
  );
  return {
    ...chunk,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(startOffset === undefined ? {} : { startOffset }),
    ...(endOffset === undefined ? {} : { endOffset }),
    ...(embedding === undefined ? {} : { embedding }),
    ...(embeddingSetId === undefined ? {} : { embeddingSetId }),
    ...(embeddingUpdatedAt === undefined ? {} : { embeddingUpdatedAt }),
    ...(embeddingHash === undefined ? {} : { embeddingHash }),
  };
}

function parseAtomicChunkJobOptionsSource(
  candidate: Record<string, unknown>
): Record<string, unknown> {
  const options = candidate['options'];
  if (options === undefined) {
    return candidate;
  }
  if (!(options && typeof options === 'object') || Array.isArray(options)) {
    throw new Error('Atomic chunk/job enqueue options must be an object when provided.');
  }
  return options as Record<string, unknown>;
}

export function parseInsertChunksAndEnqueueEmbeddingJobsArgs(
  payload: unknown
): ParsedInsertChunksAndEnqueueEmbeddingJobsArgs {
  if (!(payload && typeof payload === 'object')) {
    throw new Error('Atomic chunk/job enqueue payload must be an object.');
  }
  const candidate = payload as Record<string, unknown>;
  if (!Array.isArray(candidate['chunks'])) {
    throw new Error('Atomic chunk/job enqueue payload requires a chunks array.');
  }
  const options = parseAtomicChunkJobOptionsSource(candidate);
  return {
    chunks: candidate['chunks'].map(parseChunkInsert),
    dimensionParameter: parseDimensionParameter(options['dimensionParameter']),
    fileRecordId: requireNonEmptyString(
      candidate['fileRecordId'],
      'Atomic chunk/job enqueue payload requires a non-empty fileRecordId.'
    ),
    model: requireNonEmptyString(options['model'], 'Atomic chunk/job enqueue requires a model.'),
    provider: parseProvider(options['provider']),
    targetDimension: requirePositiveInteger(
      options['targetDimension'],
      'Atomic chunk/job enqueue requires a positive targetDimension.'
    ),
    targetEmbeddingSetId:
      options['targetEmbeddingSetId'] === undefined || options['targetEmbeddingSetId'] === null
        ? null
        : requireNonEmptyString(
            options['targetEmbeddingSetId'],
            'Atomic chunk/job enqueue targetEmbeddingSetId invalid.'
          ),
  };
}

function parseManagedCacheInvalidationTarget(payload: unknown): ManagedCacheInvalidationTarget {
  if (!(payload && typeof payload === 'object')) {
    throw new Error('Managed cache invalidation payload contains an invalid target.');
  }
  const candidate = payload as Record<string, unknown>;
  if (!isNonEmptyString(candidate['rootId'])) {
    throw new Error('Managed cache invalidation target requires a non-empty rootId.');
  }
  if (candidate['mode'] === 'prefix') {
    if (!isNonEmptyString(candidate['relativePathPrefix'])) {
      throw new Error(
        'Managed cache prefix invalidation target requires a non-empty relativePathPrefix.'
      );
    }
    return {
      mode: 'prefix',
      relativePathPrefix: candidate['relativePathPrefix'],
      rootId: candidate['rootId'],
    };
  }
  if (candidate['mode'] !== undefined && candidate['mode'] !== 'exact') {
    throw new Error('Managed cache invalidation target mode must be exact or prefix.');
  }
  if (!isNonEmptyString(candidate['relativePath'])) {
    throw new Error('Managed cache exact invalidation target requires a non-empty relativePath.');
  }
  if (
    candidate['expectedFileRecordId'] !== undefined &&
    !isNonEmptyString(candidate['expectedFileRecordId'])
  ) {
    throw new Error(
      'Managed cache exact invalidation target expectedFileRecordId must be a non-empty string when provided.'
    );
  }
  return {
    mode: 'exact',
    relativePath: candidate['relativePath'],
    rootId: candidate['rootId'],
    ...(candidate['expectedFileRecordId'] === undefined
      ? {}
      : { expectedFileRecordId: candidate['expectedFileRecordId'] }),
  };
}

export function parseManagedCacheInvalidationsArgs(
  payload: unknown
): ApplyManagedCacheInvalidationsArgs {
  if (!(payload && typeof payload === 'object')) {
    throw new Error('Managed cache invalidation payload must be an object.');
  }
  const candidate = payload as Record<string, unknown>;
  if (!isNonEmptyString(candidate['embeddingSetId'])) {
    throw new Error('Managed cache invalidation payload requires a non-empty embeddingSetId.');
  }
  if (!Array.isArray(candidate['targets'])) {
    throw new Error('Managed cache invalidation payload requires a targets array.');
  }
  return {
    embeddingSetId: candidate['embeddingSetId'],
    targets: candidate['targets'].map(parseManagedCacheInvalidationTarget),
  };
}
