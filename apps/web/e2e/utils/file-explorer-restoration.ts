import type { Page } from '@playwright/test';
import type { FileTree } from './mock-fs';

export interface PersistedExplorerStoreSnapshot {
  currentFolderId: string | null;
  folderExpandedCount: number;
  topLevelExpandedCount: number;
}

export async function getExpandedDirectoryCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const fileExplorerStoreKey = '__brainstrike_file_explorer_provider_store__';
    const browserWindow = window as Window & {
      [fileExplorerStoreKey]?: {
        getState?: () => { expandedDirectoryPaths?: Set<string> };
      };
    };
    const fileExplorerStore = browserWindow[fileExplorerStoreKey];
    return fileExplorerStore?.getState?.().expandedDirectoryPaths?.size ?? 0;
  });
}

export async function persistCurrentExplorerStoreSnapshot(
  page: Page
): Promise<PersistedExplorerStoreSnapshot> {
  return page.evaluate(() => {
    const fileExplorerStoreKey = '__brainstrike_file_explorer_provider_store__';
    const browserWindow = window as Window & {
      [fileExplorerStoreKey]?: {
        getState?: () => {
          currentFolderId?: string | null;
          expandedDirectoryPaths?: Set<string>;
          folderStates?: Record<string, { expandedDirectoryPaths?: Set<string> }>;
        };
        persist?: {
          getOptions?: () => {
            name?: string;
            partialize?: (state: unknown) => unknown;
            version?: number;
          };
        };
      };
    };
    const store = browserWindow[fileExplorerStoreKey];
    const state = store?.getState?.();
    const options = store?.persist?.getOptions?.();
    if (!(state && options?.name && options.partialize)) {
      throw new Error('File explorer persistence API is unavailable');
    }

    const snapshot = {
      state: options.partialize(state) as {
        currentFolderId?: string | null;
        devInlineFixtureEnabled?: boolean;
        expandedDirectoryPaths?: string[];
        folderStates?: Record<string, { expandedDirectoryPaths?: string[] }>;
      },
      version: options.version ?? 0,
    };
    snapshot.state.devInlineFixtureEnabled = false;
    localStorage.setItem(options.name, JSON.stringify(snapshot));

    const currentFolderId = snapshot.state.currentFolderId ?? null;
    const folderExpandedCount = currentFolderId
      ? (snapshot.state.folderStates?.[currentFolderId]?.expandedDirectoryPaths?.length ?? 0)
      : 0;
    return {
      currentFolderId,
      folderExpandedCount,
      topLevelExpandedCount: snapshot.state.expandedDirectoryPaths?.length ?? 0,
    };
  });
}

export async function restoreInlineFixture(
  page: Page,
  rootName: string,
  tree: FileTree
): Promise<void> {
  await page.evaluate(
    async ({ contents, root }) => {
      const loadFixtureKey = '__BRAINSTRIKE_LOAD_FIXTURE__';
      const browserWindow = window as Window & {
        [loadFixtureKey]?: (fixture: {
          name: string;
          tree: FileTree;
        }) => Promise<unknown> | unknown;
      };
      const loadFixture = browserWindow[loadFixtureKey];
      if (typeof loadFixture !== 'function') {
        throw new Error('Fixture testing API was not exposed');
      }
      const handle = await loadFixture({ name: root, tree: contents });
      if (!handle) {
        throw new Error('Fixture testing API did not return a directory handle');
      }
    },
    { contents: tree, root: rootName }
  );
}
