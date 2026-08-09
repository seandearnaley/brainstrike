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
import { createLogger } from '@brainstrike/logging';
import type { FileRowDirectorySubtree } from './file-row-metadata-store';

const logger = createLogger('FileRowMetadataSourceRegistry');

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

/**
 * Two failures reach this module and they are NOT the same thing:
 *
 * - **Unregistered root** — legitimate and transient. A section's tree has
 *   unmounted (or has not registered yet) while a cell is still subscribed.
 *   The honest answer is "not enumerated", and it resolves itself.
 * - **Malformed composite key** — an invariant violation. Nothing will ever
 *   resolve it, so reporting it as unfinished work would mask a bug behind a
 *   placeholder that promises a value that is never coming. It is logged at
 *   ERROR, once per offending key so a render loop cannot flood the log.
 */
const reportedMalformedKeys = new Set<string>();
/** Bound the dedupe set so a pathological caller cannot grow it without limit. */
const MAX_REPORTED_MALFORMED_KEYS = 100;

function reportMalformedKey(compositeKey: string, error: unknown): void {
  if (reportedMalformedKeys.has(compositeKey)) {
    return;
  }
  // EVICT the oldest rather than refusing to record. A full set that stops
  // admitting keys makes every key past the cap log on EVERY call, which is the
  // flood the cap exists to prevent. Set iteration is insertion-ordered, so the
  // first key is the oldest.
  if (reportedMalformedKeys.size >= MAX_REPORTED_MALFORMED_KEYS) {
    const oldest = reportedMalformedKeys.values().next();
    if (!oldest.done) {
      reportedMalformedKeys.delete(oldest.value);
    }
  }
  reportedMalformedKeys.add(compositeKey);
  logger.error('Malformed composite key reached the file-row metadata registry', {
    compositeKey,
    error,
  });
}

/** Test seam: the dedupe set is module state and would leak across cases. */
export function __resetMalformedKeyReportingForTests(): void {
  reportedMalformedKeys.clear();
}

function decodeOrNull(compositeKey: string): DecodedKey | null {
  try {
    return decodeFileSelection(compositeKey);
  } catch (error) {
    reportMalformedKey(compositeKey, error);
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
