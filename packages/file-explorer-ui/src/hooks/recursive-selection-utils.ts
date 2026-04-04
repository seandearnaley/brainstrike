/**
 * Shared utilities for recursive selection hooks.
 *
 * Both `useRecursiveFolderSelect` and `useRecursiveSelectAll` need identical
 * infrastructure for yielding to the browser, detecting persist APIs, applying
 * chunked selections, collecting ancestor directories, and building query
 * selection descriptors. This module extracts those shared helpers.
 */

import {
  CHUNKED_SELECTION_THRESHOLD,
  DEFAULT_SELECTION_CHUNK_SIZE,
} from '@brainstrike/file-explorer';
import type { SelectionQueryDescriptor } from '@brainstrike/types';

import type { PersistableFileExplorerStore } from '../utils/persist-file-explorer-state';

export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => resolve());
      return;
    }
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

export async function applyExplicitSelection(
  filePaths: string[],
  folderId: string,
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void
): Promise<void> {
  if (filePaths.length === 0) {
    return;
  }

  if (filePaths.length <= CHUNKED_SELECTION_THRESHOLD) {
    addMultipleSelectedFiles(folderId, filePaths);
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

  for (const filePath of filePaths) {
    let separatorIndex = filePath.lastIndexOf('/');
    while (separatorIndex > 0) {
      coveredPaths.add(filePath.slice(0, separatorIndex));
      separatorIndex = filePath.lastIndexOf('/', separatorIndex - 1);
    }
  }

  return Array.from(coveredPaths).sort((left, right) => left.localeCompare(right));
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
