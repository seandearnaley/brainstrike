export const ACTIVE_EMBEDDING_SET_KEY = 'brainstrike.activeEmbeddingSetId';

export function getActiveEmbeddingSetId(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const v = localStorage.getItem(ACTIVE_EMBEDDING_SET_KEY);
    return v?.trim() ? v : null;
  } catch {
    return null;
  }
}

export function setActiveEmbeddingSetId(id: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (!id) {
      localStorage.removeItem(ACTIVE_EMBEDDING_SET_KEY);
    } else {
      localStorage.setItem(ACTIVE_EMBEDDING_SET_KEY, id);
    }
  } catch {
    // ignore
  }
}
