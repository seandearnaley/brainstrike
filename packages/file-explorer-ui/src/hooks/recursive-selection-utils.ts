/**
 * Shared utilities for recursive selection hooks.
 *
 * Both `useRecursiveFolderSelect` and `useRecursiveSelectAll` need identical
 * infrastructure for yielding to the browser, detecting persist APIs, applying
 * chunked selections, collecting ancestor directories, and building query
 * selection descriptors. This module extracts those shared helpers.
 */

import type { ChunkedSelectionOptions, ChunkedSelectionResult } from '@brainstrike/file-explorer';
import {
  CHUNKED_SELECTION_THRESHOLD,
  DEFAULT_SELECTION_CHUNK_SIZE,
} from '@brainstrike/file-explorer';
import type { SelectionQueryDescriptor } from '@brainstrike/types';
import { getAncestorDirectoryPaths } from '@brainstrike/utils/path-ancestors';
import { defaultCollator } from '../utils/file-node-collator';
import type { PersistableFileExplorerStore } from '../utils/persist-file-explorer-state';

/**
 * Multiple active roots = forest mode, the always-explicit selection regime:
 * query-mode selections live on TOP-LEVEL state that focus switches (every
 * forest section click) cannot carry into folderState snapshots.
 */
export function isForestStore(store: unknown): boolean {
  const getState = (store as { getState?: unknown } | null | undefined)?.getState;
  if (typeof getState !== 'function') {
    return false;
  }
  const state = (getState as () => { activeRootIds?: readonly string[] })();
  return (state.activeRootIds?.length ?? 0) > 1;
}

export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function hasPersistApi(store: unknown): store is PersistableFileExplorerStore {
  return (
    typeof store === 'function' &&
    'persist' in store &&
    typeof (store as { persist?: unknown }).persist === 'object' &&
    (store as { persist?: { getOptions?: unknown } }).persist !== null &&
    typeof (store as { persist?: { getOptions?: unknown } }).persist?.getOptions === 'function'
  );
}

export type AddMultipleSelectedFilesChunked = (
  folderId: string,
  paths: string[],
  options?: ChunkedSelectionOptions
) => Promise<ChunkedSelectionResult>;

export interface ApplyExplicitSelectionOptions {
  addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked;
  signal?: AbortSignal;
}

export async function applyExplicitSelection(
  filePaths: string[],
  folderId: string,
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
  options: ApplyExplicitSelectionOptions = {}
): Promise<void> {
  if (filePaths.length === 0) {
    return;
  }

  if (filePaths.length <= CHUNKED_SELECTION_THRESHOLD) {
    addMultipleSelectedFiles(folderId, filePaths);
    return;
  }

  if (options.addMultipleSelectedFilesChunked) {
    await options.addMultipleSelectedFilesChunked(folderId, filePaths, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return;
  }

  for (let index = 0; index < filePaths.length; index += DEFAULT_SELECTION_CHUNK_SIZE) {
    const chunk = filePaths.slice(index, index + DEFAULT_SELECTION_CHUNK_SIZE);
    addMultipleSelectedFiles(folderId, chunk);
    if (index + DEFAULT_SELECTION_CHUNK_SIZE < filePaths.length) {
      await yieldToBrowser();
    }
  }
}

export function collectAncestorDirectories(filePaths: string[]): string[] {
  const coveredPaths = new Set<string>();
  const ancestorCache = new Map<string, readonly string[]>();

  for (const filePath of filePaths) {
    for (const directoryPath of getAncestorDirectoryPaths(filePath, {
      cache: ancestorCache,
      includeRoot: false,
    })) {
      coveredPaths.add(directoryPath);
    }
  }

  return Array.from(coveredPaths).sort(defaultCollator.compare);
}

export function buildQuerySelectionDescriptor(args: {
  coveredDirectoryPaths: string[];
  excludeFilters: string[];
  excludedPaths: string[];
  folderId: string;
  includeFilters: string[];
  includedPaths: string[];
  kind: SelectionQueryDescriptor['kind'];
  manifestFingerprint: string | null;
  manifestSnapshotId: string | null;
  rootPath: string | null;
  totalSelectedCount: number;
  useRegex: boolean;
}): SelectionQueryDescriptor {
  return {
    kind: args.kind,
    folderId: args.folderId,
    rootPath: args.rootPath,
    coveredDirectoryPaths: [...args.coveredDirectoryPaths],
    includeFilters: [...args.includeFilters],
    excludeFilters: [...args.excludeFilters],
    includedPaths: [...args.includedPaths],
    excludedPaths: [...args.excludedPaths],
    manifestFingerprint: args.manifestFingerprint,
    manifestSnapshotId: args.manifestSnapshotId,
    useRegex: args.useRegex,
    totalSelectedCount: args.totalSelectedCount,
  };
}
