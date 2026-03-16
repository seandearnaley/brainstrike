import { useVectorStatusUIStore } from '@brainstrike/preferences/stores/vector-status-ui-store';
import { dispatchEmbeddingSetUpdated } from '@brainstrike/vector-management';

export const ACTIVE_EMBEDDING_SET_KEY = 'brainstrike.activeEmbeddingSetId';

export function getActiveEmbeddingSetId(): string | null {
  try {
    // Prefer Zustand store (consistent across mounts)
    const fromStore = useVectorStatusUIStore.getState().activeEmbeddingSetId;
    if (fromStore?.trim()) {
      return fromStore;
    }
  } catch {}
  try {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    const v = localStorage.getItem(ACTIVE_EMBEDDING_SET_KEY);
    return v?.trim() ? v : null;
  } catch {
    return null;
  }
}

export function setActiveEmbeddingSetId(id: string | null): void {
  try {
    useVectorStatusUIStore.getState().setActiveEmbeddingSetId(id);
  } catch {}
  try {
    if (typeof localStorage === 'undefined') {
      return;
    }
    if (id) {
      localStorage.setItem(ACTIVE_EMBEDDING_SET_KEY, id);
    } else {
      localStorage.removeItem(ACTIVE_EMBEDDING_SET_KEY);
    }
  } catch {
    // ignore
  }

  try {
    dispatchEmbeddingSetUpdated({
      id,
      reason: 'selected',
    });
  } catch {
    // ignore dispatch issues - consumers still get store/localStorage updates
  }
}
