import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { WEB_CHROMIUM_VERSION } from '../config/web-chromium.mjs';
import type { WebE2ETestHooks } from '../src/web-e2e-test-hooks';
import { FileExplorerPage } from './page-objects/file-explorer-page';
import { resetAppState, seedWorkspaceFocusedShellLayout } from './utils/app-state';
import { clickExplorerTreeAction } from './utils/file-tree-locators';
import { waitForAppLoad } from './utils/layout-helpers';
import type { FileTree } from './utils/mock-fs';

test.beforeEach(async ({ page }) => {
  // Reload assertions need the same strict durable-write guarantee as real web stores.
  await page.addInitScript(() => {
    Reflect.set(window, '__brainstrikeWebE2ERequireDurableWrites__', true);
  });
});

test.beforeAll(async ({ browser }, testInfo) => {
  if (browser.browserType().name() !== 'chromium') {
    return;
  }
  const actualVersion = browser.version();
  await testInfo.attach('chromium-version', {
    body: JSON.stringify({ actualVersion, expectedVersion: WEB_CHROMIUM_VERSION }),
    contentType: 'application/json',
  });
  expect(actualVersion).toBe(WEB_CHROMIUM_VERSION);
});

const ROOT_NAME = 'persistent-root';
const FILE_TREE: FileTree = {
  'alpha.ts': 'alpha content',
  folder: {
    'beta.ts': 'beta content',
  },
};
const LARGE_QUERY_ROOT_NAME = 'persistent-large-query-root';
// Query-backed selection starts above the 500-file materialization threshold.
const LARGE_QUERY_FILE_COUNT = 501;
const LARGE_QUERY_TREE: FileTree = Object.fromEntries(
  Array.from({ length: LARGE_QUERY_FILE_COUNT }, (_, index) => [
    `file-${index}.ts`,
    `export const value${index} = ${index};`,
  ])
);
const CACHED_SELECT_ALL_ROOT_NAME = 'cached-select-all-root';
const CACHED_SELECT_ALL_TREE: FileTree = {
  'root.ts': 'export const root = "root";\n'.repeat(120),
  src: Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `file-${index}.ts`,
      `export const value${index} = "${'cached '.repeat(40)}${index}";\n`,
    ])
  ),
};
const STALE_SELECTION_ROOT_NAME = 'brainstrike';
// Storage v5: folderStates/currentFolderId are keyed by a durable RootId UUID,
// never the root name/path. The stale-selection seeds use a fixed RootId and
// pre-store the OPFS handle in the web handle cache under that id, so the live
// pick's isSameEntry dedupe reuses it and folderStates[rootId] rehydrates.
const STALE_SELECTION_ROOT_ID = 'e2e-web-root-00000000-0000-4000-8000-000000000001';
const CURRENT_FILE_EXPLORER_STORAGE_VERSION = 5;

async function supportsOpfs(page: Page): Promise<boolean> {
  return page.evaluate(() => typeof navigator.storage?.getDirectory === 'function');
}

async function clearIndexedDb(page: Page, dbName: string): Promise<void> {
  await page.evaluate(async (name) => {
    await new Promise<void>((resolve) => {
      const timeoutId = setTimeout(resolve, 1000);
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => {
        clearTimeout(timeoutId);
        resolve();
      };
      request.onerror = () => {
        clearTimeout(timeoutId);
        resolve();
      };
      request.onblocked = () => {
        clearTimeout(timeoutId);
        resolve();
      };
    });
  }, dbName);
}

async function setupOpfsDirectoryPicker(
  page: Page,
  rootName: string,
  tree: FileTree
): Promise<void> {
  await page.evaluate(
    async ({ root, contents }) => {
      if (typeof navigator.storage?.getDirectory !== 'function') {
        throw new Error('OPFS not supported');
      }

      const opfsRoot = await navigator.storage.getDirectory();
      const rootHandle = await opfsRoot.getDirectoryHandle(root, { create: true });

      async function clearDirectory(dir: FileSystemDirectoryHandle): Promise<void> {
        for await (const [name] of dir.entries()) {
          await dir.removeEntry(name, { recursive: true });
        }
      }

      async function writeFile(
        dir: FileSystemDirectoryHandle,
        name: string,
        content: string
      ): Promise<void> {
        const fileHandle = await dir.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
      }

      async function populateDirectory(
        dir: FileSystemDirectoryHandle,
        data: Record<string, FileTree | null | string>
      ): Promise<void> {
        for (const [name, value] of Object.entries(data)) {
          if (value && typeof value === 'object') {
            const childDir = await dir.getDirectoryHandle(name, { create: true });
            await populateDirectory(childDir, value as Record<string, FileTree | null | string>);
          } else {
            const content = typeof value === 'string' ? value : `${name} content`;
            await writeFile(dir, name, content);
          }
        }
      }

      await clearDirectory(rootHandle);
      await populateDirectory(rootHandle, contents);

      window.showDirectoryPicker = async () => rootHandle;
    },
    {
      contents: tree,
      root: rootName,
    }
  );
}

/**
 * Pre-store the OPFS directory handle in the WebHandleCache IndexedDB store
 * ('brainstrike-file-handles', v2 schema, root-handles keyed by rootId) so the
 * next live pick's isSameEntry dedupe scan finds it and REUSES `rootId`
 * instead of minting a fresh UUID.
 *
 * Must run AFTER the app has booted (post-reload): seeding before boot would
 * trigger the multi-root auto-restore of the granted OPFS handle, defeating
 * any "stale until the user re-picks" scenario.
 *
 * The handle stored here and the handle returned by the mocked picker must be
 * the SAME OPFS directory (same `rootName` path) for isSameEntry to match.
 */
async function seedRootHandleInCache(page: Page, rootId: string, rootName: string): Promise<void> {
  await page.evaluate(
    async ({ id, root }) => {
      if (typeof navigator.storage?.getDirectory !== 'function') {
        throw new Error('OPFS not supported');
      }
      const opfsRoot = await navigator.storage.getDirectory();
      const rootHandle = await opfsRoot.getDirectoryHandle(root, { create: true });

      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('brainstrike-file-handles', 2);
        request.onupgradeneeded = () => {
          // Mirror WebHandleCache's v2 schema exactly (web-handle-cache.ts).
          const upgradeDb = request.result;
          if (!upgradeDb.objectStoreNames.contains('root-handles')) {
            const store = upgradeDb.createObjectStore('root-handles', { keyPath: 'folderId' });
            store.createIndex('by-last-accessed', 'lastAccessedAt');
          }
          if (!upgradeDb.objectStoreNames.contains('file-handles')) {
            const store = upgradeDb.createObjectStore('file-handles', { keyPath: 'path' });
            store.createIndex('by-folder', 'folderId');
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('root-handles', 'readwrite');
        tx.objectStore('root-handles').put({
          folderId: id,
          handle: rootHandle,
          lastAccessedAt: Date.now(),
          name: root,
          storedAt: Date.now(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    { id: rootId, root: rootName }
  );
}

async function openPreviewFile(page: Page, fileName: string): Promise<void> {
  // A file-name click opens the file in a tab.
  const fileLabel = new FileExplorerPage(page).fileTree.getByText(fileName, { exact: true });
  await fileLabel.scrollIntoViewIfNeeded();
  await expect(fileLabel).toBeVisible({ timeout: 15_000 });
  await fileLabel.click();
  // A rendered file is not an acknowledgement of its asynchronous workspace save.
  const persisted = await page.waitForFunction(
    async (expectedName) => {
      const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
        .__brainstrikeWebE2ETestHooks__;
      if (!hooks) {
        return false;
      }
      const workspace = await hooks.readActiveThreadWorkspace();
      const activeFile = workspace?.activeFileTab;
      const snapshot = workspace?.snapshot;
      if (!(activeFile && snapshot) || activeFile.path.split('/').at(-1) !== expectedName) {
        return false;
      }
      return (
        snapshot.fileTabs.activeTabId === activeFile.compositeKey &&
        snapshot.fileTabs.tabs.some(
          (tab) => tab.compositeKey === activeFile.compositeKey && tab.path === activeFile.path
        ) &&
        snapshot.apps.selection.kind === 'file' &&
        snapshot.apps.selection.tabId === activeFile.compositeKey
      );
    },
    fileName,
    { timeout: 15_000 }
  );
  await persisted.dispose();
}

async function clickDirectoryToggle(
  explorer: FileExplorerPage,
  directoryName: string,
  action: 'Collapse' | 'Expand'
): Promise<void> {
  const escapedName = directoryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const row = explorer.fileTree
    .getByRole('row', { name: new RegExp(`^${action} Select ${escapedName}\\b`) })
    .first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole('button', { name: action }).click();
}

async function restoreAccessIfNeeded(page: Page, explorer: FileExplorerPage): Promise<void> {
  const restoreBanner = page.getByText('Restore access to your last folder?');
  const restoreButton = page.getByRole('button', { name: 'Restore Access' });
  const start = Date.now();

  while (Date.now() - start < 10_000) {
    if (await explorer.fileTree.isVisible().catch(() => false)) {
      return;
    }
    if (await restoreBanner.isVisible().catch(() => false)) {
      await restoreButton.click();
      return;
    }
    await page.waitForTimeout(200);
  }
}

async function resetExplorerState(
  page: Page,
  extraStorageKeys: string[] = [],
  options: { readonly waitForDatabase?: boolean } = {}
): Promise<void> {
  await resetAppState(page);
  if (extraStorageKeys.length > 0) {
    await page.evaluate((keys) => {
      for (const key of keys) {
        localStorage.removeItem(key);
      }
    }, extraStorageKeys);
  }
  await clearIndexedDb(page, 'brainstrike-file-handles');
  await seedWorkspaceFocusedShellLayout(page);
  await page.reload();
  await waitForAppLoad(page, { waitForDatabase: options.waitForDatabase ?? true });
}

async function setMaxSelectionCount(page: Page, value: number | string): Promise<void> {
  const settingsButton = page.getByRole('button', { name: /Selection settings/i });
  await settingsButton.click();

  const input = page.getByLabel('Maximum selection count input');
  await expect(input).toBeVisible();
  await input.fill(String(value));
  await page.getByRole('button', { name: 'Apply selection count' }).click();
  await expect(input).not.toBeVisible();
}

async function readPersistedExplorerState(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('file-explorer-storage-v5');
    return raw ? JSON.parse(raw) : null;
  });
}

async function seedPersistedSelectionState(
  page: Page,
  folderId: string,
  selectedCount: number,
  storageVersion = CURRENT_FILE_EXPLORER_STORAGE_VERSION
): Promise<void> {
  await page.evaluate(
    ({ count, id, version }) => {
      const selectedFilePaths = Array.from(
        { length: count },
        (_, index) => `${id}|@|src/file-${index}.ts`
      );
      const selectionModel = {
        explicitPaths: selectedFilePaths,
        materializedAt: null,
        materializedPaths: null,
        mode: 'explicit',
        queryDescriptor: null,
      };
      const folderState = {
        excludeFilters: [],
        expandedDirectoryPaths: ['src'],
        folderSummaryThreshold: 5,
        includeFilters: [],
        includeProjectTree: true,
        lastAccessed: Date.now(),
        lastActiveTab: 'files',
        maxSelectionCount: count,
        selectedFilePaths,
        selectionModel,
        tokenBudget: 100_000,
        useRegex: false,
        viewFilterPresetId: null,
      };

      localStorage.setItem(
        'file-explorer-storage-v5',
        JSON.stringify({
          state: {
            currentFolderId: id,
            devInlineFixtureEnabled: false,
            excludeFilters: [],
            expandedDirectoryPaths: ['src'],
            folderAccessOrder: [id],
            folderStates: {
              [id]: folderState,
            },
            folderSummaryThreshold: 5,
            includeFilters: [],
            includeProjectTree: true,
            isFiltersExpanded: true,
            lastActiveTab: 'files',
            maxSelectionCount: count,
            quickFilter: '',
            selectedFilePaths,
            selectionModel,
            tokenBudget: 100_000,
            useRegex: false,
            viewFilterPresetId: null,
          },
          version,
        })
      );
    },
    { count: selectedCount, id: folderId, version: storageVersion }
  );
}

test.describe('File Explorer persistence (web) @stateful @web-file-explorer-persistence', () => {
  test('restores last folder via stored handle after reload', async ({ page, browserName }) => {
    if (browserName !== 'chromium') {
      test.skip(true, 'File System Access API is only available in Chromium');
    }

    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });

    if (!(await supportsOpfs(page))) {
      test.skip(true, 'OPFS not available in this environment');
    }

    await resetExplorerState(page);
    await setupOpfsDirectoryPicker(page, ROOT_NAME, FILE_TREE);

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();
    await expect(explorer.fileTree.getByText('alpha.ts')).toBeVisible();

    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });

    await restoreAccessIfNeeded(page, explorer);

    await expect(explorer.fileTree).toBeVisible({ timeout: 15_000 });
    await expect(explorer.fileTree.getByText('alpha.ts')).toBeVisible();
  });

  test('keeps open tabs after reload once access is restored', async ({ page, browserName }) => {
    if (browserName !== 'chromium') {
      test.skip(true, 'File System Access API is only available in Chromium');
    }

    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });

    if (!(await supportsOpfs(page))) {
      test.skip(true, 'OPFS not available in this environment');
    }

    await resetExplorerState(page, ['tab-manager.v1']);
    await setupOpfsDirectoryPicker(page, ROOT_NAME, FILE_TREE);

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();

    const fileTree = explorer.fileTree;
    const fileCheckbox = fileTree.getByRole('checkbox', { name: 'Select alpha.ts' });
    await expect(fileCheckbox).toBeVisible();
    await fileCheckbox.click({ force: true });
    await expect(fileCheckbox).toBeChecked();

    await openPreviewFile(page, 'alpha.ts');

    const tabButton = page.getByRole('tab', { name: /alpha\.ts/ }).first();
    await expect(tabButton).toBeVisible();
    await expect(page.getByText('alpha content')).toBeVisible();

    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });

    await restoreAccessIfNeeded(page, explorer);

    await expect(page.getByRole('tab', { name: /alpha\.ts/ })).toBeVisible();
    await expect(page.getByText('alpha content')).toBeVisible({ timeout: 15_000 });
  });

  test('restores expanded folders and selected nested files after reload', async ({
    page,
    browserName,
  }) => {
    if (browserName !== 'chromium') {
      test.skip(true, 'File System Access API is only available in Chromium');
    }

    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });

    if (!(await supportsOpfs(page))) {
      test.skip(true, 'OPFS not available in this environment');
    }

    await resetExplorerState(page);
    await setupOpfsDirectoryPicker(page, ROOT_NAME, FILE_TREE);

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();

    await clickExplorerTreeAction(page, 'expand-all');

    const nestedCheckbox = explorer.fileTree.getByRole('checkbox', { name: 'Select beta.ts' });
    await expect(nestedCheckbox).toBeVisible({ timeout: 10_000 });
    await nestedCheckbox.click({ force: true });
    await expect(nestedCheckbox).toBeChecked();
    await expect(page.getByText('1/10')).toBeVisible();

    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });

    await restoreAccessIfNeeded(page, explorer);

    await expect(explorer.fileTree).toBeVisible({ timeout: 15_000 });
    // The Files page is wide enough for the Type column, whose cell also reads "folder".
    await expect(explorer.fileTree.getByText('folder', { exact: true }).first()).toBeVisible();
    await expect(explorer.fileTree.getByText('beta.ts')).toBeVisible();

    const restoredCheckbox = explorer.fileTree.getByRole('checkbox', { name: 'Select beta.ts' });
    await expect(restoredCheckbox).toBeChecked();
    await expect(page.getByText('1/10')).toBeVisible();

    await openPreviewFile(page, 'beta.ts');
    await expect(page.getByRole('tab', { name: /beta\.ts/ })).toBeVisible();
    await expect(page.getByText('beta content')).toBeVisible({ timeout: 15_000 });
  });

  test('restores expanded folders without selections and keeps single-click toggles after reload', async ({
    page,
    browserName,
  }) => {
    if (browserName !== 'chromium') {
      test.skip(true, 'File System Access API is only available in Chromium');
    }

    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });

    if (!(await supportsOpfs(page))) {
      test.skip(true, 'OPFS not available in this environment');
    }

    await resetExplorerState(page, [], { waitForDatabase: false });
    await setupOpfsDirectoryPicker(page, ROOT_NAME, {
      'root.ts': 'root content',
      src: {
        'index.ts': 'index content',
        nested: {
          'deep.ts': 'deep content',
        },
      },
    });

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();

    await clickDirectoryToggle(explorer, 'src', 'Expand');
    await expect(explorer.fileTree.getByText('index.ts')).toBeVisible({ timeout: 15_000 });

    await clickDirectoryToggle(explorer, 'nested', 'Expand');
    await expect(explorer.fileTree.getByText('deep.ts')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('0/10')).toBeVisible();

    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
    await restoreAccessIfNeeded(page, explorer);

    await expect(explorer.fileTree).toBeVisible({ timeout: 15_000 });
    await expect(explorer.fileTree.getByText('index.ts')).toBeVisible({ timeout: 15_000 });
    await expect(explorer.fileTree.getByText('deep.ts')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('0/10')).toBeVisible();

    await clickDirectoryToggle(explorer, 'nested', 'Collapse');
    await expect(explorer.fileTree.getByText('deep.ts')).not.toBeVisible();

    await clickDirectoryToggle(explorer, 'nested', 'Expand');
    await expect(explorer.fileTree.getByText('deep.ts')).toBeVisible({ timeout: 15_000 });
  });

  test('completes Select All after restoring web folder access', async ({ page, browserName }) => {
    if (browserName !== 'chromium') {
      test.skip(true, 'File System Access API is only available in Chromium');
    }

    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });

    if (!(await supportsOpfs(page))) {
      test.skip(true, 'OPFS not available in this environment');
    }

    await resetExplorerState(page, [], { waitForDatabase: false });
    await setupOpfsDirectoryPicker(page, ROOT_NAME, FILE_TREE);

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();
    await expect(explorer.fileTree.getByText('alpha.ts')).toBeVisible();

    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
    await restoreAccessIfNeeded(page, explorer);

    await expect(explorer.fileTree).toBeVisible({ timeout: 15_000 });

    const selectAllButton = page.getByRole('button', { name: 'Select All' });
    await expect(selectAllButton).toBeEnabled();
    await selectAllButton.click();

    await expect(page.getByText('2/10')).toBeVisible({ timeout: 15_000 });

    const alphaCheckbox = explorer.fileTree.getByRole('checkbox', { name: 'Select alpha.ts' });
    await expect(alphaCheckbox).toBeChecked();

    await clickExplorerTreeAction(page, 'expand-all');

    const betaCheckbox = explorer.fileTree.getByRole('checkbox', { name: 'Select beta.ts' });
    await expect(betaCheckbox).toBeChecked({ timeout: 15_000 });
  });

  test('completes Select All while restored expanded paths are still replaying', async ({
    page,
    browserName,
  }) => {
    if (browserName !== 'chromium') {
      test.skip(true, 'File System Access API is only available in Chromium');
    }

    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });

    if (!(await supportsOpfs(page))) {
      test.skip(true, 'OPFS not available in this environment');
    }

    await resetExplorerState(page);
    await setupOpfsDirectoryPicker(page, ROOT_NAME, {
      'root.ts': 'root content',
      src: {
        'index.ts': 'index content',
        nested: {
          'deep.ts': 'deep content',
        },
      },
    });

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();

    await clickExplorerTreeAction(page, 'expand-all');
    await expect(explorer.fileTree.getByText('deep.ts')).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
    await restoreAccessIfNeeded(page, explorer);

    await expect(explorer.fileTree).toBeVisible({ timeout: 15_000 });

    const selectAllButton = page.getByRole('button', { name: 'Select All' });
    await expect(selectAllButton).toBeEnabled();
    await selectAllButton.click();

    await expect(page.getByText('3/10')).toBeVisible({ timeout: 15_000 });

    const deepCheckbox = explorer.fileTree.getByRole('checkbox', { name: 'Select deep.ts' });
    await expect(deepCheckbox).toBeChecked({ timeout: 15_000 });
  });

  test('respects max selection count when Select All is triggered after restore', async ({
    page,
    browserName,
  }) => {
    if (browserName !== 'chromium') {
      test.skip(true, 'File System Access API is only available in Chromium');
    }

    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });

    if (!(await supportsOpfs(page))) {
      test.skip(true, 'OPFS not available in this environment');
    }

    await resetExplorerState(page);
    await setupOpfsDirectoryPicker(page, ROOT_NAME, {
      'root.ts': 'root content',
      src: {
        'index.ts': 'index content',
        nested: {
          'deep.ts': 'deep content',
        },
      },
    });

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();
    await setMaxSelectionCount(page, 1);

    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
    await restoreAccessIfNeeded(page, explorer);

    const selectAllButton = page.getByRole('button', { name: 'Select All' });
    await expect(selectAllButton).toBeEnabled();
    await selectAllButton.click();

    await expect(page.getByRole('button', { name: 'Selection count (read-only)' })).toContainText(
      '1/1',
      { timeout: 15_000 }
    );
    // Observe one toast mount window after the capped selection completes.
    await page.waitForTimeout(500);
    await expect(
      page.getByText('Cannot select more files. Maximum selection limit reached.')
    ).toHaveCount(0);
  });

  test('preserves stale persisted selections and rehydrates them after choosing the root', async ({
    page,
    browserName,
  }) => {
    if (browserName !== 'chromium') {
      test.skip(true, 'File System Access API is only available in Chromium');
    }

    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });

    if (!(await supportsOpfs(page))) {
      test.skip(true, 'OPFS not available in this environment');
    }

    await resetExplorerState(page);
    await seedPersistedSelectionState(page, STALE_SELECTION_ROOT_ID, 2000);
    await page.reload();
    await waitForAppLoad(page);

    const explorer = new FileExplorerPage(page);
    await expect(page.getByText('No folders in your workspace')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Selection count (read-only)' })).toContainText(
      '0/2000',
      { timeout: 15_000 }
    );
    // No restored handle is active; the saved selection belongs to this root
    // until the user grants access to that same root again.
    await expect
      .poll(() => readPersistedExplorerState(page))
      .toMatchObject({
        state: {
          currentFolderId: null,
          folderStates: {
            [STALE_SELECTION_ROOT_ID]: {
              selectedFilePaths: Array.from(
                { length: 2000 },
                (_, index) => `${STALE_SELECTION_ROOT_ID}|@|src/file-${index}.ts`
              ),
            },
          },
        },
      });

    await setupOpfsDirectoryPicker(page, STALE_SELECTION_ROOT_NAME, {
      src: {
        'file-0.ts': 'export const zero = 0;',
      },
    });
    // Pre-store the same OPFS directory in the handle cache under the seeded
    // RootId so addRoot's isSameEntry dedupe reuses it on the live pick and
    // folderStates[STALE_SELECTION_ROOT_ID] rehydrates.
    await seedRootHandleInCache(page, STALE_SELECTION_ROOT_ID, STALE_SELECTION_ROOT_NAME);

    await explorer.selectRoot();
    await expect(explorer.fileTree.getByText('src')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Selection count (read-only)' })).toContainText(
      '2K/2K',
      { timeout: 15_000 }
    );
  });

  test('discards older persisted explorer snapshots and still allows root selection', async ({
    page,
    browserName,
  }) => {
    if (browserName !== 'chromium') {
      test.skip(true, 'File System Access API is only available in Chromium');
    }

    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });

    if (!(await supportsOpfs(page))) {
      test.skip(true, 'OPFS not available in this environment');
    }

    await resetExplorerState(page);
    // Old (version 2) snapshot — must be DISCARDED, so the seeded identity is
    // irrelevant; the RootId constant is used purely for seed-signature
    // consistency with the rehydration test above.
    await seedPersistedSelectionState(page, STALE_SELECTION_ROOT_ID, 2000, 2);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });

    const explorer = new FileExplorerPage(page);
    await expect(page.getByText('No folders in your workspace')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Selection count (read-only)' })).toContainText(
      '0/10',
      { timeout: 15_000 }
    );

    await setupOpfsDirectoryPicker(page, STALE_SELECTION_ROOT_NAME, {
      src: {
        'file-0.ts': 'export const zero = 0;',
      },
    });

    await explorer.selectRoot();
    await expect(explorer.fileTree.getByText('src')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Selection count (read-only)' })).toContainText(
      '0/10',
      { timeout: 15_000 }
    );
    await expect
      .poll(async () => {
        const persisted = await readPersistedExplorerState(page);
        return persisted &&
          typeof persisted === 'object' &&
          'version' in persisted &&
          persisted.version === CURRENT_FILE_EXPLORER_STORAGE_VERSION
          ? persisted.version
          : null;
      })
      .toBe(CURRENT_FILE_EXPLORER_STORAGE_VERSION);
  });

  test('persists large select-all as query-backed selection instead of giant explicit sets', async ({
    page,
    browserName,
  }) => {
    if (browserName !== 'chromium') {
      test.skip(true, 'File System Access API is only available in Chromium');
    }

    await page.goto('/');
    await waitForAppLoad(page);

    if (!(await supportsOpfs(page))) {
      test.skip(true, 'OPFS not available in this environment');
    }

    await resetExplorerState(page);
    await setupOpfsDirectoryPicker(page, LARGE_QUERY_ROOT_NAME, LARGE_QUERY_TREE);

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();
    await setMaxSelectionCount(page, 1000);

    const selectAllButton = page.getByRole('button', { name: 'Select All' });
    await expect(selectAllButton).toBeEnabled();
    await selectAllButton.click();

    await expect(page.getByText(`${LARGE_QUERY_FILE_COUNT}/1000`)).toBeVisible({
      timeout: 30_000,
    });

    const persisted = (await readPersistedExplorerState(page)) as {
      state?: {
        selectedFilePaths?: string[];
        selectionModel?: {
          materializedPaths?: string[] | null;
          mode?: string;
          queryDescriptor?: {
            totalSelectedCount?: number;
          } | null;
        };
      };
    } | null;

    expect(persisted?.state?.selectionModel?.mode).toBe('query');
    expect(persisted?.state?.selectionModel?.queryDescriptor?.totalSelectedCount).toBe(
      LARGE_QUERY_FILE_COUNT
    );
    expect((persisted?.state?.selectionModel?.materializedPaths?.length ?? 0) > 0).toBe(true);
    expect((persisted?.state?.selectedFilePaths?.length ?? 0) < LARGE_QUERY_FILE_COUNT).toBe(true);

    await page.reload();
    await waitForAppLoad(page);
    await restoreAccessIfNeeded(page, explorer);

    await expect(page.getByText(`${LARGE_QUERY_FILE_COUNT}/1000`)).toBeVisible({
      timeout: 30_000,
    });
  });

  test('restores cached token totals for select-all on a collapsed tree without re-expanding', async ({
    page,
    browserName,
  }) => {
    if (browserName !== 'chromium') {
      test.skip(true, 'File System Access API is only available in Chromium');
    }

    await page.goto('/');
    await waitForAppLoad(page);

    if (!(await supportsOpfs(page))) {
      test.skip(true, 'OPFS not available in this environment');
    }

    await resetExplorerState(page);
    await setupOpfsDirectoryPicker(page, CACHED_SELECT_ALL_ROOT_NAME, CACHED_SELECT_ALL_TREE);

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();
    await setMaxSelectionCount(page, 25);

    await clickExplorerTreeAction(page, 'expand-all');
    await expect(explorer.fileTree.getByText('file-11.ts')).toBeVisible({ timeout: 15_000 });

    const selectAllButton = page.getByRole('button', { name: 'Select All' });
    await expect(selectAllButton).toBeEnabled();
    await selectAllButton.click();

    // The Export popover totals the selection from the token cache (BST-2018).
    const exportTrigger = page.getByTestId('explorer-export-trigger');
    const selectionTokens = page.getByTestId('explorer-export-tokens');
    await exportTrigger.click();
    await expect(selectionTokens).toHaveText(/^~[1-9]\d*(?:,\d{3})* tokens$/, { timeout: 15_000 });
    await page.keyboard.press('Escape');

    const deselectAllButton = page.getByRole('button', { name: 'Deselect All' });
    await expect(deselectAllButton).toBeEnabled();
    await deselectAllButton.click();
    await expect(page.getByText('0/25')).toBeVisible({ timeout: 15_000 });

    await clickExplorerTreeAction(page, 'collapse-all');
    await expect(explorer.fileTree.getByText('file-11.ts')).not.toBeVisible();

    await page.reload();
    await waitForAppLoad(page);
    await restoreAccessIfNeeded(page, explorer);

    await expect(explorer.fileTree).toBeVisible({ timeout: 15_000 });
    await expect(explorer.fileTree.getByText('src')).toBeVisible({ timeout: 15_000 });
    await expect(explorer.fileTree.getByText('file-11.ts')).not.toBeVisible();

    await selectAllButton.click();

    // Restored from the cache without re-expanding: no file is left pending.
    await exportTrigger.click();
    await expect(selectionTokens).toHaveText(/^~[1-9]\d*(?:,\d{3})* tokens$/, { timeout: 15_000 });
  });
});
