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
const FILTER_PRESET_TEST_TIMEOUT_MS = 60_000;
const ELECTRON_CONTROL_CLICK_TIMEOUT_MS = 10_000;
const PRESET_DATABASE_READY_TIMEOUT_MS = 15_000;
const PRESET_PERSIST_READY_TIMEOUT_MS = 15_000;
const FILE_EXPLORER_STORAGE_KEY = 'file-explorer-storage-v4';

interface ViewFilterPresetReadinessResult {
  count: number | null;
  error: string | null;
  ok: boolean;
}

interface ElectronDatabaseBridge {
  query?: (
    sql: string,
    params?: unknown[],
    options?: { label?: string; priority?: 'foreground' | 'normal' | 'background' }
  ) => Promise<{ rows: unknown[] }>;
}

interface ElectronApiBridge {
  electronAPI?: {
    db?: ElectronDatabaseBridge;
  };
}

interface FileExplorerPersistStorage {
  getItem?: (key: string) => Promise<unknown> | unknown;
}

interface FileExplorerPersistOptions {
  name?: string;
  storage?: FileExplorerPersistStorage;
}

interface FileExplorerPersistApi {
  getOptions?: () => FileExplorerPersistOptions | undefined;
}

interface FileExplorerStoreBridge {
  getState?: () => unknown;
  persist?: FileExplorerPersistApi;
}

interface FileExplorerStoreWindow {
  __brainstrike_file_explorer_provider_store__?: FileExplorerStoreBridge;
}

interface ViewFilterPresetLookupResult {
  error: string | null;
  id: string | null;
  ok: boolean;
}

interface PersistedPresetReadinessResult {
  currentFolderId: string | null;
  error: string | null;
  folderPresetId: string | null;
  livePresetId: string | null;
  ok: boolean;
  topLevelPresetId: string | null;
}

async function clickElectronControl(locator: Locator): Promise<void> {
  await locator.click({
    noWaitAfter: true,
    timeout: ELECTRON_CONTROL_CLICK_TIMEOUT_MS,
  });
}

async function ensureLeftPanelVisible(window: Page): Promise<void> {
  const leftPanel = getContextExplorerLeftPanel(window);
  const showLeftPanelButton = window
    .getByTestId('show-explorer-panel')
    .or(window.getByRole('button', { name: /show explorer/i }));

  if (
    !(await leftPanel.isVisible().catch(() => false)) &&
    (await showLeftPanelButton.isVisible().catch(() => false))
  ) {
    await clickElectronControl(showLeftPanelButton);
  }

  await leftPanel.waitFor({ state: 'visible', timeout: 10_000 });
}

async function ensureViewFiltersExpanded(window: Page): Promise<void> {
  const toggleButton = window.getByRole('button', { name: /view filters/i });
  await expect(toggleButton).toBeVisible({ timeout: 10_000 });

  if ((await toggleButton.getAttribute('aria-expanded')) !== 'true') {
    await clickElectronControl(toggleButton);
  }

  await expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
}

async function waitForViewFilterPresetsDatabase(window: Page): Promise<void> {
  const result = await window.evaluate(
    async (timeoutMs): Promise<ViewFilterPresetReadinessResult> => {
      const api = (globalThis as typeof globalThis & ElectronApiBridge).electronAPI;
      const query = api?.db?.query;
      if (!query) {
        return {
          count: null,
          error: 'Desktop database query bridge is unavailable.',
          ok: false,
        };
      }

      const timeout = new Promise<ViewFilterPresetReadinessResult>((resolve) => {
        setTimeout(
          () =>
            resolve({
              count: null,
              error: `Timed out waiting ${timeoutMs}ms for seeded view filter presets.`,
              ok: false,
            }),
          timeoutMs
        );
      });
      const readiness = query('SELECT COUNT(*)::int AS count FROM view_filter_presets', [], {
        label: 'desktop e2e view filter preset readiness',
        priority: 'foreground',
      })
        .then((queryResult): ViewFilterPresetReadinessResult => {
          const row = queryResult.rows[0] as { count?: unknown } | undefined;
          const rawCount = row?.count;
          const count =
            typeof rawCount === 'number'
              ? rawCount
              : typeof rawCount === 'string'
                ? Number(rawCount)
                : null;
          return {
            count,
            error:
              typeof count === 'number' && count > 0
                ? null
                : `Expected seeded view filter presets, got count=${String(rawCount)}.`,
            ok: typeof count === 'number' && count > 0,
          };
        })
        .catch((error: unknown): ViewFilterPresetReadinessResult => {
          const message = error instanceof Error ? error.message : String(error);
          return { count: null, error: message, ok: false };
        });

      return await Promise.race([readiness, timeout]);
    },
    PRESET_DATABASE_READY_TIMEOUT_MS
  );

  expect(result, result.error ?? 'View filter presets were not ready.').toMatchObject({ ok: true });
}

async function resolveViewFilterPresetId(window: Page, presetName: string): Promise<string> {
  const result = await window.evaluate(async (name): Promise<ViewFilterPresetLookupResult> => {
    const api = (globalThis as typeof globalThis & ElectronApiBridge).electronAPI;
    const query = api?.db?.query;
    if (!query) {
      return {
        error: 'Desktop database query bridge is unavailable.',
        id: null,
        ok: false,
      };
    }

    try {
      const queryResult = await query(
        'SELECT id FROM view_filter_presets WHERE name = $1 LIMIT 1',
        [name],
        {
          label: 'desktop e2e view filter preset id lookup',
          priority: 'foreground',
        }
      );
      const row = queryResult.rows[0] as { id?: unknown } | undefined;
      const id = typeof row?.id === 'string' ? row.id : null;
      return {
        error: id ? null : `View filter preset "${name}" was not found.`,
        id,
        ok: Boolean(id),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message, id: null, ok: false };
    }
  }, presetName);

  expect(result, result.error ?? `View filter preset "${presetName}" was not found.`).toMatchObject(
    {
      ok: true,
    }
  );

  if (!result.id) {
    throw new Error(`View filter preset "${presetName}" did not resolve to an id.`);
  }
  return result.id;
}

async function waitForPresetSelectionPersisted(
  window: Page,
  expectedPresetId: string
): Promise<void> {
  await expect
    .poll(
      async () =>
        await window.evaluate(
          async (args): Promise<PersistedPresetReadinessResult> => {
            const asRecord = (value: unknown): Record<string, unknown> =>
              value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
            const readStringField = (
              source: Record<string, unknown>,
              key: string
            ): string | null => {
              const value = source[key];
              return typeof value === 'string' ? value : null;
            };

            const store = (globalThis as typeof globalThis & FileExplorerStoreWindow)
              .__brainstrike_file_explorer_provider_store__;
            const liveState = asRecord(store?.getState?.());
            const livePresetId = readStringField(liveState, 'viewFilterPresetId');
            const currentFolderId = readStringField(liveState, 'currentFolderId');
            const persistOptions = store?.persist?.getOptions?.();
            const storage = persistOptions?.storage;

            if (!storage || typeof storage.getItem !== 'function') {
              return {
                currentFolderId,
                error: 'File explorer persist storage is unavailable.',
                folderPresetId: null,
                livePresetId,
                ok: false,
                topLevelPresetId: null,
              };
            }

            let rawValue: unknown;
            try {
              rawValue = await storage.getItem(persistOptions?.name ?? args.storageKey);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return {
                currentFolderId,
                error: message,
                folderPresetId: null,
                livePresetId,
                ok: false,
                topLevelPresetId: null,
              };
            }

            let parsedValue: unknown = rawValue;
            try {
              parsedValue =
                typeof rawValue === 'string' && rawValue.length > 0
                  ? JSON.parse(rawValue)
                  : rawValue;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return {
                currentFolderId,
                error: `Failed to parse persisted file explorer state: ${message}`,
                folderPresetId: null,
                livePresetId,
                ok: false,
                topLevelPresetId: null,
              };
            }

            const persistedEnvelope = asRecord(parsedValue);
            const persistedState = asRecord(persistedEnvelope['state'] ?? persistedEnvelope);
            const topLevelPresetId = readStringField(persistedState, 'viewFilterPresetId');
            const folderStates = asRecord(persistedState['folderStates']);
            const folderState = currentFolderId ? asRecord(folderStates[currentFolderId]) : {};
            const folderPresetId = readStringField(folderState, 'viewFilterPresetId');
            const ok =
              livePresetId === args.expectedPresetId &&
              topLevelPresetId === args.expectedPresetId &&
              folderPresetId === args.expectedPresetId;

            return {
              currentFolderId,
              error: ok
                ? null
                : `Waiting for persisted preset id ${args.expectedPresetId}; live=${String(
                    livePresetId
                  )}, topLevel=${String(topLevelPresetId)}, folder=${String(folderPresetId)}.`,
              folderPresetId,
              livePresetId,
              ok,
              topLevelPresetId,
            };
          },
          { expectedPresetId, storageKey: FILE_EXPLORER_STORAGE_KEY }
        ),
      {
        intervals: [100, 250, 500],
        timeout: PRESET_PERSIST_READY_TIMEOUT_MS,
      }
    )
    .toMatchObject({ ok: true });
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
  await clickElectronControl(selectRootButton);

  await expect(window.getByRole('button', { name: /view filters/i })).toBeVisible({
    timeout: 15_000,
  });
}

async function selectDocumentationPreset(window: Page): Promise<void> {
  await waitForViewFilterPresetsDatabase(window);

  const selectedDocumentationTrigger = getContextExplorerLeftPanel(window).getByRole('button', {
    name: /documentation/i,
  });
  if (await selectedDocumentationTrigger.isVisible().catch(() => false)) {
    await expect(window.getByText('Select filter...')).toBeHidden({ timeout: 10_000 });
    return;
  }

  await selectPresetBySearch(window, 'Documentation', /documentation/i);
}

async function selectPresetBySearch(
  window: Page,
  searchText: string,
  selectedName: RegExp
): Promise<void> {
  const presetTrigger = await resolvePresetTrigger(window);
  await presetTrigger.focus();
  await window.keyboard.press('Enter');

  await expect(window.getByText('Loading presets...')).toBeHidden({
    timeout: PRESET_LOAD_TIMEOUT_MS,
  });

  const presetSearchInput = window.getByRole('textbox', { name: /filter presets/i });
  await expect(presetSearchInput).toBeVisible({ timeout: 10_000 });
  await presetSearchInput.fill(searchText);
  await expect(window.getByRole('button', { name: selectedName }).first()).toBeVisible({
    timeout: 10_000,
  });
  await presetSearchInput.press('Enter');

  await expect(presetSearchInput).toBeHidden({ timeout: 10_000 });
  await expect(
    getContextExplorerLeftPanel(window).getByRole('button', { name: selectedName })
  ).toBeVisible({
    timeout: 10_000,
  });
  await expect(window.getByText('Select filter...')).toBeHidden({ timeout: 10_000 });
}

async function switchPreset(window: Page, currentName: RegExp, nextName: RegExp): Promise<void> {
  const presetTrigger = getContextExplorerLeftPanel(window).getByRole('button', {
    name: currentName,
  });
  await expect(presetTrigger).toBeVisible({ timeout: 10_000 });
  await selectPresetBySearch(window, 'TypeScript', nextName);
}

test.describe('Desktop filter presets', () => {
  test.beforeEach(async ({ window }) => {
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
  });

  test('updates the toolbar label when a preset is selected', async ({ window }) => {
    test.setTimeout(FILTER_PRESET_TEST_TIMEOUT_MS);

    await ensureLeftPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);
    await selectDocumentationPreset(window);
  });

  test('keeps the preset trigger enabled when view filters first appear', async ({ window }) => {
    test.setTimeout(FILTER_PRESET_TEST_TIMEOUT_MS);

    await ensureLeftPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);

    await resolvePresetTrigger(window);
  });

  test('loads presets without getting stuck on the loading state', async ({ window }) => {
    test.setTimeout(FILTER_PRESET_TEST_TIMEOUT_MS);

    await ensureLeftPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);

    await waitForViewFilterPresetsDatabase(window);
    const presetTrigger = await resolvePresetTrigger(window);
    await clickElectronControl(presetTrigger);

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
    const documentationPresetId = await resolveViewFilterPresetId(window, 'Documentation');
    await waitForPresetSelectionPersisted(window, documentationPresetId);

    const relaunched = await electron.restart();
    const relaunchedWindow = relaunched.window;
    const { mockFileSystemOperations, waitForAppReady } = await loadElectronHelpers();
    await waitForAppReady(relaunchedWindow);
    await mockFileSystemOperations(relaunchedWindow);
    await ensureLeftPanelVisible(relaunchedWindow);

    const viewFiltersButton = relaunchedWindow.getByRole('button', { name: /view filters/i });
    if (!(await viewFiltersButton.isVisible().catch(() => false))) {
      await selectMockRoot(relaunchedWindow);
    }

    await ensureViewFiltersExpanded(relaunchedWindow);
    await waitForViewFilterPresetsDatabase(relaunchedWindow);
    await expect(
      getContextExplorerLeftPanel(relaunchedWindow).getByRole('button', { name: /documentation/i })
    ).toBeVisible({ timeout: 10_000 });
    await expect(relaunchedWindow.getByText('Select filter...')).toBeHidden({ timeout: 10_000 });
  });

  test('switches to a different preset without snapping back to the previous selection', async ({
    window,
  }) => {
    test.setTimeout(FILTER_PRESET_TEST_TIMEOUT_MS);

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
    test.setTimeout(FILTER_PRESET_TEST_TIMEOUT_MS);

    await installFilteredEmptyFolderFixture(electronApp.app, '/mock/filter-empty-folder-root');
    await ensureLeftPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);

    await selectPresetBySearch(window, 'TypeScript', /typescript\/javascript/i);

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree.getByText('apps')).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('packages')).toBeVisible({ timeout: 10_000 });

    const expandButtons = fileTree.locator('button[aria-label="Expand"]');
    await expect(expandButtons).toHaveCount(2, { timeout: 10_000 });
    await clickElectronControl(expandButtons.first());

    await expect(fileTree.getByText('docs')).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('web')).toBeVisible({ timeout: 10_000 });

    const docsRow = fileTree.getByRole('row', { name: /docs/i });
    const webRow = fileTree.getByRole('row', { name: /web/i });
    await expect(docsRow).toBeVisible();
    await expect(webRow).toBeVisible();

    await clickElectronControl(docsRow.getByRole('button', { name: 'Expand' }));

    await expect(docsRow).toBeVisible({ timeout: 10_000 });
    await expect(webRow).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('readme.md')).not.toBeVisible();
  });

  test('expand all does not leave filtered empty folders stuck in a loading state', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(FILTER_PRESET_TEST_TIMEOUT_MS);

    await installFilteredEmptyFolderFixture(electronApp.app, '/mock/filter-empty-folder-root');
    await ensureLeftPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);

    await selectPresetBySearch(window, 'TypeScript', /typescript\/javascript/i);

    const expandAllButton = window.getByTestId('expand-all-button-small');
    await expect(expandAllButton).toBeVisible({ timeout: 10_000 });
    await clickElectronControl(expandAllButton);

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
