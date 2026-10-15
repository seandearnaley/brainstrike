/**
 * The explorer's view of the active thread's context (ADR-0021): which files
 * the thread's model received, how, and whether they changed since. The host
 * app folds that from the thread's committed log and publishes it here, keyed
 * by explorer selection key; the "This thread" column and the "Touched in
 * this thread" filter read it. Without a publisher (web) neither exists.
 *
 * "Changed since read" costs a file read, so it is checked only for files a
 * mounted row asks about (`watch`); every other file stays `unknown`.
 */
import { createContext, useContext } from 'react';

/** How the model received a file, highest drawing priority first in `kinds`. */
export type ExplorerThreadTouchKind = 'edit' | 'grep' | 'pinned' | 'read' | 'semantic';

/** `unknown`: nothing to compare, or not checked yet; `unavailable`: the file could not be read. */
export type ExplorerThreadFreshness =
  | 'changed'
  | 'checking'
  | 'unavailable'
  | 'unchanged'
  | 'unknown';

export interface ExplorerThreadFileStatus {
  /** An edit reached lines no earlier delivery of the file showed the model. */
  readonly editedWithoutRead: boolean;
  /** Delivered lines against the current file; `unknown` until a row asks. */
  readonly freshness: ExplorerThreadFreshness;
  /** Every delivery of the file has left the model's window. */
  readonly gone: boolean;
  readonly kinds: readonly ExplorerThreadTouchKind[];
}

export interface ExplorerThreadStatusSnapshot {
  /** Touched files under each folder row, by the folder's selection key. */
  readonly directories: ReadonlyMap<string, number>;
  readonly files: ReadonlyMap<string, ExplorerThreadFileStatus>;
  /** Tree paths of the touched files, for the "Touched in this thread" filter. */
  readonly touchedPaths: readonly string[];
}

/**
 * How each kind is named and colored: the Context tab's palette, handed in by
 * its owner (app-shell's `context-map-kinds`), so both views draw kinds alike.
 */
export interface ExplorerThreadKindAppearance {
  /** A text color utility; a mark fills or outlines with `currentColor`. */
  readonly colorClass: Readonly<Record<ExplorerThreadTouchKind, string>>;
  readonly label: Readonly<Record<ExplorerThreadTouchKind, string>>;
}

export interface ExplorerThreadStatusStore {
  readonly appearance: ExplorerThreadKindAppearance;
  getDirectoryFileCount: (key: string) => number | undefined;
  getFileStatus: (key: string) => ExplorerThreadFileStatus | undefined;
  getTouchedPaths: () => readonly string[];
  /** Selection keys of the files mounted rows are showing. Content-stable. */
  getWatchedKeys: () => ReadonlySet<string>;
  publish: (snapshot: ExplorerThreadStatusSnapshot) => void;
  subscribe: (listener: () => void) => () => void;
  subscribeWatched: (listener: () => void) => () => void;
  /** A mounted row asks for its file's freshness; the result withdraws it. */
  watch: (key: string) => () => void;
}

const EMPTY_PATHS: readonly string[] = Object.freeze([]);
const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();

function sameStatus(a: ExplorerThreadFileStatus, b: ExplorerThreadFileStatus): boolean {
  return (
    a.editedWithoutRead === b.editedWithoutRead &&
    a.freshness === b.freshness &&
    a.gone === b.gone &&
    a.kinds.length === b.kinds.length &&
    a.kinds.every((kind, index) => b.kinds[index] === kind)
  );
}

function samePaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, index) => b[index] === path);
}

/**
 * A row's snapshot is its own status object, kept by identity while its
 * content is unchanged, so a publish repaints only the rows it changed.
 */
export function createExplorerThreadStatusStore(
  appearance: ExplorerThreadKindAppearance
): ExplorerThreadStatusStore {
  let files = new Map<string, ExplorerThreadFileStatus>();
  let directories: ReadonlyMap<string, number> = new Map();
  let touchedPaths = EMPTY_PATHS;
  const watchCounts = new Map<string, number>();
  let watchedKeys = EMPTY_KEYS;
  const listeners = new Set<() => void>();
  const watchedListeners = new Set<() => void>();

  const notify = (targets: Set<() => void>): void => {
    for (const listener of [...targets]) {
      listener();
    }
  };
  const republishWatched = (): void => {
    watchedKeys = watchCounts.size === 0 ? EMPTY_KEYS : new Set(watchCounts.keys());
    notify(watchedListeners);
  };

  return {
    appearance,
    getDirectoryFileCount: (key) => directories.get(key),
    getFileStatus: (key) => files.get(key),
    getTouchedPaths: () => touchedPaths,
    getWatchedKeys: () => watchedKeys,
    publish: (snapshot) => {
      let changed = snapshot.files.size !== files.size;
      const next = new Map<string, ExplorerThreadFileStatus>();
      for (const [key, status] of snapshot.files) {
        const previous = files.get(key);
        if (previous && sameStatus(previous, status)) {
          next.set(key, previous);
        } else {
          next.set(key, status);
          changed = true;
        }
      }
      const directoriesChanged =
        snapshot.directories.size !== directories.size ||
        [...snapshot.directories].some(([key, count]) => directories.get(key) !== count);
      const pathsChanged = !samePaths(snapshot.touchedPaths, touchedPaths);
      if (!(changed || directoriesChanged || pathsChanged)) {
        return;
      }
      files = next;
      if (directoriesChanged) {
        directories = snapshot.directories;
      }
      if (pathsChanged) {
        touchedPaths = snapshot.touchedPaths.length === 0 ? EMPTY_PATHS : snapshot.touchedPaths;
      }
      notify(listeners);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeWatched: (listener) => {
      watchedListeners.add(listener);
      return () => {
        watchedListeners.delete(listener);
      };
    },
    watch: (key) => {
      const count = watchCounts.get(key) ?? 0;
      watchCounts.set(key, count + 1);
      if (count === 0) {
        republishWatched();
      }
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        const current = watchCounts.get(key) ?? 0;
        if (current <= 1) {
          watchCounts.delete(key);
          republishWatched();
        } else {
          watchCounts.set(key, current - 1);
        }
      };
    },
  };
}

export const ExplorerThreadStatusContext = createContext<ExplorerThreadStatusStore | null>(null);

/** Null where no thread context is published: the column and filter do not exist there. */
export function useOptionalExplorerThreadStatus(): ExplorerThreadStatusStore | null {
  return useContext(ExplorerThreadStatusContext);
}
