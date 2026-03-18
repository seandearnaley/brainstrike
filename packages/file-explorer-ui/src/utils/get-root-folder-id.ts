import type { DirectoryHandle } from '@brainstrike/file-system';

/**
 * Folder state must key by a canonical identity, not the display name.
 * Different roots can share the same name; their persisted state must not collide.
 */
export function getRootFolderId(handle: DirectoryHandle | null): string | null {
  return handle?.path ?? null;
}
