import type { ElectronApplication, Page } from 'playwright';
import { expect, test } from './fixtures/electron-fixture';

interface ElectronE2eFileSystemFixture {
  directoriesByPath: Record<string, unknown[]>;
  fileContentsByPath: Record<string, string>;
  readDirectoryCalls: string[];
  readFileByPathCalls: string[];
  readFileCalls: string[];
  requestDirectoryAccessCount: number;
  rootHandle: {
    id: string;
    kind: 'directory';
    name: string;
    path: string;
    platform: 'electron';
    type: 'directory';
  };
}

async function ensureLeftPanelVisible(page: Page): Promise<void> {
  const leftPanel = page.locator('#explorer-panel');
  const showLeftPanelButton = page
    .getByTestId('show-explorer-panel')
    .or(page.getByRole('button', { name: /show explorer/i }));

  if (
    !(await leftPanel.isVisible().catch(() => false)) &&
    (await showLeftPanelButton.isVisible().catch(() => false))
  ) {
    await showLeftPanelButton.click();
  }

  await expect(leftPanel).toBeVisible({ timeout: 15_000 });
}

async function setFileExplorerMaxSelectionCount(
  page: Page,
  maxSelectionCount: number
): Promise<void> {
  const selectionCounterButton = page.getByRole('button', {
    name: 'Click to edit maximum selection count',
  });
  await expect(selectionCounterButton).toBeVisible({ timeout: 15_000 });
  await selectionCounterButton.click({ timeout: 5000 });

  const selectionCountInput = page.getByLabel('Maximum selection count input');
  await expect(selectionCountInput).toBeVisible({ timeout: 15_000 });
  await selectionCountInput.fill(String(maxSelectionCount));
  await page.getByRole('button', { name: 'Apply selection count' }).click({ timeout: 5000 });
  await expect(page.getByTestId('selection-max')).toHaveText(String(maxSelectionCount), {
    timeout: 15_000,
  });
}

async function installNestedFolderFixture(
  electronApp: ElectronApplication,
  rootPath: string
): Promise<void> {
  const fixture: ElectronE2eFileSystemFixture = {
    directoriesByPath: {
      [rootPath]: [
        {
          name: 'mock-file1.ts',
          path: `${rootPath}/mock-file1.ts`,
          type: 'file' as const,
          size: 100,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'mock-file1.ts',
            path: `${rootPath}/mock-file1.ts`,
            platform: 'electron' as const,
          },
        },
        {
          name: 'src',
          path: `${rootPath}/src`,
          type: 'directory' as const,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          children: [],
          handle: {
            kind: 'directory' as const,
            name: 'src',
            path: `${rootPath}/src`,
            platform: 'electron' as const,
          },
        },
      ],
      [`${rootPath}/src`]: [
        {
          name: 'index.ts',
          path: `${rootPath}/src/index.ts`,
          type: 'file' as const,
          size: 120,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'index.ts',
            path: `${rootPath}/src/index.ts`,
            platform: 'electron' as const,
          },
        },
        {
          name: 'extra.ts',
          path: `${rootPath}/src/extra.ts`,
          type: 'file' as const,
          size: 140,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'extra.ts',
            path: `${rootPath}/src/extra.ts`,
            platform: 'electron' as const,
          },
        },
      ],
    },
    fileContentsByPath: {
      [`${rootPath}/mock-file1.ts`]: 'export const rootValue = 1;',
      [`${rootPath}/src/index.ts`]: 'export const value = 1;',
      [`${rootPath}/src/extra.ts`]: 'export const extra = 2;',
    },
    readDirectoryCalls: [],
    readFileByPathCalls: [],
    readFileCalls: [],
    requestDirectoryAccessCount: 0,
    rootHandle: {
      id: 'mock-directory-handle',
      kind: 'directory',
      name: 'mock-desktop-selection-root',
      path: rootPath,
      platform: 'electron',
      type: 'directory',
    },
  };

  await electronApp.evaluate((_electron, nextFixture) => {
    (
      globalThis as typeof globalThis & {
        __brainstrike_e2e_file_system_fixture__?: ElectronE2eFileSystemFixture | undefined;
      }
    ).__brainstrike_e2e_file_system_fixture__ = nextFixture;
  }, fixture);
}

test.describe('Desktop file explorer selection', () => {
  test('root Select All marks visible folders checked when recursive descendants are selected', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    await installNestedFolderFixture(electronApp.app, '/mock/desktop-selection-root-full');
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('src')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('mock-file1.ts')).toBeVisible({ timeout: 15_000 });

    const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
    const rootFileCheckbox = fileTree.getByRole('checkbox', { name: 'Select mock-file1.ts' });

    await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(rootFileCheckbox).not.toBeChecked();

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ timeout: 5000 });

    await expect(window.getByRole('button', { name: /^Deselect All$/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(rootFileCheckbox).toBeChecked();
    await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
  });

  test('root capped Select All marks visible folders indeterminate when only some descendants are selected', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    await installNestedFolderFixture(electronApp.app, '/mock/desktop-selection-root-capped');
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('src')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('mock-file1.ts')).toBeVisible({ timeout: 15_000 });

    await setFileExplorerMaxSelectionCount(window, 2);

    const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
    const rootFileCheckbox = fileTree.getByRole('checkbox', { name: 'Select mock-file1.ts' });
    await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(rootFileCheckbox).not.toBeChecked();

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ timeout: 5000 });

    await expect(window.getByRole('button', { name: /^Deselect All$/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(rootFileCheckbox).toBeChecked();
    await expect(srcCheckbox).toHaveAttribute('data-state', 'indeterminate');
  });
});
