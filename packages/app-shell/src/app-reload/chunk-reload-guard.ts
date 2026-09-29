import { createLogger } from '@brainstrike/logging';
import { appReloadStore } from '@brainstrike/ui';

const logger = createLogger('ChunkReloadGuard');

export const CHUNK_RELOAD_STORAGE_KEY = 'brainstrike:chunk-reload';

type ChunkReloadStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

export interface ChunkReloadGuardOptions {
  readonly buildId: string;
  /** Resolved inside the guard, so a blocked store is logged rather than thrown at the entry. */
  readonly getStorage?: (() => ChunkReloadStorage) | undefined;
}

const sessionStorageOf = (): ChunkReloadStorage => window.sessionStorage;

// Diagnostic only, and never the cause of a reload: a reload always waits for
// the user, so a store that cannot be read or written cannot loop. Each failure
// is logged and the flow carries on.
function reachStorage(getStorage: () => ChunkReloadStorage): ChunkReloadStorage | null {
  try {
    return getStorage();
  } catch (error) {
    logger.error('Could not reach session storage for the chunk-reload marker', { error });
    return null;
  }
}

function parseMarker(raw: string): { readonly buildId: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !('buildId' in parsed)) {
    return null;
  }
  return typeof parsed.buildId === 'string' ? { buildId: parsed.buildId } : null;
}

/** Called right before a recovery reload: the next startup learns which build asked for it. */
export function writeChunkReloadMarker({
  buildId,
  getStorage = sessionStorageOf,
}: ChunkReloadGuardOptions): void {
  const storage = reachStorage(getStorage);
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(CHUNK_RELOAD_STORAGE_KEY, JSON.stringify({ buildId }));
  } catch (error) {
    logger.error('Could not write the chunk-reload marker', { error });
  }
}

/**
 * Called once at startup, before first render: reads and deletes the marker. A
 * marker for THIS build means the last recovery reload did not fix the load,
 * so the notice stops promising that another one will.
 */
export function consumeChunkReloadMarker({
  buildId,
  getStorage = sessionStorageOf,
}: ChunkReloadGuardOptions): void {
  const storage = reachStorage(getStorage);
  if (storage === null) {
    return;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(CHUNK_RELOAD_STORAGE_KEY);
  } catch (error) {
    logger.error('Could not read the chunk-reload marker', { error });
    return;
  }
  if (raw === null) {
    return;
  }
  try {
    storage.removeItem(CHUNK_RELOAD_STORAGE_KEY);
  } catch (error) {
    logger.error('Could not delete the chunk-reload marker', { error });
  }
  const marker = parseMarker(raw);
  if (marker === null) {
    logger.warn('Discarded a malformed chunk-reload marker', { raw: raw.slice(0, 200) });
    return;
  }
  if (marker.buildId === buildId) {
    appReloadStore.markReloadAlreadyAttempted();
  }
}
