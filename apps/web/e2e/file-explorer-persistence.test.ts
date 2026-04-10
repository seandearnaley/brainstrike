import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FileExplorerPage } from './page-objects/file-explorer-page';
import { resetAppState } from './utils/app-state';
import { getPanelElements, togglePanelVisibility, waitForAppLoad } from './utils/layout-helpers';
import type { FileTree } from './utils/mock-fs';

const ROOT_NAME = 'persistent-root';
const FILE_TREE: FileTree = {
  'alpha.ts': 'alpha content',
  folder: {
    'beta.ts': 'beta content',
  },
};
const LARGE_QUERY_ROOT_NAME = 'persistent-large-query-root';
const LARGE_QUERY_TREE: FileTree = Object.fromEntries(
  Array.from({ length: 600 }, (_, index) => [
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
      root: rootName,
      contents: tree,
    }
  );
}

async function ensureConsolePanelVisible(page: Page): Promise<void> {
  const elements = getPanelElements(page);
  const isVisible = await elements.consolePanel.isVisible().catch(() => false);
  if (isVisible) {
    return;
  }
  if (await elements.showConsoleShim.isVisible().catch(() => false)) {
    await togglePanelVisibility(elements.showConsoleShim, elements.consolePanel, true);
  }
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

async function resetExplorerState(page: Page, extraStorageKeys: string[] = []): Promise<void> {
  await resetAppState(page);
  if (extraStorageKeys.length > 0) {
    await page.evaluate((keys) => {
      for (const key of keys) {
        localStorage.removeItem(key);
      }
    }, extraStorageKeys);
  }
  await clearIndexedDb(page, 'brainstrike-file-handles');
  await page.reload();
  await waitForAppLoad(page);
}

async function setMaxSelectionCount(page: Page, value: number | string): Promise<void> {
  const counterButton = page.getByRole('button', {
    name: /Click to edit maximum selection count/i,
  });
  await counterButton.click();

  const input = page.getByLabel('Maximum selection count input');
  await expect(input).toBeVisible();
  await input.fill(String(value));
  await page.getByRole('button', { name: 'Apply selection count' }).click();
  await expect(input).not.toBeVisible();
}

async function readPersistedExplorerState(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('file-explorer-storage-v4');
    return raw ? JSON.parse(raw) : null;
  });
}

test.describe('File Explorer persistence (web)', () => {
  test('restores last folder via stored handle after reload', async ({ page, browserName }) => {
    if (browserName !== 'chromium') {
      test.skip(true, 'File System Access API is only available in Chromium');
    }

    await page.goto('/');
    await waitForAppLoad(page);

    if (!(await supportsOpfs(page))) {
      test.skip(true, 'OPFS not available in this environment');
    }

    await resetExplorerState(page);
    await setupOpfsDirectoryPicker(page, ROOT_NAME, FILE_TREE);

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();
    await expect(explorer.fileTree.getByText('alpha.ts')).toBeVisible();

    await page.reload();
    await waitForAppLoad(page);

    await restoreAccessIfNeeded(page, explorer);

    await expect(explorer.fileTree).toBeVisible({ timeout: 15_000 });
    await expect(explorer.fileTree.getByText('alpha.ts')).toBeVisible();
  });

  test('keeps open tabs after reload once access is restored', async ({ page, browserName }) => {
    if (browserName !== 'chromium') {
      test.skip(true, 'File System Access API is only available in Chromium');
    }

    await page.goto('/');
    await waitForAppLoad(page);

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

    await ensureConsolePanelVisible(page);

    const previewRow = page.getByRole('button', { name: 'alpha.ts' });
    await expect(previewRow).toBeVisible();
    await previewRow.click();

    const elements = getPanelElements(page);
    const tabButton = elements.consolePanel.getByRole('button', { name: /alpha\.ts/ }).first();
    await expect(tabButton).toBeVisible();
    await expect(page.getByText('alpha content')).toBeVisible();

    await page.reload();
    await waitForAppLoad(page);

    await restoreAccessIfNeeded(page, explorer);

    await ensureConsolePanelVisible(page);
    await expect(elements.consolePanel).toBeVisible();
    await expect(elements.consolePanel.getByRole('button', { name: /alpha\.ts/ })).toBeVisible();
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
    await waitForAppLoad(page);

    if (!(await supportsOpfs(page))) {
      test.skip(true, 'OPFS not available in this environment');
    }

    await resetExplorerState(page);
    await setupOpfsDirectoryPicker(page, ROOT_NAME, FILE_TREE);

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();

    const expandAllButton = page.getByTestId('expand-all-button-small');
    await expect(expandAllButton).toBeVisible();
    await expandAllButton.click();

    const nestedCheckbox = explorer.fileTree.getByRole('checkbox', { name: 'Select beta.ts' });
    await expect(nestedCheckbox).toBeVisible({ timeout: 10_000 });
    await nestedCheckbox.click({ force: true });
    await expect(nestedCheckbox).toBeChecked();
    await expect(page.getByText('1/10')).toBeVisible();

    await page.reload();
    await waitForAppLoad(page);

    await restoreAccessIfNeeded(page, explorer);

    await expect(explorer.fileTree).toBeVisible({ timeout: 15_000 });
    await expect(explorer.fileTree.getByText('folder')).toBeVisible();
    await expect(explorer.fileTree.getByText('beta.ts')).toBeVisible();

    const restoredCheckbox = explorer.fileTree.getByRole('checkbox', { name: 'Select beta.ts' });
    await expect(restoredCheckbox).toBeChecked();
    await expect(page.getByText('1/10')).toBeVisible();

    await ensureConsolePanelVisible(page);
    await page.getByRole('button', { name: 'beta.ts' }).click();
    await expect(page.getByText('beta content')).toBeVisible({ timeout: 15_000 });
  });

  test('completes Select All after restoring web folder access', async ({ page, browserName }) => {
    if (browserName !== 'chromium') {
      test.skip(true, 'File System Access API is only available in Chromium');
    }

    await page.goto('/');
    await waitForAppLoad(page);

    if (!(await supportsOpfs(page))) {
      test.skip(true, 'OPFS not available in this environment');
    }

    await resetExplorerState(page);
    await setupOpfsDirectoryPicker(page, ROOT_NAME, FILE_TREE);

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();
    await expect(explorer.fileTree.getByText('alpha.ts')).toBeVisible();

    await page.reload();
    await waitForAppLoad(page);
    await restoreAccessIfNeeded(page, explorer);

    await expect(explorer.fileTree).toBeVisible({ timeout: 15_000 });

    const selectAllButton = page.getByRole('button', { name: 'Select All' });
    await expect(selectAllButton).toBeEnabled();
    await selectAllButton.click();

    await expect(page.getByText('2/10')).toBeVisible({ timeout: 15_000 });

    const alphaCheckbox = explorer.fileTree.getByRole('checkbox', { name: 'Select alpha.ts' });
    await expect(alphaCheckbox).toBeChecked();

    const expandAllButton = page.getByTestId('expand-all-button-small');
    await expect(expandAllButton).toBeVisible();
    await expandAllButton.click();

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
    await waitForAppLoad(page);

    if (!(await supportsOpfs(page))) {
      test.skip(true, 'OPFS not available in this environment');
    }

    await resetExplorerState(page);
    await setupOpfsDirectoryPicker(page, ROOT_NAME, {
      src: {
        nested: {
          'deep.ts': 'deep content',
        },
        'index.ts': 'index content',
      },
      'root.ts': 'root content',
    });

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();

    const expandAllButton = page.getByTestId('expand-all-button-small');
    await expect(expandAllButton).toBeVisible();
    await expandAllButton.click();
    await expect(explorer.fileTree.getByText('deep.ts')).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await waitForAppLoad(page);
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
    await waitForAppLoad(page);

    if (!(await supportsOpfs(page))) {
      test.skip(true, 'OPFS not available in this environment');
    }

    await resetExplorerState(page);
    await setupOpfsDirectoryPicker(page, ROOT_NAME, {
      src: {
        nested: {
          'deep.ts': 'deep content',
        },
        'index.ts': 'index content',
      },
      'root.ts': 'root content',
    });

    const explorer = new FileExplorerPage(page);
    await explorer.selectRoot();
    await setMaxSelectionCount(page, 1);

    await page.reload();
    await waitForAppLoad(page);
    await restoreAccessIfNeeded(page, explorer);

    const selectAllButton = page.getByRole('button', { name: 'Select All' });
    await expect(selectAllButton).toBeEnabled();
    await selectAllButton.click();

    await expect(page.getByText('1/1')).toBeVisible({ timeout: 15_000 });
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

    await expect(page.getByText('600/1000')).toBeVisible({ timeout: 15_000 });

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
    expect(persisted?.state?.selectionModel?.queryDescriptor?.totalSelectedCount).toBe(600);
    expect((persisted?.state?.selectionModel?.materializedPaths?.length ?? 0) > 0).toBe(true);
    expect((persisted?.state?.selectedFilePaths?.length ?? 0) < 600).toBe(true);

    await page.reload();
    await waitForAppLoad(page);
    await restoreAccessIfNeeded(page, explorer);

    await expect(page.getByText('600/1000')).toBeVisible({ timeout: 15_000 });
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

    const expandAllButton = page.getByTestId('expand-all-button-small');
    await expect(expandAllButton).toBeVisible();
    await expandAllButton.click();
    await expect(explorer.fileTree.getByText('file-11.ts')).toBeVisible({ timeout: 15_000 });

    const selectAllButton = page.getByRole('button', { name: 'Select All' });
    await expect(selectAllButton).toBeEnabled();
    await selectAllButton.click();

    const seededTokenSummary = page.getByText(/[1-9]\d*(?:,\d{3})* output/);
    await expect(seededTokenSummary).toBeVisible({ timeout: 15_000 });

    const deselectAllButton = page.getByRole('button', { name: 'Deselect All' });
    await expect(deselectAllButton).toBeEnabled();
    await deselectAllButton.click();
    await expect(page.getByText('0/25')).toBeVisible({ timeout: 15_000 });

    const collapseAllButton = page.getByTestId('collapse-all-button-small');
    await expect(collapseAllButton).toBeVisible();
    await collapseAllButton.click();
    await expect(explorer.fileTree.getByText('file-11.ts')).not.toBeVisible();

    await page.reload();
    await waitForAppLoad(page);
    await restoreAccessIfNeeded(page, explorer);

    await expect(explorer.fileTree).toBeVisible({ timeout: 15_000 });
    await expect(explorer.fileTree.getByText('src')).toBeVisible();
    await expect(explorer.fileTree.getByText('file-11.ts')).not.toBeVisible();

    await selectAllButton.click();

    const restoredTokenSummary = page.getByText(/[1-9]\d*(?:,\d{3})* output/);
    await expect(restoredTokenSummary).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/estimating…/)).not.toBeVisible();
  });
});
