/** Main's workspace ledgers in `electron-storage.json`; only Main writes them (E2E seeds them). */
export const MAIN_OWNED_DESKTOP_STORAGE_KEYS = [
  'lastFolderPath',
  'recentRootsList',
  'recentRootsList.corrupt',
  'rootsList',
  'rootsList.corrupt',
] as const;

const MAIN_OWNED_DESKTOP_STORAGE_KEY_SET = new Set<string>(MAIN_OWNED_DESKTOP_STORAGE_KEYS);

export function isMainOwnedDesktopStorageKey(key: unknown): key is string {
  return typeof key === 'string' && MAIN_OWNED_DESKTOP_STORAGE_KEY_SET.has(key);
}
