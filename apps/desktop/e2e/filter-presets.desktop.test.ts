import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { getContextExplorerLeftPanel } from './utils/context-explorer-locators';
import { loadElectronHelpers } from './utils/load-electron-helpers';

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

const PRESET_LOAD_TIMEOUT_MS = 25_000;

async function ensureLeftPanelVisible(window: Page): Promise<void> {
  const leftPanel = getContextExplorerLeftPanel(window);
  const showLeftPanelButton = window
    .getByTestId('show-explorer-panel')
    .or(window.getByRole('button', { name: /show explorer/i }));

  if (
    !(await leftPanel.isVisible().catch(() => false)) &&
    (await showLeftPanelButton.isVisible().catch(() => false))
  ) {
    await showLeftPanelButton.click();
  }

  await leftPanel.waitFor({ state: 'visible', timeout: 10_000 });
}

async function ensureViewFiltersExpanded(window: Page): Promise<void> {
  const toggleButton = window.getByRole('button', { name: /view filters/i });
  await expect(toggleButton).toBeVisible({ timeout: 10_000 });

  if ((await toggleButton.getAttribute('aria-expanded')) !== 'true') {
    await toggleButton.click();
  }

  await expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
}

async function resolvePresetTrigger(window: Page): Promise<Locator> {
  const explorerPanel = getContextExplorerLeftPanel(window);
  const presetTrigger = explorerPanel
    .locator('button')
    .filter({ hasText: /select filter|source files|documentation|typescript\/javascript/i })
    .first();
  await expect(presetTrigger).toBeVisible({ timeout: 10_000 });
  await expect(presetTrigger).toBeEnabled({ timeout: 10_000 });
  return presetTrigger;
}

async function installFilteredEmptyFolderFixture(
  electronApp: ElectronApplication,
  rootPath: string
): Promise<void> {
  const fixture: ElectronE2eFileSystemFixture = {
    directoriesByPath: {
      [rootPath]: [
        {
          name: 'apps',
          path: `${rootPath}/apps`,
          type: 'directory' as const,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          children: [],
          handle: {
            kind: 'directory' as const,
            name: 'apps',
            path: `${rootPath}/apps`,
            platform: 'electron' as const,
          },
        },
        {
          name: 'packages',
          path: `${rootPath}/packages`,
          type: 'directory' as const,
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
      [`${rootPath}/apps`]: [
        {
          name: 'docs',
          path: `${rootPath}/apps/docs`,
          type: 'directory' as const,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          children: [],
          handle: {
            kind: 'directory' as const,
            name: 'docs',
            path: `${rootPath}/apps/docs`,
            platform: 'electron' as const,
          },
        },
        {
          name: 'web',
          path: `${rootPath}/apps/web`,
          type: 'directory' as const,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          children: [],
          handle: {
            kind: 'directory' as const,
            name: 'web',
            path: `${rootPath}/apps/web`,
            platform: 'electron' as const,
          },
        },
      ],
      [`${rootPath}/apps/docs`]: [
        {
          name: 'readme.md',
          path: `${rootPath}/apps/docs/readme.md`,
          type: 'file' as const,
          size: 100,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'readme.md',
            path: `${rootPath}/apps/docs/readme.md`,
            platform: 'electron' as const,
          },
        },
      ],
      [`${rootPath}/apps/web`]: [
        {
          name: 'app.ts',
          path: `${rootPath}/apps/web/app.ts`,
          type: 'file' as const,
          size: 120,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'app.ts',
            path: `${rootPath}/apps/web/app.ts`,
            platform: 'electron' as const,
          },
        },
      ],
      [`${rootPath}/packages`]: [
        {
          name: 'core.ts',
          path: `${rootPath}/packages/core.ts`,
          type: 'file' as const,
          size: 80,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'core.ts',
            path: `${rootPath}/packages/core.ts`,
            platform: 'electron' as const,
          },
        },
      ],
    },
    fileContentsByPath: {
      [`${rootPath}/apps/docs/readme.md`]: '# docs',
      [`${rootPath}/apps/web/app.ts`]: 'export const app = 1;',
      [`${rootPath}/packages/core.ts`]: 'export const core = 1;',
    },
    readDirectoryCalls: [],
    readFileByPathCalls: [],
    readFileCalls: [],
    requestDirectoryAccessCount: 0,
    rootHandle: {
      id: 'mock-filter-empty-folder-root',
      kind: 'directory',
      name: 'mock-filter-empty-folder-root',
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

async function selectMockRoot(window: Page): Promise<void> {
  const selectRootButton = window.getByRole('button', { name: /select root/i }).first();
  await expect(selectRootButton).toBeVisible({ timeout: 10_000 });
  await selectRootButton.click();

  await expect(window.getByRole('button', { name: /view filters/i })).toBeVisible({
    timeout: 15_000,
  });
}

async function selectDocumentationPreset(window: Page): Promise<void> {
  const selectedDocumentationTrigger = getContextExplorerLeftPanel(window).getByRole('button', {
    name: /documentation/i,
  });
  if (await selectedDocumentationTrigger.isVisible().catch(() => false)) {
    await expect(window.getByText('Select filter...')).toBeHidden({ timeout: 10_000 });
    return;
  }

  const presetTrigger = await resolvePresetTrigger(window);
  await presetTrigger.click();

  await expect(window.getByText('Loading presets...')).toBeHidden({
    timeout: PRESET_LOAD_TIMEOUT_MS,
  });

  const documentationOption = window.getByRole('button', { name: /documentation/i }).first();
  await expect(documentationOption).toBeVisible({ timeout: 10_000 });
  await documentationOption.click();

  await expect(window.getByRole('button', { name: /documentation/i })).toBeVisible({
    timeout: 10_000,
  });
  await expect(window.getByText('Select filter...')).toBeHidden({ timeout: 10_000 });
}

async function switchPreset(window: Page, currentName: RegExp, nextName: RegExp): Promise<void> {
  const presetTrigger = getContextExplorerLeftPanel(window).getByRole('button', {
    name: currentName,
  });
  await expect(presetTrigger).toBeVisible({ timeout: 10_000 });
  await presetTrigger.click();

  const nextOption = window.getByRole('button', { name: nextName }).first();
  await expect(nextOption).toBeVisible({ timeout: 10_000 });
  await nextOption.click();

  await expect(window.getByRole('button', { name: nextName })).toBeVisible({ timeout: 10_000 });
}

test.describe('Desktop filter presets', () => {
  test.beforeEach(async ({ window }) => {
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
  });

  test('updates the toolbar label when a preset is selected', async ({ window }) => {
    test.setTimeout(45_000);

    await ensureLeftPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);
    await selectDocumentationPreset(window);
  });

  test('keeps the preset trigger enabled when view filters first appear', async ({ window }) => {
    test.setTimeout(45_000);

    await ensureLeftPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);

    await resolvePresetTrigger(window);
  });

  test('loads presets without getting stuck on the loading state', async ({ window }) => {
    test.setTimeout(45_000);

    await ensureLeftPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);

    const presetTrigger = await resolvePresetTrigger(window);
    await presetTrigger.click();

    await expect(window.getByText('Loading presets...')).toBeHidden({
      timeout: PRESET_LOAD_TIMEOUT_MS,
    });
    await expect(window.getByRole('button', { name: /documentation/i }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('keeps the selected preset after app restart', async ({ electron, window }) => {
    test.setTimeout(90_000);

    await ensureLeftPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);
    await selectDocumentationPreset(window);

    const relaunched = await electron.restart();
    const relaunchedWindow = relaunched.window;
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(relaunchedWindow);
    await ensureLeftPanelVisible(relaunchedWindow);

    const viewFiltersButton = relaunchedWindow.getByRole('button', { name: /view filters/i });
    if (!(await viewFiltersButton.isVisible().catch(() => false))) {
      await selectMockRoot(relaunchedWindow);
    }

    await ensureViewFiltersExpanded(relaunchedWindow);
    await expect(relaunchedWindow.getByRole('button', { name: /documentation/i })).toBeVisible({
      timeout: 10_000,
    });
    await expect(relaunchedWindow.getByText('Select filter...')).toBeHidden({ timeout: 10_000 });
  });

  test('switches to a different preset without snapping back to the previous selection', async ({
    window,
  }) => {
    test.setTimeout(60_000);

    await ensureLeftPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);
    await selectDocumentationPreset(window);
    await switchPreset(window, /documentation/i, /typescript\/javascript/i);

    await expect(window.getByText('Documentation')).toBeHidden({ timeout: 10_000 });
    await expect(window.getByRole('button', { name: /typescript\/javascript/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('keeps an expanded folder visible when it has no matching children under the preset filter', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(60_000);

    await installFilteredEmptyFolderFixture(electronApp.app, '/mock/filter-empty-folder-root');
    await ensureLeftPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);

    const presetTrigger = await resolvePresetTrigger(window);
    await presetTrigger.click();
    await expect(window.getByText('Loading presets...')).toBeHidden({
      timeout: PRESET_LOAD_TIMEOUT_MS,
    });

    const tsPresetOption = window.getByRole('button', { name: /typescript\/javascript/i }).first();
    await expect(tsPresetOption).toBeVisible({ timeout: 10_000 });
    await tsPresetOption.click();

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree.getByText('apps')).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('packages')).toBeVisible({ timeout: 10_000 });

    const expandButtons = fileTree.locator('button[aria-label="Expand"]');
    await expect(expandButtons).toHaveCount(2, { timeout: 10_000 });
    await expandButtons.first().click({ timeout: 5000 });

    await expect(fileTree.getByText('docs')).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('web')).toBeVisible({ timeout: 10_000 });

    const docsRow = fileTree.getByRole('row', { name: /docs/i });
    const webRow = fileTree.getByRole('row', { name: /web/i });
    await expect(docsRow).toBeVisible();
    await expect(webRow).toBeVisible();

    await docsRow.getByRole('button', { name: 'Expand' }).click({ timeout: 5000 });

    await expect(docsRow).toBeVisible({ timeout: 10_000 });
    await expect(webRow).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('readme.md')).not.toBeVisible();
  });

  test('expand all does not leave filtered empty folders stuck in a loading state', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(60_000);

    await installFilteredEmptyFolderFixture(electronApp.app, '/mock/filter-empty-folder-root');
    await ensureLeftPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);

    const presetTrigger = await resolvePresetTrigger(window);
    await presetTrigger.click();
    await expect(window.getByText('Loading presets...')).toBeHidden({
      timeout: PRESET_LOAD_TIMEOUT_MS,
    });

    const tsPresetOption = window.getByRole('button', { name: /typescript\/javascript/i }).first();
    await expect(tsPresetOption).toBeVisible({ timeout: 10_000 });
    await tsPresetOption.click();

    const expandAllButton = window.getByTestId('expand-all-button-small');
    await expect(expandAllButton).toBeVisible({ timeout: 10_000 });
    await expandAllButton.click();

    await expect(window.getByTestId('inline-scanning-indicator')).not.toBeVisible({
      timeout: 20_000,
    });
    await expect(expandAllButton).toBeEnabled({ timeout: 10_000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree.getByText('apps')).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('packages')).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('docs')).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('web')).toBeVisible({ timeout: 10_000 });

    await expect(
      fileTree.locator(
        'button[disabled][aria-label="Expand"], button[disabled][aria-label="Collapse"]'
      )
    ).toHaveCount(0);
  });
});
