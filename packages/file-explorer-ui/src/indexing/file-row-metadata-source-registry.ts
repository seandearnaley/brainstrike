/**
 * Per-root source registry for the file-row metadata seam (BST-1208).
 *
 * The metadata store (BST-1207) is keyed by workspace-wide composite keys and
 * is owned by the PANEL, because that is where the background token indexer
 * lives and therefore the only place `onTokenResolved` can be wired. Its two
 * tree-shaped sources — a node's size and a directory's enumerated subtree —
 * are NOT panel-shaped: in forest mode each root section runs its own
 * `FileTreeProvider`, and only that section can enumerate its own tree.
 *
 * So the store reads through this registry: each rendered tree registers the
 * lookups for ITS folderId, and the registry dispatches by the folderId half of
 * the composite key. One store, N sources, no cross-root leakage.
 *
 * NO SILENT FALLBACKS, with one deliberate shape: `getDirectorySubtree` never
 * returns `null`. `computeDirectoryRollup` throws on null by design (a file key
 * reaching the directory path is a bug), but a directory row can legitimately
 * render before its subtree is enumerated — a lazily expanded folder, or a
 * section whose tree unmounted while a cell was still subscribed. Those cases
 * are the explicit "not enumerated" marker, which surfaces as a visibly PARTIAL
 * rollup, never as a number the registry cannot justify.
 */

import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { FileRowDirectorySubtree } from './file-row-metadata-store';

/**
 * "This subtree is not fully enumerated." Frozen and shared so a rollup
 * recomputation over an unenumerated directory is allocation-free.
 */
export const UNENUMERATED_DIRECTORY_SUBTREE: FileRowDirectorySubtree = Object.freeze({
  fileKeys: Object.freeze([] as string[]),
  isComplete: false,
});

/** Root-scoped lookups, keyed by tree PATH (the registry adds the folderId). */
export interface FileRowMetadataSource {
  /**
   * Enumerated file subtree under `path`. Must return
   * `UNENUMERATED_DIRECTORY_SUBTREE` (or any `isComplete: false` value) rather
   * than guessing when the subtree is not fully loaded or is too large to walk.
   */
  getDirectorySubtree: (path: string) => FileRowDirectorySubtree;
  getNodeSize: (path: string) => number | undefined;
}

export interface FileRowMetadataSourceRegistry {
  /** Identity-stable; safe to hand to `createFileRowMetadataStore` once. */
  getDirectorySubtree: (compositeKey: string) => FileRowDirectorySubtree;
  /** Identity-stable; safe to hand to `createFileRowMetadataStore` once. */
  getNodeSize: (compositeKey: string) => number | undefined;
  /**
   * Register the source for one root. Returns an unregister function that only
   * removes THIS source — a remount that registers before the old cleanup runs
   * therefore cannot leave the folder unsourced.
   */
  register: (folderId: string, source: FileRowMetadataSource) => () => void;
}

interface DecodedKey {
  folderId: string;
  path: string;
}

function decodeOrNull(compositeKey: string): DecodedKey | null {
  try {
    return decodeFileSelection(compositeKey);
  } catch {
    // A malformed key can only come from a caller bug; the store treats the
    // absence of data as `pending`/`partial`, which is the honest answer here.
    return null;
  }
}

export function createFileRowMetadataSourceRegistry(): FileRowMetadataSourceRegistry {
  const sourcesByFolderId = new Map<string, FileRowMetadataSource>();

  const resolve = (
    compositeKey: string
  ): { decoded: DecodedKey; source: FileRowMetadataSource } | null => {
    const decoded = decodeOrNull(compositeKey);
    if (!decoded) {
      return null;
    }
    const source = sourcesByFolderId.get(decoded.folderId);
    if (!source) {
      return null;
    }
    return { decoded, source };
  };

  return {
    getDirectorySubtree: (compositeKey) => {
      const resolved = resolve(compositeKey);
      if (!resolved) {
        return UNENUMERATED_DIRECTORY_SUBTREE;
      }
      return resolved.source.getDirectorySubtree(resolved.decoded.path);
    },
    getNodeSize: (compositeKey) => {
      const resolved = resolve(compositeKey);
      if (!resolved) {
        return;
      }
      return resolved.source.getNodeSize(resolved.decoded.path);
    },
    register: (folderId, source) => {
      sourcesByFolderId.set(folderId, source);
      return () => {
        if (sourcesByFolderId.get(folderId) === source) {
          sourcesByFolderId.delete(folderId);
        }
      };
    },
  };
}
