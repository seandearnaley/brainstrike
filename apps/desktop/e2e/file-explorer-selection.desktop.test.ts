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

async function installNestedPackagesFixture(
  electronApp: ElectronApplication,
  rootPath: string
): Promise<void> {
  const fixture: ElectronE2eFileSystemFixture = {
    directoriesByPath: {
      [rootPath]: [
        {
          name: 'docs',
          path: `${rootPath}/docs`,
          type: 'directory' as const,
          size: 0,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          children: [],
          handle: {
            kind: 'directory' as const,
            name: 'docs',
            path: `${rootPath}/docs`,
            platform: 'electron' as const,
          },
        },
        {
          name: 'packages',
          path: `${rootPath}/packages`,
          type: 'directory' as const,
          size: 0,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          children: [],
          handle: {
            kind: 'directory' as const,
            name: 'packages',
            path: `${rootPath}/packages`,
            platform: 'electron' as const,
          },
        },
      ],
      [`${rootPath}/docs`]: [
        {
          name: 'readme.md',
          path: `${rootPath}/docs/readme.md`,
          type: 'file' as const,
          size: 50,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'readme.md',
            path: `${rootPath}/docs/readme.md`,
            platform: 'electron' as const,
          },
        },
      ],
      [`${rootPath}/packages`]: [
        {
          name: 'agent',
          path: `${rootPath}/packages/agent`,
          type: 'directory' as const,
          size: 0,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          children: [],
          handle: {
            kind: 'directory' as const,
            name: 'agent',
            path: `${rootPath}/packages/agent`,
            platform: 'electron' as const,
          },
        },
        {
          name: 'app-shell',
          path: `${rootPath}/packages/app-shell`,
          type: 'directory' as const,
          size: 0,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          children: [],
          handle: {
            kind: 'directory' as const,
            name: 'app-shell',
            path: `${rootPath}/packages/app-shell`,
            platform: 'electron' as const,
          },
        },
      ],
      [`${rootPath}/packages/agent`]: [
        {
          name: 'index.ts',
          path: `${rootPath}/packages/agent/index.ts`,
          type: 'file' as const,
          size: 100,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'index.ts',
            path: `${rootPath}/packages/agent/index.ts`,
            platform: 'electron' as const,
          },
        },
      ],
      [`${rootPath}/packages/app-shell`]: [
        {
          name: 'main.ts',
          path: `${rootPath}/packages/app-shell/main.ts`,
          type: 'file' as const,
          size: 120,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'main.ts',
            path: `${rootPath}/packages/app-shell/main.ts`,
            platform: 'electron' as const,
          },
        },
      ],
    },
    fileContentsByPath: {
      [`${rootPath}/docs/readme.md`]: '# docs',
      [`${rootPath}/packages/agent/index.ts`]: 'export const agent = 1;',
      [`${rootPath}/packages/app-shell/main.ts`]: 'export const appShell = 1;',
    },
    readDirectoryCalls: [],
    readFileByPathCalls: [],
    readFileCalls: [],
    requestDirectoryAccessCount: 0,
    rootHandle: {
      id: 'mock-directory-handle-packages',
      kind: 'directory',
      name: 'mock-desktop-selection-packages-root',
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

async function installIncrementalFolderSelectionFixture(
  electronApp: ElectronApplication,
  rootPath: string
): Promise<void> {
  const fixture: ElectronE2eFileSystemFixture = {
    directoriesByPath: {
      [rootPath]: [
        {
          name: 'e2e',
          path: `${rootPath}/e2e`,
          type: 'directory' as const,
          size: 0,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          children: [],
          handle: {
            kind: 'directory' as const,
            name: 'e2e',
            path: `${rootPath}/e2e`,
            platform: 'electron' as const,
          },
        },
      ],
      [`${rootPath}/e2e`]: [
        {
          name: 'page-objects',
          path: `${rootPath}/e2e/page-objects`,
          type: 'directory' as const,
          size: 0,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          children: [],
          handle: {
            kind: 'directory' as const,
            name: 'page-objects',
            path: `${rootPath}/e2e/page-objects`,
            platform: 'electron' as const,
          },
        },
        {
          name: 'types',
          path: `${rootPath}/e2e/types`,
          type: 'directory' as const,
          size: 0,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          children: [],
          handle: {
            kind: 'directory' as const,
            name: 'types',
            path: `${rootPath}/e2e/types`,
            platform: 'electron' as const,
          },
        },
        {
          name: 'utils',
          path: `${rootPath}/e2e/utils`,
          type: 'directory' as const,
          size: 0,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          children: [],
          handle: {
            kind: 'directory' as const,
            name: 'utils',
            path: `${rootPath}/e2e/utils`,
            platform: 'electron' as const,
          },
        },
      ],
      [`${rootPath}/e2e/page-objects`]: [
        {
          name: 'file-explorer-page.ts',
          path: `${rootPath}/e2e/page-objects/file-explorer-page.ts`,
          type: 'file' as const,
          size: 100,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'file-explorer-page.ts',
            path: `${rootPath}/e2e/page-objects/file-explorer-page.ts`,
            platform: 'electron' as const,
          },
        },
        {
          name: 'home-page.ts',
          path: `${rootPath}/e2e/page-objects/home-page.ts`,
          type: 'file' as const,
          size: 120,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'home-page.ts',
            path: `${rootPath}/e2e/page-objects/home-page.ts`,
            platform: 'electron' as const,
          },
        },
      ],
      [`${rootPath}/e2e/types`]: [
        {
          name: 'performance.ts',
          path: `${rootPath}/e2e/types/performance.ts`,
          type: 'file' as const,
          size: 80,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'performance.ts',
            path: `${rootPath}/e2e/types/performance.ts`,
            platform: 'electron' as const,
          },
        },
      ],
      [`${rootPath}/e2e/utils`]: [
        {
          name: 'layout-helpers.ts',
          path: `${rootPath}/e2e/utils/layout-helpers.ts`,
          type: 'file' as const,
          size: 90,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'layout-helpers.ts',
            path: `${rootPath}/e2e/utils/layout-helpers.ts`,
            platform: 'electron' as const,
          },
        },
        {
          name: 'performance-helpers.ts',
          path: `${rootPath}/e2e/utils/performance-helpers.ts`,
          type: 'file' as const,
          size: 90,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'performance-helpers.ts',
            path: `${rootPath}/e2e/utils/performance-helpers.ts`,
            platform: 'electron' as const,
          },
        },
      ],
    },
    fileContentsByPath: {
      [`${rootPath}/e2e/page-objects/file-explorer-page.ts`]: 'export const fileExplorerPage = 1;',
      [`${rootPath}/e2e/page-objects/home-page.ts`]: 'export const homePage = 1;',
      [`${rootPath}/e2e/types/performance.ts`]: 'export const performance = 1;',
      [`${rootPath}/e2e/utils/layout-helpers.ts`]: 'export const layoutHelpers = 1;',
      [`${rootPath}/e2e/utils/performance-helpers.ts`]: 'export const performanceHelpers = 1;',
    },
    readDirectoryCalls: [],
    readFileByPathCalls: [],
    readFileCalls: [],
    requestDirectoryAccessCount: 0,
    rootHandle: {
      id: 'mock-directory-handle-e2e',
      kind: 'directory',
      name: 'mock-desktop-selection-e2e-root',
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

  test('selection limit toast auto-dismisses and does not leave the desktop explorer unusable', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    await installNestedFolderFixture(electronApp.app, '/mock/desktop-selection-root-limit-toast');
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await setFileExplorerMaxSelectionCount(window, 2);

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ timeout: 5000 });

    const limitToast = window
      .getByText('Cannot select more files. Maximum selection limit reached.', { exact: true })
      .first();
    await expect(limitToast).toBeVisible({ timeout: 15_000 });
    await expect(limitToast).not.toBeVisible({ timeout: 10_000 });

    const deselectAllButton = window.getByRole('button', { name: /^Deselect All$/i }).first();
    await expect(deselectAllButton).toBeEnabled({ timeout: 15_000 });
    await deselectAllButton.click({ timeout: 5000 });

    await expect(
      fileTree.getByRole('checkbox', { name: 'Select mock-file1.ts' })
    ).not.toBeChecked();
    await expect(fileTree.getByRole('checkbox', { name: 'Select src' })).toHaveAttribute(
      'data-state',
      'unchecked'
    );
  });

  test('expanding a selected parent via the chevron keeps the parent indeterminate until child subtrees load on desktop', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    await installNestedPackagesFixture(electronApp.app, '/mock/desktop-selection-root-packages');
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('packages')).toBeVisible({ timeout: 15_000 });

    const packagesCheckbox = fileTree.getByRole('checkbox', { name: 'Select packages' });
    await expect(packagesCheckbox).toHaveAttribute('data-state', 'unchecked');

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ timeout: 5000 });

    await expect(window.getByRole('button', { name: /^Deselect All$/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(packagesCheckbox).toHaveAttribute('data-state', 'indeterminate');

    const expandButtons = window.locator('button[aria-label="Expand"]');
    await expect(expandButtons).toHaveCount(2, { timeout: 15_000 });
    await expandButtons.nth(1).click({ timeout: 5000 });

    await expect(fileTree.getByText('agent')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('app-shell')).toBeVisible({ timeout: 15_000 });
    await expect(packagesCheckbox).toHaveAttribute('data-state', 'indeterminate');
    await expect(fileTree.getByRole('checkbox', { name: 'Select agent' })).toHaveAttribute(
      'data-state',
      'indeterminate'
    );
    await expect(fileTree.getByRole('checkbox', { name: 'Select app-shell' })).toHaveAttribute(
      'data-state',
      'indeterminate'
    );
  });

  test('clicking a selected folder checkbox deselects it instead of re-running recursive selection', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    await installNestedPackagesFixture(electronApp.app, '/mock/desktop-selection-root-toggle');
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ timeout: 5000 });

    const packagesCheckbox = fileTree.getByRole('checkbox', { name: 'Select packages' });
    await expect(packagesCheckbox).not.toHaveAttribute('data-state', 'unchecked');

    const expandButtons = window.locator('button[aria-label="Expand"]');
    await expect(expandButtons).toHaveCount(2, { timeout: 15_000 });
    await expandButtons.nth(1).click({ timeout: 5000 });

    await expect(fileTree.getByText('agent')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('app-shell')).toBeVisible({ timeout: 15_000 });

    await packagesCheckbox.click({ timeout: 5000 });

    await expect(packagesCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(fileTree.getByRole('checkbox', { name: 'Select agent' })).toHaveAttribute(
      'data-state',
      'unchecked'
    );
    await expect(fileTree.getByRole('checkbox', { name: 'Select app-shell' })).toHaveAttribute(
      'data-state',
      'unchecked'
    );
  });

  test('promotes a parent folder from indeterminate to checked as child folders are selected one by one', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    const rootPath = '/mock/desktop-selection-root-e2e';
    await installIncrementalFolderSelectionFixture(electronApp.app, rootPath);
    await ensureLeftPanelVisible(window);
    await setFileExplorerMaxSelectionCount(window, 10);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });

    const e2eCheckbox = fileTree.getByRole('checkbox', { name: 'Select e2e' });
    await expect(e2eCheckbox).toHaveAttribute('data-state', 'unchecked');

    const expandButtons = window.locator('button[aria-label="Expand"]');
    await expect(expandButtons).toHaveCount(1, { timeout: 15_000 });
    await expandButtons.first().click({ timeout: 5000 });

    await expect(fileTree.getByText('page-objects')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('types')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('utils')).toBeVisible({ timeout: 15_000 });

    const pageObjectsCheckbox = fileTree.getByRole('checkbox', { name: 'Select page-objects' });
    const typesCheckbox = fileTree.getByRole('checkbox', { name: 'Select types' });
    const utilsCheckbox = fileTree.getByRole('checkbox', { name: 'Select utils' });

    await pageObjectsCheckbox.click({ timeout: 5000 });
    await expect(window.getByText('2/10')).toBeVisible({ timeout: 15_000 });
    await expect(e2eCheckbox).toHaveAttribute('data-state', 'indeterminate');

    await typesCheckbox.click({ timeout: 5000 });
    await expect(window.getByText('3/10')).toBeVisible({ timeout: 15_000 });
    await expect(e2eCheckbox).toHaveAttribute('data-state', 'indeterminate');

    await utilsCheckbox.click({ timeout: 5000 });
    await expect(window.getByText('5/10')).toBeVisible({ timeout: 15_000 });
    await expect(e2eCheckbox).toHaveAttribute('data-state', 'checked');
  });
});
