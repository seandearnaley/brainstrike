import { useVectorStatusUIStore } from '@brainstrike/preferences/stores/vector-status-ui-store';
import { createLogger } from '@brainstrike/utils/logger';
import { dispatchEmbeddingSetUpdated } from './collection-select/embedding-set-events';

const logger = createLogger('VectorPreferences');

export const ACTIVE_EMBEDDING_SET_KEY = 'brainstrike.activeEmbeddingSetId';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Single source of truth for the active embedding set preference (BST-579).
 *
 * The Zustand store is authoritative; the raw localStorage key is a legacy
 * mirror kept for cross-package consumers (e2e helpers and pre-store readers
 * key off `brainstrike.activeEmbeddingSetId` directly). Store access is a pure
 * state read/write and is intentionally unguarded — failures there are
 * programming errors and must propagate (NO SILENT FALLBACKS). Only the
 * environment-dependent localStorage/event operations are guarded, and every
 * guard surfaces through the package logger.
 */
export function getActiveEmbeddingSetId(): string | null {
  // Prefer the Zustand store (consistent across mounts).
  const fromStore = useVectorStatusUIStore.getState().activeEmbeddingSetId;
  if (fromStore?.trim()) {
    return fromStore;
  }
  if (typeof localStorage === 'undefined') {
    return null;
  }
  try {
    const v = localStorage.getItem(ACTIVE_EMBEDDING_SET_KEY);
    return v?.trim() ? v : null;
  } catch (error) {
    logger.warn('Failed to read active embedding set id from localStorage', {
      error: toErrorMessage(error),
      key: ACTIVE_EMBEDDING_SET_KEY,
    });
    return null;
  }
}

export function setActiveEmbeddingSetId(id: string | null): void {
  // Store write first: it is the source of truth and cannot throw (zustand set
  // is pure; the persist storage adapters never throw synchronously).
  useVectorStatusUIStore.getState().setActiveEmbeddingSetId(id);

  if (typeof localStorage !== 'undefined') {
    try {
      if (id) {
        localStorage.setItem(ACTIVE_EMBEDDING_SET_KEY, id);
      } else {
        localStorage.removeItem(ACTIVE_EMBEDDING_SET_KEY);
      }
    } catch (error) {
      logger.warn('Failed to persist active embedding set id to localStorage', {
        error: toErrorMessage(error),
        id,
        key: ACTIVE_EMBEDDING_SET_KEY,
      });
    }
  }

  try {
    dispatchEmbeddingSetUpdated({
      id,
      reason: 'selected',
    });
  } catch (error) {
    // Store/localStorage are already updated; surface the broken notification.
    logger.warn('Failed to dispatch embedding-set-updated event', {
      error: toErrorMessage(error),
      id,
    });
  }
}
