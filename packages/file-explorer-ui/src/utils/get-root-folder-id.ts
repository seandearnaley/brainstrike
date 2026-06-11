import type { DirectoryHandle } from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('getRootFolderId');

/**
 * Folder state must key by a canonical identity, not the display name.
 * Different roots can share the same name; their persisted state must not collide.
 *
 * Since storage v5 the canonical identity is the durable RootId UUID stored in
 * `rootIdByPath`. The path fallback covers handles that predate registration
 * (e.g. the legacy `setRoot` path) — when it fires it logs at DEBUG level so
 * missed identity registrations are observable, not silent.
 *
 * @param handle - The directory handle to resolve.
 * @param rootIdByPath - Map from handle.path → RootId UUID (from useFileSystem state).
 *   When omitted the function falls back to handle.path (legacy behaviour).
 */
export function getRootFolderId(
  handle: DirectoryHandle | null,
  rootIdByPath?: ReadonlyMap<string, string>
): string | null {
  if (!handle) {
    return null;
  }
  if (rootIdByPath) {
    const rootId = rootIdByPath.get(handle.path);
    if (rootId) {
      return rootId;
    }
    // Path fallback — log debug so missed registrations are observable.
    logger.debug('getRootFolderId: no rootId for path, falling back to path', {
      path: handle.path,
    });
  }
  return handle.path;
}
