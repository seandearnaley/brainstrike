import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import { useEventCallback } from '@brainstrike/hooks';
import { createLogger } from '@brainstrike/logging';
import type { FileSystemChange } from '@brainstrike/types';
import { normalizeFilePathForFolder } from '@brainstrike/utils/relative-file-path';
import { useEffect } from 'react';
import type { FileContentLoadIntent } from '../file-content-load-authority-context';
import type { FileTab } from '../hooks/use-tab-manager';
import { normalizePathForRootScope } from '../utils/root-scoped-paths';
import {
  FILE_EXPLORER_REFRESH_EVENT,
  type FileExplorerRefreshEvent,
  type FileExplorerRefreshRootDetail,
} from './file-explorer-refresh-event';

const logger = createLogger('WorkspaceOpenFileRefresh');

interface OpenFileRefreshPlan {
  readonly invalidCompositeKeys: readonly string[];
  readonly keysToReload: readonly string[];
}

interface DecodedOpenTab {
  readonly compositeKey: string;
  readonly folderId: string;
  readonly path: string;
}

export interface UseWorkspaceOpenFileRefreshParams {
  readonly reloadFileContents: (
    compositeKeys: readonly string[],
    intent: FileContentLoadIntent
  ) => Promise<void>;
  readonly tabs: readonly FileTab[];
}

function normalizePath(path: string): string {
  const withForwardSlashes = normalizePathForRootScope(path);
  if (withForwardSlashes === '/') {
    return withForwardSlashes;
  }
  if (/^[A-Za-z]:\/+$/u.test(withForwardSlashes)) {
    return `${withForwardSlashes.slice(0, 2)}/`;
  }
  return withForwardSlashes.replace(/\/+$/, '');
}

function isWindowsRootPath(rootPath: string): boolean {
  const normalizedRoot = normalizePath(rootPath);
  return /^[A-Za-z]:\//u.test(normalizedRoot) || normalizedRoot.startsWith('//');
}

function pathComparisonKey(path: string, rootPath: string): string {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(rootPath);
  const windowsRoot = isWindowsRootPath(rootPath);
  const comparablePath = windowsRoot ? normalizedPath.toLowerCase() : normalizedPath;
  const comparableRoot = windowsRoot ? normalizedRoot.toLowerCase() : normalizedRoot;
  let relativePath: string;
  if (comparablePath === comparableRoot) {
    relativePath = '';
  } else {
    const rootPrefix = comparableRoot.endsWith('/') ? comparableRoot : `${comparableRoot}/`;
    if (comparablePath.startsWith(rootPrefix)) {
      relativePath = normalizedPath.slice(rootPrefix.length);
    } else {
      relativePath = normalizeFilePathForFolder(path, rootPath);
    }
  }
  const normalizedRelativePath = normalizePath(relativePath).replace(/^\/+/, '');
  return windowsRoot ? normalizedRelativePath.toLowerCase() : normalizedRelativePath;
}

function relativePathWithinRoot(path: string, rootPath: string): string {
  return pathComparisonKey(path, rootPath);
}

function tabBelongsToRoot(tab: DecodedOpenTab, root: FileExplorerRefreshRootDetail): boolean {
  if (tab.folderId === root.rootId) {
    return true;
  }
  // Legacy composite keys used the root path as their folder id. Durable ids
  // never path-match: same-named web roots can share a presentation path.
  const tabRootPath = normalizePath(tab.folderId);
  const eventRootPath = normalizePath(root.rootPath);
  if (isWindowsRootPath(root.rootPath)) {
    return tabRootPath.toLowerCase() === eventRootPath.toLowerCase();
  }
  return tabRootPath === eventRootPath;
}

function changeAffectsTab(change: FileSystemChange, tabPath: string, rootPath: string): boolean {
  const relativeTabPath = relativePathWithinRoot(tabPath, rootPath);
  const relativeChangePath = relativePathWithinRoot(change.path, rootPath);
  if (change.kind === 'file') {
    return relativeTabPath === relativeChangePath;
  }
  return (
    relativeChangePath === '' ||
    relativeTabPath === relativeChangePath ||
    relativeTabPath.startsWith(`${relativeChangePath}/`)
  );
}

/** @internal Exported for focused root/path regression coverage. */
export function planOpenFileRefresh(
  tabs: readonly Pick<FileTab, 'compositeKey'>[],
  detail: FileExplorerRefreshEvent['detail']
): OpenFileRefreshPlan {
  const decodedTabs: DecodedOpenTab[] = [];
  const invalidCompositeKeys: string[] = [];
  for (const tab of tabs) {
    try {
      const decoded = decodeFileSelection(tab.compositeKey);
      decodedTabs.push({
        compositeKey: tab.compositeKey,
        folderId: decoded.folderId,
        path: decoded.path,
      });
    } catch {
      invalidCompositeKeys.push(tab.compositeKey);
    }
  }

  const keysToReload = new Set<string>();
  if (detail.scope === 'full' && detail.roots.length === 0) {
    return {
      invalidCompositeKeys,
      keysToReload: decodedTabs.map((tab) => tab.compositeKey),
    };
  }
  for (const root of detail.roots) {
    for (const tab of decodedTabs) {
      if (!tabBelongsToRoot(tab, root)) {
        continue;
      }
      if (
        detail.scope === 'full' ||
        root.changes.some((change) => changeAffectsTab(change, tab.path, root.rootPath))
      ) {
        keysToReload.add(tab.compositeKey);
      }
    }
  }

  return {
    invalidCompositeKeys,
    keysToReload: [...keysToReload],
  };
}

/**
 * Whether a refresh reaches one file's composite key, by the same root and
 * path rules that reload open tabs. For views that read a file without a tab.
 */
export function refreshReachesFile(
  detail: FileExplorerRefreshEvent['detail'],
  compositeKey: string
): boolean {
  return planOpenFileRefresh([{ compositeKey }], detail).keysToReload.length > 0;
}

/**
 * Keeps every open file tab on the canonical Explorer refresh pipeline.
 * Content reload ordering and stale-read suppression belong to the shared
 * loader's `reloadFileContents`; this hook only plans root/path scope.
 */
export function useWorkspaceOpenFileRefresh({
  reloadFileContents,
  tabs,
}: UseWorkspaceOpenFileRefreshParams): void {
  const handleRefresh = useEventCallback((event: Event): void => {
    const { detail } = event as FileExplorerRefreshEvent;
    const plan = planOpenFileRefresh(tabs, detail);
    if (plan.invalidCompositeKeys.length > 0) {
      logger.warn('Skipping malformed open-file composite keys during refresh', {
        count: plan.invalidCompositeKeys.length,
      });
    }
    if (plan.keysToReload.length === 0) {
      return;
    }
    reloadFileContents(plan.keysToReload, 'background').catch((error: unknown) => {
      logger.error('Failed to reload open file content after workspace refresh', {
        error: error instanceof Error ? error.message : String(error),
        fileCount: plan.keysToReload.length,
      });
    });
  });

  useEffect(() => {
    window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefresh);
    return () => {
      window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefresh);
    };
  }, [handleRefresh]);
}
