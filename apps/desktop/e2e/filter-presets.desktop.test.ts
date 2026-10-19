import { FILE_EXPLORER_STORAGE_KEY } from '@brainstrike/file-explorer/testing';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import {
  clickExplorerTreeAction,
  expectExplorerTreeActionsReachable,
} from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { getContextExplorerFileExplorerPanel } from './utils/context-explorer-locators';
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
const PRESET_CATALOG_REQUEST_ATTEMPT_TIMEOUT_MS = 5000;
const PRESET_CATALOG_READY_TIMEOUT_MS = 45_000;
const PRESET_PERSIST_READY_TIMEOUT_MS = 15_000;
const VIEW_FILTERS_MOUNT_TIMEOUT_MS = 15_000;
/**
 * Generous on purpose: below 236px the compact menu is the only route to the
 * view filters, and it yields the narrow track for the whole of a cold initial
 * scan or a refresh, so the wait spans an operation rather than a render.
 */
const EXPLORER_ACTION_SURFACE_TIMEOUT_MS = 20_000;

interface ViewFilterPresetReadinessResult {
  count: number | null;
  error: string | null;
  ok: boolean;
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

async function ensureFileExplorerPanelVisible(window: Page): Promise<void> {
  const explorerPanel = getContextExplorerFileExplorerPanel(window);
  const showExplorerPanelButton = window
    .getByTestId('show-explorer-panel')
    .or(window.getByRole('button', { name: /show explorer/i }));

  if (
    !(await explorerPanel.isVisible().catch(() => false)) &&
    (await showExplorerPanelButton.isVisible().catch(() => false))
  ) {
    await clickElectronControl(showExplorerPanelButton);
  }

  await expect(explorerPanel).toBeVisible({ timeout: 15_000 });
}

/**
 * The view-filters block itself, which mounts with the workspace root at EVERY
 * toolbar width and only toggles `inert`. The toolbar's toggle button does not:
 * below the toolbar's 236px container-query step it is `display:none` and moves
 * into the compact overflow menu, which drops it out of the accessibility tree
 * entirely (role locators then report "element(s) not found", not "hidden").
 * The desktop Explorer panel opens at its 180px minimum, so this block — not
 * the button — is the layout-independent "a root is attached" signal.
 */
function getViewFiltersContent(window: Page): Locator {
  return getContextExplorerFileExplorerPanel(window).locator('#view-filters-content');
}

/** Wide-toolbar surface: present in the accessibility tree only at >=236px. */
function getViewFiltersToggle(window: Page): Locator {
  return getContextExplorerFileExplorerPanel(window).getByRole('button', {
    name: /view filters/i,
  });
}

/** Narrow-toolbar surface: the overflow menu that hosts the same two actions. */
function getCompactExplorerActionsTrigger(window: Page): Locator {
  return getContextExplorerFileExplorerPanel(window).getByRole('button', {
    name: 'More Explorer actions',
  });
}

/**
 * Opens the compact Explorer actions menu.
 *
 * Radix portals the menu outside the toolbar, so scope the content through the
 * trigger's aria-controls relationship (published once the menu opens) instead
 * of selecting an arbitrary menu.
 *
 * The trigger is WAITED for rather than probed: the compact menu unmounts while
 * a cancellable operation runs — initial load, refresh, or an expand-all sweep —
 * so the scanning indicator's cancel can occupy the narrow track. "Absent right
 * now" therefore means "busy", not "wrong layout".
 */
async function openExplorerCompactMenu(window: Page): Promise<Locator> {
  const compactActions = getCompactExplorerActionsTrigger(window);
  await expect(compactActions).toBeVisible({ timeout: EXPLORER_ACTION_SURFACE_TIMEOUT_MS });

  const compactActionsHandle = await compactActions.elementHandle();
  if (!compactActionsHandle) {
    throw new Error('Compact Explorer actions trigger detached before opening');
  }

  await clickElectronControl(compactActions);

  // Radix publishes aria-controls from a discrete-event state update, so poll
  // rather than reading once: a slow renderer would otherwise raise a hard
  // "missing aria-controls" with no retry, in the very lane this de-flakes.
  //
  // Poll the HANDLE, never a re-query. Radix marks the rest of the page
  // aria-hidden while the menu is open, so the trigger leaves the accessibility
  // tree the moment it is clicked and `getByRole(...)` then reports
  // "element(s) not found". That is exactly why the handle is captured up front.
  await expect
    .poll(async () => await compactActionsHandle.getAttribute('aria-controls'))
    .toMatch(/\S/);

  const menuId = await compactActionsHandle.getAttribute('aria-controls');
  if (!menuId) {
    throw new Error('Compact Explorer actions trigger is missing aria-controls');
  }

  const explorerMenu = window.locator(`[id=${JSON.stringify(menuId)}]`);
  await expect(explorerMenu).toHaveAttribute('role', 'menu');
  await expect(explorerMenu).toBeVisible();
  return explorerMenu;
}

/**
 * Expands the view-filters block through whichever action surface the current
 * toolbar width exposes. Exactly one of the two must be visible; asserting that
 * first also absorbs the compact menu's unmount window, so a busy toolbar waits
 * instead of falling through to a surface that is never coming.
 */
async function ensureViewFiltersExpanded(window: Page): Promise<void> {
  // Both surfaces mount with the root, so gate on the block before probing
  // which one exists — otherwise "not rendered yet" is indistinguishable from
  // "compact layout".
  const viewFiltersContent = getViewFiltersContent(window);
  await expect(viewFiltersContent).toBeAttached({ timeout: VIEW_FILTERS_MOUNT_TIMEOUT_MS });

  const toggleButton = getViewFiltersToggle(window);
  const compactActions = getCompactExplorerActionsTrigger(window);
  await expect(toggleButton.or(compactActions).filter({ visible: true })).toHaveCount(1, {
    timeout: EXPLORER_ACTION_SURFACE_TIMEOUT_MS,
  });

  if (await toggleButton.isVisible()) {
    if ((await toggleButton.getAttribute('aria-expanded')) !== 'true') {
      await clickElectronControl(toggleButton);
    }

    await expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
  } else {
    const explorerMenu = await openExplorerCompactMenu(window);
    const showViewFilters = explorerMenu.getByRole('menuitem', { name: 'Show view filters' });

    if ((await showViewFilters.count()) > 0) {
      await clickElectronControl(showViewFilters);
    } else {
      // Already expanded — the menu only offers the inverse action. Close it
      // without toggling the block back shut.
      await expect(explorerMenu.getByRole('menuitem', { name: 'Hide view filters' })).toBeVisible();
      await window.keyboard.press('Escape');
    }

    await expect(explorerMenu).toHaveCount(0);
  }

  // The observable outcome both paths share: `inert` is the block's own
  // collapsed marker, and unlike aria-expanded it exists at every width.
  await expect(viewFiltersContent).not.toHaveAttribute('inert');
}

async function waitForViewFilterPresetsCatalog(window: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        await window.evaluate(async (timeoutMs): Promise<ViewFilterPresetReadinessResult> => {
          const capability = globalThis.window.viewFilterPresets;
          if (!capability) {
            return {
              count: null,
              error: 'View filter preset capability is unavailable.',
              ok: false,
            };
          }

          const timeout = new Promise<ViewFilterPresetReadinessResult>((resolve) => {
            setTimeout(
              () =>
                resolve({
                  count: null,
                  error: `Timed out waiting ${timeoutMs}ms for a single seeded view filter preset catalog request.`,
                  ok: false,
                }),
              timeoutMs
            );
          });
          const readiness = capability
            .request({ operation: 'list' })
            .then((result): ViewFilterPresetReadinessResult => {
              if (!result.ok) {
                return { count: null, error: result.error.message, ok: false };
              }
              const count = result.value.presets.length;
              return {
                count,
                error: count > 0 ? null : 'The current preset catalog has no seeded presets.',
                ok: count > 0,
              };
            })
            .catch((error: unknown): ViewFilterPresetReadinessResult => {
              const message = error instanceof Error ? error.message : String(error);
              return { count: null, error: message, ok: false };
            });

          return await Promise.race([readiness, timeout]);
        }, PRESET_CATALOG_REQUEST_ATTEMPT_TIMEOUT_MS),
      {
        message: 'View filter presets should be seeded before the desktop preset UI is used.',
        timeout: PRESET_CATALOG_READY_TIMEOUT_MS,
      }
    )
    .toMatchObject({ ok: true });
}

async function resolveViewFilterPresetId(window: Page, presetName: string): Promise<string> {
  const result = await window.evaluate(async (name): Promise<ViewFilterPresetLookupResult> => {
    const capability = globalThis.window.viewFilterPresets;
    if (!capability) {
      return { error: 'View filter preset capability is unavailable.', id: null, ok: false };
    }

    try {
      const result = await capability.request({ operation: 'list' });
      if (!result.ok) {
        return { error: result.error.message, id: null, ok: false };
      }
      const id = result.value.presets.find((preset) => preset.name === name)?.id ?? null;
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
            // Restart safety requires all three surfaces to agree: live store,
            // top-level persisted state, and the current folder's persisted state.
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
            const persistApi = store?.persist;
            if (typeof persistApi?.getOptions !== 'function') {
              return {
                currentFolderId,
                error: 'File explorer persist getOptions API is unavailable.',
                folderPresetId: null,
                livePresetId,
                ok: false,
                topLevelPresetId: null,
              };
            }

            const persistOptions = persistApi.getOptions();
            const storage = persistOptions?.storage;

            if (!currentFolderId) {
              return {
                currentFolderId,
                error: 'Waiting for file explorer currentFolderId before checking folder state.',
                folderPresetId: null,
                livePresetId,
                ok: false,
                topLevelPresetId: null,
              };
            }

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
            const folderState = asRecord(folderStates[currentFolderId]);
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
  const explorerPanel = getContextExplorerFileExplorerPanel(window);
  const presetTrigger = explorerPanel
    .locator('button')
    .filter({
      hasText: /custom filters|select filter|source files|documentation|typescript\/javascript/i,
    })
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
          children: [],
          depth: 0,
          handle: {
            kind: 'directory' as const,
            name: 'apps',
            path: `${rootPath}/apps`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'apps',
          path: `${rootPath}/apps`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          type: 'directory' as const,
        },
        {
          children: [],
          depth: 0,
          handle: {
            kind: 'directory' as const,
            name: 'packages',
            path: `${rootPath}/packages`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'packages',
          path: `${rootPath}/packages`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          type: 'directory' as const,
        },
      ],
      [`${rootPath}/apps`]: [
        {
          children: [],
          depth: 0,
          handle: {
            kind: 'directory' as const,
            name: 'notes',
            path: `${rootPath}/apps/notes`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'notes',
          path: `${rootPath}/apps/notes`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          type: 'directory' as const,
        },
        {
          children: [],
          depth: 0,
          handle: {
            kind: 'directory' as const,
            name: 'web',
            path: `${rootPath}/apps/web`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'web',
          path: `${rootPath}/apps/web`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          type: 'directory' as const,
        },
      ],
      [`${rootPath}/apps/notes`]: [
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'readme.md',
            path: `${rootPath}/apps/notes/readme.md`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'readme.md',
          path: `${rootPath}/apps/notes/readme.md`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 100,
          type: 'file' as const,
        },
      ],
      [`${rootPath}/apps/web`]: [
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'app.ts',
            path: `${rootPath}/apps/web/app.ts`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'app.ts',
          path: `${rootPath}/apps/web/app.ts`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 120,
          type: 'file' as const,
        },
      ],
      [`${rootPath}/packages`]: [
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'core.ts',
            path: `${rootPath}/packages/core.ts`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'core.ts',
          path: `${rootPath}/packages/core.ts`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 80,
          type: 'file' as const,
        },
      ],
    },
    fileContentsByPath: {
      [`${rootPath}/apps/notes/readme.md`]: '# notes',
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
  const selectRootButton = window
    .getByRole('button', { name: /add folder to workspace|^browse$/i })
    .first();
  await expect(selectRootButton).toBeVisible({ timeout: 10_000 });
  await clickElectronControl(selectRootButton);

  await expect(getViewFiltersContent(window)).toBeAttached({
    timeout: VIEW_FILTERS_MOUNT_TIMEOUT_MS,
  });
}

async function selectDocumentationPreset(window: Page): Promise<void> {
  await waitForViewFilterPresetsCatalog(window);

  const selectedDocumentationTrigger = getContextExplorerFileExplorerPanel(window).getByRole(
    'button',
    {
      name: /documentation/i,
    }
  );
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
    getContextExplorerFileExplorerPanel(window).getByRole('button', { name: selectedName })
  ).toBeVisible({
    timeout: 10_000,
  });
  await expect(window.getByText('Select filter...')).toBeHidden({ timeout: 10_000 });
}

async function switchPreset(window: Page, currentName: RegExp, nextName: RegExp): Promise<void> {
  const presetTrigger = getContextExplorerFileExplorerPanel(window).getByRole('button', {
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

    await ensureFileExplorerPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);
    await selectDocumentationPreset(window);
  });

  test('keeps the preset trigger enabled when view filters first appear', async ({ window }) => {
    test.setTimeout(FILTER_PRESET_TEST_TIMEOUT_MS);

    await ensureFileExplorerPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);

    await resolvePresetTrigger(window);
  });

  test('loads presets without getting stuck on the loading state', async ({ window }) => {
    test.setTimeout(FILTER_PRESET_TEST_TIMEOUT_MS);

    await ensureFileExplorerPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);

    await waitForViewFilterPresetsCatalog(window);
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
    // 120s (the config default) rather than 90s: on the restoration-failed
    // path this test serially spends the 15s restore wait, selectMockRoot's own
    // mount wait, ensureViewFiltersExpanded's 15s + 20s, and TWO 45s preset-DB
    // polls. At 90s that path reports a bare "Test timeout exceeded" instead of
    // the assertion that actually failed.
    test.setTimeout(120_000);

    await ensureFileExplorerPanelVisible(window);
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
    await ensureFileExplorerPanelVisible(relaunchedWindow);

    // Root restoration after a relaunch is async, so give it a real chance
    // before re-attaching the mock root — a point-in-time probe would almost
    // always lose the race and quietly turn this into a fresh-root test.
    //
    // Only a timeout means "no root was restored". Anything else (a crashed
    // renderer, a detached frame) is a real failure and must surface here
    // rather than be laundered into the re-attach path, where it would
    // resurface later as a confusing downstream assertion.
    const restoredRoot = await getViewFiltersContent(relaunchedWindow)
      .waitFor({ state: 'attached', timeout: VIEW_FILTERS_MOUNT_TIMEOUT_MS })
      .then(() => true)
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'TimeoutError') {
          return false;
        }
        throw error;
      });
    if (!restoredRoot) {
      await selectMockRoot(relaunchedWindow);
    }

    await ensureViewFiltersExpanded(relaunchedWindow);
    await waitForViewFilterPresetsCatalog(relaunchedWindow);
    await expect(
      getContextExplorerFileExplorerPanel(relaunchedWindow).getByRole('button', {
        name: /documentation/i,
      })
    ).toBeVisible({ timeout: 10_000 });
    await expect(relaunchedWindow.getByText('Select filter...')).toBeHidden({ timeout: 10_000 });
  });

  test('switches to a different preset without snapping back to the previous selection', async ({
    window,
  }) => {
    test.setTimeout(FILTER_PRESET_TEST_TIMEOUT_MS);

    await ensureFileExplorerPanelVisible(window);
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
    await ensureFileExplorerPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);

    await selectPresetBySearch(window, 'TypeScript', /typescript\/javascript/i);

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree.getByText('apps')).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('packages')).toBeVisible({ timeout: 10_000 });

    const expandButtons = fileTree.locator('button[aria-label="Expand"]');
    await expect(expandButtons).toHaveCount(2, { timeout: 10_000 });
    await clickElectronControl(expandButtons.first());

    await expect(fileTree.getByText('notes')).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('web')).toBeVisible({ timeout: 10_000 });

    const notesRow = fileTree.getByRole('row', { name: /notes/i });
    const webRow = fileTree.getByRole('row', { name: /web/i });
    await expect(notesRow).toBeVisible();
    await expect(webRow).toBeVisible();

    await clickElectronControl(notesRow.getByRole('button', { name: 'Expand' }));

    await expect(notesRow).toBeVisible({ timeout: 10_000 });
    await expect(webRow).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('readme.md')).not.toBeVisible();
  });

  test('expand all does not leave filtered empty folders stuck in a loading state', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(FILTER_PRESET_TEST_TIMEOUT_MS);

    await installFilteredEmptyFolderFixture(electronApp.app, '/mock/filter-empty-folder-root');
    await ensureFileExplorerPanelVisible(window);
    await selectMockRoot(window);
    await ensureViewFiltersExpanded(window);

    await selectPresetBySearch(window, 'TypeScript', /typescript\/javascript/i);

    await clickExplorerTreeAction(window, 'expand-all');

    await expect(window.getByTestId('inline-scanning-indicator')).not.toBeVisible({
      timeout: 20_000,
    });
    await expectExplorerTreeActionsReachable(window);

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree.getByText('apps')).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('packages')).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('notes')).toBeVisible({ timeout: 10_000 });
    await expect(fileTree.getByText('web')).toBeVisible({ timeout: 10_000 });

    await expect(
      fileTree.locator(
        'button[disabled][aria-label="Expand"], button[disabled][aria-label="Collapse"]'
      )
    ).toHaveCount(0);
  });
});
