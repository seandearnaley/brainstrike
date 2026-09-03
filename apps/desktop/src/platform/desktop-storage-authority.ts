export const MAIN_OWNED_DESKTOP_STORAGE_KEYS = [
  'lastFolderPath',
  'notesVaultRoots',
  'recentRootsList',
  'recentRootsList.corrupt',
  'rootsList',
  'rootsList.corrupt',
] as const;

const MAIN_OWNED_DESKTOP_STORAGE_KEY_SET = new Set<string>(MAIN_OWNED_DESKTOP_STORAGE_KEYS);

export function isMainOwnedDesktopStorageKey(key: unknown): key is string {
  return typeof key === 'string' && MAIN_OWNED_DESKTOP_STORAGE_KEY_SET.has(key);
}

export function assertRendererWritableDesktopStorageKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('Storage key must be a non-empty string.');
  }
  if (isMainOwnedDesktopStorageKey(key)) {
    throw new Error(`Storage key "${key}" is main-owned and cannot be mutated by the renderer.`);
  }
}
