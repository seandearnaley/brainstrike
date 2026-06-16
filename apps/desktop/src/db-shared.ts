import type {
  ApplyManagedCacheInvalidationsArgs,
  ManagedCacheInvalidationTarget,
} from '@brainstrike/db';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';

export const DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL = DESKTOP_IPC_CHANNELS.db.applyManagedCacheBatch;
export const DB_INVALIDATE_MANAGED_CACHE_ENTRIES_BY_IDENTITY_CHANNEL =
  DESKTOP_IPC_CHANNELS.db.invalidateManagedCacheEntriesByIdentity;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
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
