import { createLogger } from '@brainstrike/logging';
import { appReloadStore } from './app-reload-store';

const logger = createLogger('ChunkLoad');

/** Errors Vite reported through `vite:preloadError`. Identity only, never message text. */
const chunkLoadErrors = new WeakSet<object>();

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/**
 * Whether `error`, or anything in its `cause` chain, is a failed dynamic import
 * that Vite reported. `React.lazy` rethrows the very object Vite's preload helper
 * put in the event payload, so identity is exact where message matching is not.
 */
export function isChunkLoadError(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  while (isObject(current) && !visited.has(current)) {
    if (chunkLoadErrors.has(current)) {
      return true;
    }
    visited.add(current);
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

// NEVER call event.preventDefault() here: Vite then resolves the import to
// `undefined` and React.lazy fails with a misleading TypeError instead of the
// real chunk error.
function handlePreloadError(event: Event): void {
  const payload = 'payload' in event ? event.payload : undefined;
  if (isObject(payload)) {
    chunkLoadErrors.add(payload);
  } else {
    logger.error('vite:preloadError carried a non-object payload, so no panel can match it', {
      payloadType: payload === null ? 'null' : typeof payload,
    });
  }
  appReloadStore.markRequired();
}

/**
 * Registers every failed dynamic import Vite reports and flags the app as needing
 * a reload. `vite:preloadError` exists only in `vite build` output.
 */
export function installChunkLoadErrorListener(target: Window): () => void {
  target.addEventListener('vite:preloadError', handlePreloadError);
  return () => target.removeEventListener('vite:preloadError', handlePreloadError);
}
