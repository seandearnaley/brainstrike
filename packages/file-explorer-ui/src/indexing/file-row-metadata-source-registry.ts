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
 * The same per-root shape carries the VISIBLE-file key set (BST-1207 decision
 * D2, whole-branch review F2). The panel used to derive it from its own
 * `useFileExplorer()` tree, which in forest mode is the FOCUSED root only — so
 * roots 2..N were never token-indexed, their Tokens cells stayed `pending`
 * forever, and (because a rollup goes partial on the first pending descendant)
 * their folder Size totals were dead too. Only a section can enumerate its own
 * display tree, exactly like the two lookups above, so publication is per root
 * and the merge happens here.
 *
 * NO SILENT FALLBACKS, with one deliberate shape: `getDirectorySubtree` never
 * returns `null`. A directory row can legitimately render before its subtree is
 * enumerated — a lazily expanded folder, or a section whose tree unmounted while
 * a cell was still subscribed. Those cases are the explicit "not enumerated"
 * marker, which surfaces as a visibly PARTIAL rollup, never as a number the
 * registry cannot justify.
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
  incompleteReason: 'not-enumerated',
  isComplete: false,
});

/** A subtree whose deferred aggregation has been queued for the next task. */
export const RECOMPUTING_DIRECTORY_SUBTREE: FileRowDirectorySubtree = Object.freeze({
  fileKeys: Object.freeze([] as string[]),
  incompleteReason: 'recomputing',
  isComplete: false,
});

/** Root-scoped lookups, keyed by tree PATH (the registry adds the folderId). */
export interface FileRowMetadataSource {
  /**
   * Enumerated file subtree under `path`. Must return
   * `UNENUMERATED_DIRECTORY_SUBTREE` rather than guessing when the subtree is
   * not fully loaded or is too large to walk. Use
   * `RECOMPUTING_DIRECTORY_SUBTREE` only when work is actually queued.
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
   * Every registered root's visible file keys, merged. CONTENT-stable: a
   * republication that changes nothing keeps the previous Set identity, because
   * this feeds the visible-indexing debounce and a bare identity change would
   * re-arm it for work that is already done. Safe as a
   * `useSyncExternalStore` snapshot.
   */
  getVisibleFileKeys: () => ReadonlySet<string>;
  /**
   * Register the source for one root. Returns an unregister function that only
   * removes THIS source — a remount that registers before the old cleanup runs
   * therefore cannot leave the folder unsourced.
   */
  register: (folderId: string, source: FileRowMetadataSource) => () => void;
  /**
   * Publish the composite keys of the files ONE root currently displays. Pass an
   * empty set to withdraw them (a section that collapsed or unmounted).
   */
  setVisibleFileKeys: (folderId: string, keys: ReadonlySet<string>) => void;
  subscribeVisibleFileKeys: (listener: () => void) => () => void;
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

/**
 * Test seam: the dedupe set is module state and would leak across cases.
 * @internal Used by file-row-metadata-source-registry.test.ts.
 */
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

/** Shared empty snapshot so an un-sourced registry never mints a new Set. */
const EMPTY_VISIBLE_FILE_KEYS: ReadonlySet<string> = Object.freeze(new Set<string>()) as Readonly<
  Set<string>
>;

function setsAreEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) {
    return true;
  }
  if (a.size !== b.size) {
    return false;
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}

export function createFileRowMetadataSourceRegistry(): FileRowMetadataSourceRegistry {
  const sourcesByFolderId = new Map<string, FileRowMetadataSource>();
  const visibleKeysByFolderId = new Map<string, ReadonlySet<string>>();
  const visibleKeyListeners = new Set<() => void>();
  let mergedVisibleKeys: ReadonlySet<string> = EMPTY_VISIBLE_FILE_KEYS;

  const republishVisibleKeys = (): void => {
    const merged = new Set<string>();
    for (const keys of visibleKeysByFolderId.values()) {
      for (const key of keys) {
        merged.add(key);
      }
    }
    if (setsAreEqual(merged, mergedVisibleKeys)) {
      return;
    }
    mergedVisibleKeys = merged.size === 0 ? EMPTY_VISIBLE_FILE_KEYS : merged;
    // Copy before iterating: a listener may synchronously unsubscribe.
    for (const listener of [...visibleKeyListeners]) {
      listener();
    }
  };

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
    getVisibleFileKeys: () => mergedVisibleKeys,
    register: (folderId, source) => {
      sourcesByFolderId.set(folderId, source);
      return () => {
        if (sourcesByFolderId.get(folderId) === source) {
          sourcesByFolderId.delete(folderId);
        }
      };
    },
    setVisibleFileKeys: (folderId, keys) => {
      if (keys.size === 0) {
        if (!visibleKeysByFolderId.delete(folderId)) {
          return;
        }
      } else {
        visibleKeysByFolderId.set(folderId, keys);
      }
      republishVisibleKeys();
    },
    subscribeVisibleFileKeys: (listener) => {
      visibleKeyListeners.add(listener);
      return () => {
        visibleKeyListeners.delete(listener);
      };
    },
  };
}
