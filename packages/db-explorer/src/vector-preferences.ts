import { useVectorStatusUIStore } from '@brainstrike/preferences';

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

  // Dispatch event to notify Vector Status and other listeners
  // This ensures immediate UI updates when the active collection changes
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('brainstrike:embedding-set-updated', {
        detail: { id },
      })
    );
  }
}
