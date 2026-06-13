import type { DirectoryHandle } from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('getRootFolderId');

/**
 * Folder state must key by a canonical identity, not the display name.
 * Different roots can share the same name; their persisted state must not collide.
 *
 * Resolution order (storage v5):
 * 1. `handle.rootId` — the durable RootId stamped onto the handle when it became
 *    a registered root. This is the authoritative, collision-proof identity:
 *    two same-named web roots (whose `path` is just the directory name) carry
 *    distinct rootIds here even though their paths match.
 * 2. `rootIdByPath.get(handle.path)` — legacy bridge for handles that flow
 *    unstamped (rare; the reducer stamps every registered root). Keyed by path,
 *    so it cannot disambiguate same-named roots — only the stamp can.
 * 3. `handle.path` — final fallback for legacy single-root handles (the
 *    `setRoot`/`restoreLastFolder` path), where the path is unique anyway. Logs
 *    at DEBUG so a missed identity registration is observable, not silent.
 *
 * @param handle - The directory handle to resolve.
 * @param rootIdByPath - Map from handle.path → RootId UUID (from useFileSystem state).
 *   When omitted, resolution falls back to handle.rootId then handle.path.
 */
export function getRootFolderId(
  handle: DirectoryHandle | null,
  rootIdByPath?: ReadonlyMap<string, string>
): string | null {
  if (!handle) {
    return null;
  }
  // 1) Self-identifying handle (storage v5) — collision-proof for same-named roots.
  if (handle.rootId) {
    return handle.rootId;
  }
  if (rootIdByPath) {
    const rootId = rootIdByPath.get(handle.path);
    if (rootId) {
      return rootId;
    }
    // Path fallback — log debug so missed registrations are observable.
    logger.debug('getRootFolderId: no rootId for handle, falling back to path', {
      path: handle.path,
    });
  }
  return handle.path;
}
