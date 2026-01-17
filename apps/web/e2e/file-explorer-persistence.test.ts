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

async function supportsOpfs(page: Page): Promise<boolean> {
  return page.evaluate(() => typeof navigator.storage?.getDirectory === 'function');
}

async function clearIndexedDb(page: Page, dbName: string): Promise<void> {
  await page.evaluate(async (name) => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
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

    await expect(page.getByText('Restore access to your last folder?')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: 'Restore Access' }).click();

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

    await expect(page.getByText('Restore access to your last folder?')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: 'Restore Access' }).click();

    await ensureConsolePanelVisible(page);
    await expect(elements.consolePanel).toBeVisible();
    await expect(elements.consolePanel.getByRole('button', { name: /alpha\.ts/ })).toBeVisible();
    await expect(page.getByText('alpha content')).toBeVisible({ timeout: 15_000 });
  });
});
