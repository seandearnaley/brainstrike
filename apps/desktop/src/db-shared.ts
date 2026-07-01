import type {
  ApplyManagedCacheInvalidationsArgs,
  ClaimParams,
  CompleteEmbeddingChunkParams,
  CompleteParams,
  FailBatchParams,
  FailParams,
  JobState,
  ManagedCacheInvalidationTarget,
} from '@brainstrike/db';
import type {
  ElectronChunkInsert,
  ElectronInsertChunksAndEnqueueEmbeddingJobsOptions,
} from '@brainstrike/types';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';

export const DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL = DESKTOP_IPC_CHANNELS.db.applyManagedCacheBatch;
export const DB_INSERT_CHUNKS_AND_ENQUEUE_JOBS_CHANNEL =
  DESKTOP_IPC_CHANNELS.db.insertChunksAndEnqueueEmbeddingJobs;
export const DB_INVALIDATE_MANAGED_CACHE_ENTRIES_BY_IDENTITY_CHANNEL =
  DESKTOP_IPC_CHANNELS.db.invalidateManagedCacheEntriesByIdentity;
export const DB_TURSO_EMBEDDING_WORKER_QUEUE_CHANNEL =
  DESKTOP_IPC_CHANNELS.db.tursoEmbeddingWorkerQueue;
export const DB_TURSO_EMBEDDING_WORKER_STATS_CHANNEL =
  DESKTOP_IPC_CHANNELS.db.tursoEmbeddingWorkerStats;
export const DB_TURSO_VECTOR_QUEUE_ACTION_CHANNEL = DESKTOP_IPC_CHANNELS.db.tursoVectorQueueAction;

type ElectronEmbeddingProvider = NonNullable<
  ElectronInsertChunksAndEnqueueEmbeddingJobsOptions['provider']
>;
type ElectronDimensionParameter = NonNullable<
  ElectronInsertChunksAndEnqueueEmbeddingJobsOptions['dimensionParameter']
>;

export interface ParsedInsertChunksAndEnqueueEmbeddingJobsArgs {
  readonly chunks: readonly ElectronChunkInsert[];
  readonly dimensionParameter?: ElectronDimensionParameter | null;
  readonly fileRecordId: string;
  readonly model: string;
  readonly provider?: ElectronEmbeddingProvider | null;
  readonly targetDimension: number;
  readonly targetEmbeddingSetId?: string | null;
}

export type TursoEmbeddingWorkerQueueOperation =
  | 'claimMany'
  | 'completeBatch'
  | 'completeEmbeddingChunkBatch'
  | 'fail'
  | 'failBatch'
  | 'heartbeatBatch';

export type ParsedTursoEmbeddingWorkerQueueRequest =
  | {
      readonly operation: 'claimMany';
      readonly payload: ClaimParams & { readonly limit?: number };
    }
  | {
      readonly operation: 'completeBatch';
      readonly payload: readonly CompleteParams[];
    }
  | {
      readonly operation: 'completeEmbeddingChunkBatch';
      readonly payload: readonly CompleteEmbeddingChunkParams[];
    }
  | {
      readonly operation: 'fail';
      readonly payload: FailParams;
    }
  | {
      readonly operation: 'failBatch';
      readonly payload: FailBatchParams;
    }
  | {
      readonly operation: 'heartbeatBatch';
      readonly payload: {
        readonly extendMs: number;
        readonly jobs: readonly CompleteParams[];
      };
    };

export type TursoEmbeddingWorkerStatsOperation = 'markDirty' | 'refresh';

export interface ParsedTursoEmbeddingWorkerStatsRequest {
  readonly embeddingSetIds: readonly string[];
  readonly operation: TursoEmbeddingWorkerStatsOperation;
}

export type TursoVectorQueueActionOperation =
  | 'clearEmbeddingsForSet'
  | 'clearQueue'
  | 'retryFailed'
  | 'wipeQueue';

export type ParsedTursoVectorQueueActionRequest =
  | {
      readonly operation: 'clearEmbeddingsForSet';
      readonly payload: {
        readonly embeddingSetId: string;
      };
    }
  | {
      readonly operation: 'clearQueue';
      readonly payload: {
        readonly states?: readonly Extract<
          JobState,
          'failed' | 'queued' | 'running' | 'succeeded'
        >[];
      };
    }
  | {
      readonly operation: 'retryFailed';
      readonly payload: {
        readonly limit: number;
      };
    }
  | {
      readonly operation: 'wipeQueue';
      readonly payload: null;
    };

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
const VECTOR_QUEUE_CLEAR_STATES = new Set<JobState>(['failed', 'queued', 'running', 'succeeded']);

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

function requireNonNegativeInteger(value: unknown, message: string): number {
  const integer = requireInteger(value, message);
  if (integer < 0) {
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

function parseOptionalPositiveInteger(value: unknown, message: string): number | undefined {
  if (value === undefined) {
    return;
  }
  return requirePositiveInteger(value, message);
}

function parseOptionalNonNegativeInteger(value: unknown, message: string): number | undefined {
  if (value === undefined) {
    return;
  }
  return requireNonNegativeInteger(value, message);
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

function requireNumberArray(value: unknown, message: string): number[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'number')) {
    throw new Error(message);
  }
  return value;
}

function parseOptionalBoolean(value: unknown, message: string): boolean | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'boolean') {
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

function parseChunkInsert(value: unknown): ElectronChunkInsert {
  if (!(value && typeof value === 'object')) {
    throw new Error('Atomic chunk/job enqueue payload contains an invalid chunk.');
  }
  const candidate = value as Record<string, unknown>;
  const chunk: ElectronChunkInsert = {
    id: requireNonEmptyString(candidate['id'], 'Chunk insert requires a non-empty id.'),
    fileRecordId: requireNonEmptyString(
      candidate['fileRecordId'],
      'Chunk insert requires a non-empty fileRecordId.'
    ),
    chunkIndex: requireInteger(candidate['chunkIndex'], 'Chunk insert requires chunkIndex.'),
    content: requireString(candidate['content'], 'Chunk insert requires string content.'),
    contentHash: requireNonEmptyString(
      candidate['contentHash'],
      'Chunk insert requires a non-empty contentHash.'
    ),
    tokenCount: requireInteger(candidate['tokenCount'], 'Chunk insert requires tokenCount.'),
    chunkType: requireNonEmptyString(candidate['chunkType'], 'Chunk insert requires chunkType.') as
      | 'text'
      | 'code'
      | 'sentence'
      | 'recursive',
    chunkSize: requirePositiveInteger(candidate['chunkSize'], 'Chunk insert requires chunkSize.'),
    createdAt: requireNonEmptyString(candidate['createdAt'], 'Chunk insert requires createdAt.'),
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
    dimensionParameter: parseDimensionParameter(options['dimensionParameter']),
  };
}

function parseLeaseRef(value: unknown, context: string): CompleteParams {
  if (!(value && typeof value === 'object')) {
    throw new Error(`${context} requires a job lease object.`);
  }
  const candidate = value as Record<string, unknown>;
  return {
    id: requireNonEmptyString(candidate['id'], `${context} requires a non-empty job id.`),
    leaseToken: requireNonEmptyString(
      candidate['leaseToken'],
      `${context} requires a non-empty lease token.`
    ),
  };
}

function parseLeaseRefs(value: unknown, context: string): CompleteParams[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} requires an array of job lease objects.`);
  }
  return value.map((entry) => parseLeaseRef(entry, context));
}

function parseClaimManyPayload(value: unknown): ClaimParams & { readonly limit?: number } {
  if (!(value && typeof value === 'object')) {
    throw new Error('Turso embedding worker claimMany payload must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  const limit = parseOptionalPositiveInteger(
    candidate['limit'],
    'Turso embedding worker claimMany limit must be positive.'
  );
  const workerId = parseOptionalString(
    candidate['workerId'],
    'Turso embedding worker claimMany workerId must be non-empty.'
  );
  const now = parseOptionalString(
    candidate['now'],
    'Turso embedding worker claimMany now must be non-empty.'
  );
  return {
    leaseMs: requirePositiveInteger(
      candidate['leaseMs'],
      'Turso embedding worker claimMany leaseMs must be positive.'
    ),
    queue: requireNonEmptyString(
      candidate['queue'],
      'Turso embedding worker claimMany requires a non-empty queue.'
    ),
    ...(limit === undefined ? {} : { limit }),
    ...(workerId === undefined ? {} : { workerId }),
    ...(now === undefined ? {} : { now }),
  };
}

function parseCompleteEmbeddingChunkPayload(value: unknown): CompleteEmbeddingChunkParams {
  const leaseRef = parseLeaseRef(value, 'Turso embedding worker completeEmbeddingChunkBatch');
  const candidate = value as Record<string, unknown>;
  return {
    ...leaseRef,
    chunkId: requireNonEmptyString(
      candidate['chunkId'],
      'Turso embedding worker completeEmbeddingChunkBatch requires a non-empty chunkId.'
    ),
    embedding: requireNumberArray(
      candidate['embedding'],
      'Turso embedding worker completeEmbeddingChunkBatch embedding must be a number array.'
    ),
    embeddingHash: requireNonEmptyString(
      candidate['embeddingHash'],
      'Turso embedding worker completeEmbeddingChunkBatch requires a non-empty embeddingHash.'
    ),
    embeddingSetId: requireNonEmptyString(
      candidate['embeddingSetId'],
      'Turso embedding worker completeEmbeddingChunkBatch requires a non-empty embeddingSetId.'
    ),
  };
}

function parseCompleteEmbeddingChunkBatchPayload(value: unknown): CompleteEmbeddingChunkParams[] {
  if (!Array.isArray(value)) {
    throw new Error('Turso embedding worker completeEmbeddingChunkBatch payload must be an array.');
  }
  return value.map(parseCompleteEmbeddingChunkPayload);
}

function parseFailPayload(value: unknown): FailParams {
  const leaseRef = parseLeaseRef(value, 'Turso embedding worker fail');
  const candidate = value as Record<string, unknown>;
  const backoffMs = parseOptionalNonNegativeInteger(
    candidate['backoffMs'],
    'Turso embedding worker fail backoffMs must be non-negative.'
  );
  const terminal = parseOptionalBoolean(
    candidate['terminal'],
    'Turso embedding worker fail terminal must be boolean.'
  );
  return {
    ...leaseRef,
    error: requireString(
      candidate['error'],
      'Turso embedding worker fail requires an error string.'
    ),
    ...(backoffMs === undefined ? {} : { backoffMs }),
    ...(terminal === undefined ? {} : { terminal }),
  };
}

function parseFailBatchPayload(value: unknown): FailBatchParams {
  if (!(value && typeof value === 'object')) {
    throw new Error('Turso embedding worker failBatch payload must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  const backoffMs = parseOptionalNonNegativeInteger(
    candidate['backoffMs'],
    'Turso embedding worker failBatch backoffMs must be non-negative.'
  );
  const terminal = parseOptionalBoolean(
    candidate['terminal'],
    'Turso embedding worker failBatch terminal must be boolean.'
  );
  return {
    error: requireString(
      candidate['error'],
      'Turso embedding worker failBatch requires an error string.'
    ),
    jobs: parseLeaseRefs(candidate['jobs'], 'Turso embedding worker failBatch'),
    ...(backoffMs === undefined ? {} : { backoffMs }),
    ...(terminal === undefined ? {} : { terminal }),
  };
}

function parseHeartbeatBatchPayload(value: unknown): {
  readonly extendMs: number;
  readonly jobs: readonly CompleteParams[];
} {
  if (!(value && typeof value === 'object')) {
    throw new Error('Turso embedding worker heartbeatBatch payload must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  return {
    extendMs: requirePositiveInteger(
      candidate['extendMs'],
      'Turso embedding worker heartbeatBatch extendMs must be positive.'
    ),
    jobs: parseLeaseRefs(candidate['jobs'], 'Turso embedding worker heartbeatBatch'),
  };
}

export function parseTursoEmbeddingWorkerQueueArgs(
  operation: unknown,
  payload: unknown
): ParsedTursoEmbeddingWorkerQueueRequest {
  switch (operation) {
    case 'claimMany':
      return { operation, payload: parseClaimManyPayload(payload) };
    case 'completeBatch':
      return {
        operation,
        payload: parseLeaseRefs(payload, 'Turso embedding worker completeBatch'),
      };
    case 'completeEmbeddingChunkBatch':
      return { operation, payload: parseCompleteEmbeddingChunkBatchPayload(payload) };
    case 'fail':
      return { operation, payload: parseFailPayload(payload) };
    case 'failBatch':
      return { operation, payload: parseFailBatchPayload(payload) };
    case 'heartbeatBatch':
      return { operation, payload: parseHeartbeatBatchPayload(payload) };
    default:
      throw new Error('Turso embedding worker queue operation is invalid.');
  }
}

function parseEmbeddingSetIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Turso embedding worker stats payload must be an array.');
  }
  return value.map((entry) =>
    requireNonEmptyString(entry, 'Turso embedding worker stats requires embedding set ids.')
  );
}

export function parseTursoEmbeddingWorkerStatsArgs(
  operation: unknown,
  embeddingSetIds: unknown
): ParsedTursoEmbeddingWorkerStatsRequest {
  if (operation !== 'markDirty' && operation !== 'refresh') {
    throw new Error('Turso embedding worker stats operation is invalid.');
  }
  return {
    embeddingSetIds: parseEmbeddingSetIds(embeddingSetIds),
    operation,
  };
}

function parseVectorQueueActionPayloadObject(
  value: unknown,
  operation: TursoVectorQueueActionOperation
): Record<string, unknown> {
  if (!(value && typeof value === 'object') || Array.isArray(value)) {
    throw new Error(`Turso vector queue ${operation} payload must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseVectorQueueClearStates(
  value: unknown
): Extract<JobState, 'failed' | 'queued' | 'running' | 'succeeded'>[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error('Turso vector queue clearQueue states must be an array.');
  }
  return value.map((state) => {
    if (typeof state !== 'string' || !VECTOR_QUEUE_CLEAR_STATES.has(state as JobState)) {
      throw new Error('Turso vector queue clearQueue state is invalid.');
    }
    return state as Extract<JobState, 'failed' | 'queued' | 'running' | 'succeeded'>;
  });
}

export function parseTursoVectorQueueActionArgs(
  operation: unknown,
  payload: unknown
): ParsedTursoVectorQueueActionRequest {
  switch (operation) {
    case 'clearEmbeddingsForSet': {
      const candidate = parseVectorQueueActionPayloadObject(payload, operation);
      return {
        operation,
        payload: {
          embeddingSetId: requireNonEmptyString(
            candidate['embeddingSetId'],
            'Turso vector queue clearEmbeddingsForSet requires an embeddingSetId.'
          ),
        },
      };
    }
    case 'clearQueue': {
      const candidate = parseVectorQueueActionPayloadObject(payload, operation);
      const states = parseVectorQueueClearStates(candidate['states']);
      return {
        operation,
        payload: states === undefined ? {} : { states },
      };
    }
    case 'retryFailed': {
      const candidate = parseVectorQueueActionPayloadObject(payload, operation);
      return {
        operation,
        payload: {
          limit:
            parseOptionalPositiveInteger(
              candidate['limit'],
              'Turso vector queue retryFailed limit must be positive.'
            ) ?? 20,
        },
      };
    }
    case 'wipeQueue':
      if (payload !== null) {
        throw new Error('Turso vector queue wipeQueue payload must be null.');
      }
      return { operation, payload: null };
    default:
      throw new Error('Turso vector queue action operation is invalid.');
  }
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
      rootId: candidate['rootId'],
      relativePathPrefix: candidate['relativePathPrefix'],
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
    rootId: candidate['rootId'],
    relativePath: candidate['relativePath'],
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
