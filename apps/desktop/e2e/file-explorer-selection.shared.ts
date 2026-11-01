import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildQuerySelectionFingerprint } from '@brainstrike/file-explorer';
import {
  FILE_EXPLORER_STORAGE_KEY,
  FILE_EXPLORER_STORAGE_VERSION,
  serializeState,
} from '@brainstrike/file-explorer/testing';
import type { FileExplorerState } from '@brainstrike/types';
import { createEmptySelectionModel, DEFAULT_STATE } from '@brainstrike/types';
import type { Locator, Page } from 'playwright';
import { expect, test } from './fixtures/electron-fixture';
import { getContextExplorerFileExplorerPanel } from './utils/context-explorer-locators';
import { reloadRenderer } from './utils/electron-helpers.mts';
import { seedMainLedgers } from './utils/seed-root';

export { expect, test };
// NOTE: deliberately no `loadElectronHelpers` re-export. This module documents
// that a harness-owned app must only be closed via `closeForStateSeeding()`, so
// it should not also hand callers `closeElectronApp`. Specs that genuinely need
// the helpers import './utils/load-electron-helpers' directly.

/**
 * Harness surface the seeding helpers need.
 *
 * The helpers save the Explorer snapshot in a running renderer's `localStorage`
 * (renderer-only state that only a document can write) and the root in Main's
 * ledgers, reload so the document restores both, then close the app so the
 * spec's restart reads what that document kept.
 * `closeForStateSeeding` is mandatory when an app is running: the harness
 * registers every process it launches with `ElectronProcessExitGuard`, so
 * closing a harness-owned app any other way (e.g. `closeElectronApp` directly)
 * records the exit as unexpected and fails the test before it reaches its first
 * assertion (BST-1087). With no app running it does nothing.
 */
export interface SeedableElectronHarness {
  closeForStateSeeding: () => Promise<void>;
  ensureWindow: () => Promise<Page>;
  getUserDataDir: () => string;
}

interface FileExplorerTestSnapshot {
  materializedPathCount: number;
  selectedFilePathCount: number;
  treeRootCount: number;
}

interface FileExplorerTestHooksWindow {
  __brainstrikeFileExplorerTestHooks__?: {
    getSnapshot: () => FileExplorerTestSnapshot;
  };
}

export const FILE_EXPLORER_CLICK_TIMEOUT_MS = 15_000;
const FILE_EXPLORER_SETTLE_TIMEOUT_MS = 15_000;
const FILE_EXPLORER_SETTLE_POLL_MS = 100;
const FILE_EXPLORER_SETTLE_STABLE_SAMPLES = 3;
const FILE_TREE_CHECKBOX_INTERACTION_TIMEOUT_MS = 45_000;
const MIN_PLAYWRIGHT_STEP_TIMEOUT_MS = 1000;
const RENDERER_FRAME_SETTLE_COUNT = 2;
const RENDERER_FRAME_SETTLE_TIMEOUT_MS = 5000;

export async function ensureFileExplorerPanelVisible(page: Page): Promise<void> {
  const explorerPanel = getContextExplorerFileExplorerPanel(page);
  const showExplorerPanelButton = page
    .getByTestId('show-explorer-panel')
    .or(page.getByRole('button', { name: /show explorer/iu }));

  if (
    !(await explorerPanel.isVisible().catch(() => false)) &&
    (await showExplorerPanelButton.isVisible().catch(() => false))
  ) {
    await showExplorerPanelButton.click();
  }
  // The panel is the Explorer tab's content, hidden while the Search tab is selected.
  const explorerTab = page
    .getByRole('tablist', { name: 'Explorer and search' })
    .getByRole('tab', { name: 'Explorer' });
  if (
    !(await explorerPanel.isVisible().catch(() => false)) &&
    (await explorerTab.isVisible().catch(() => false))
  ) {
    await explorerTab.click();
  }

  await expect(explorerPanel).toBeVisible({ timeout: 15_000 });
}

export async function expandDirectoryIfNeeded(args: {
  directoryName: string;
  expectedChildText: string;
  fileTree: ReturnType<Page['getByRole']>;
  page: Page;
}): Promise<void> {
  const { directoryName, expectedChildText, fileTree, page } = args;
  const childLocator = fileTree.getByText(expectedChildText);
  if (await childLocator.isVisible().catch(() => false)) {
    return;
  }

  const expandButton = page.getByRole('button', {
    name: `Expand ${directoryName} directory`,
  });
  await expect(expandButton).toBeVisible({ timeout: 15_000 });
  await clickExpandButton(expandButton);
  await expect(childLocator).toBeVisible({ timeout: 15_000 });
}

async function clickExpandButton(expandButton: Locator): Promise<void> {
  await expect(expandButton).toBeVisible({ timeout: 15_000 });
  await expandButton.click({ noWaitAfter: true, timeout: FILE_EXPLORER_CLICK_TIMEOUT_MS });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function cssString(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

export async function expandNextDirectoryIfNeeded(args: {
  directoryName: string;
  directoryPath: string;
  expectedChildText: string;
  fileTree: ReturnType<Page['getByRole']>;
}): Promise<void> {
  const { directoryName, directoryPath, expectedChildText, fileTree } = args;
  const childLocator = fileTree.getByText(expectedChildText);
  if (await childLocator.isVisible().catch(() => false)) {
    return;
  }

  const directoryRowByPath = fileTree.locator(`[data-node-id=${cssString(directoryPath)}]`).first();
  const directoryRowByName = fileTree
    .getByRole('row')
    .filter({ hasText: new RegExp(`(^|\\s)${escapeRegExp(directoryName)}(\\s|$)`, 'u') })
    .first();
  const directoryRow = (await directoryRowByPath.isVisible().catch(() => false))
    ? directoryRowByPath
    : directoryRowByName;
  const expandButton = directoryRow.getByRole('button', { name: 'Expand' }).first();
  await expect
    .poll(
      async () =>
        (await childLocator.isVisible().catch(() => false)) ||
        (await expandButton.isVisible().catch(() => false)),
      { timeout: 15_000 }
    )
    .toBe(true);

  if (await childLocator.isVisible().catch(() => false)) {
    return;
  }

  await clickExpandButton(expandButton);
  await expect(childLocator).toBeVisible({ timeout: 15_000 });
}

async function waitForRendererFrames(page: Page, timeoutMs: number): Promise<void> {
  await page.evaluate(
    ({ frameCount, timeoutMs }) =>
      new Promise<void>((resolve, reject) => {
        if (typeof window.requestAnimationFrame !== 'function') {
          reject(new Error('Missing required renderer requestAnimationFrame'));
          return;
        }

        let remainingFrames = frameCount;
        const timeoutId = window.setTimeout(() => {
          reject(new Error(`Timed out waiting for ${frameCount} renderer animation frames`));
        }, timeoutMs);

        const tick = () => {
          remainingFrames -= 1;
          if (remainingFrames <= 0) {
            window.clearTimeout(timeoutId);
            resolve();
            return;
          }
          window.requestAnimationFrame(tick);
        };

        window.requestAnimationFrame(tick);
      }),
    {
      frameCount: RENDERER_FRAME_SETTLE_COUNT,
      timeoutMs,
    }
  );
}

async function readFileExplorerSnapshot(page: Page): Promise<FileExplorerTestSnapshot> {
  return page.evaluate(() => {
    const hooks = (window as FileExplorerTestHooksWindow).__brainstrikeFileExplorerTestHooks__;
    if (!hooks?.getSnapshot) {
      throw new Error('Missing required file explorer E2E test hooks');
    }
    return hooks.getSnapshot();
  });
}

function getRemainingInteractionTimeout(args: { deadline: number; label: string }): number {
  const remainingMs = args.deadline - Date.now();
  if (remainingMs < MIN_PLAYWRIGHT_STEP_TIMEOUT_MS) {
    throw new Error(`Timed out before ${args.label}; remainingMs=${remainingMs}`);
  }
  return remainingMs;
}

export async function waitForFileExplorerSelectionIdle(args: {
  expectedSelectedCount?: number;
  page: Page;
  timeoutMs?: number;
}): Promise<void> {
  const { expectedSelectedCount, page, timeoutMs = FILE_EXPLORER_SETTLE_TIMEOUT_MS } = args;
  const deadline = Date.now() + timeoutMs;
  let previousSignature: string | null = null;
  let stableSamples = 0;
  let lastSnapshot: FileExplorerTestSnapshot | undefined;

  while (Date.now() < deadline) {
    lastSnapshot = await readFileExplorerSnapshot(page);
    const countMatches =
      typeof expectedSelectedCount !== 'number' ||
      lastSnapshot.selectedFilePathCount === expectedSelectedCount;

    if (countMatches) {
      const signature = [
        lastSnapshot.materializedPathCount,
        lastSnapshot.selectedFilePathCount,
        lastSnapshot.treeRootCount,
      ].join(':');
      stableSamples = signature === previousSignature ? stableSamples + 1 : 1;
      previousSignature = signature;

      // Three poll samples plus two RAF ticks catches the observed recursive-selection race
      // without hiding a missing hook or permanently busy renderer behind a long timeout.
      if (stableSamples >= FILE_EXPLORER_SETTLE_STABLE_SAMPLES) {
        const frameSettleTimeoutMs = Math.min(
          RENDERER_FRAME_SETTLE_TIMEOUT_MS,
          getRemainingInteractionTimeout({
            deadline,
            label: 'renderer frame settle',
          })
        );
        await waitForRendererFrames(page, frameSettleTimeoutMs);
        return;
      }
    } else {
      stableSamples = 0;
      previousSignature = null;
    }

    await page.waitForTimeout(FILE_EXPLORER_SETTLE_POLL_MS);
  }

  throw new Error(
    `Timed out waiting for file explorer selection to settle${
      typeof expectedSelectedCount === 'number' ? ` at count ${expectedSelectedCount}` : ''
    }; lastSnapshot=${JSON.stringify(lastSnapshot)}`
  );
}

export async function toggleFileTreeCheckboxAndWaitForSelection(args: {
  checkboxName: string;
  expectedCheckboxStateAfter: 'checked' | 'indeterminate' | 'unchecked';
  expectedCheckboxStateBefore?: 'checked' | 'indeterminate' | 'unchecked';
  expectedSelectedCountAfter: number;
  expectedSelectedCountBefore?: number;
  fileTree: ReturnType<Page['getByRole']>;
  page: Page;
}): Promise<void> {
  const {
    checkboxName,
    expectedCheckboxStateAfter,
    expectedCheckboxStateBefore,
    expectedSelectedCountAfter,
    expectedSelectedCountBefore,
    fileTree,
    page,
  } = args;
  const checkbox = fileTree.getByRole('checkbox', { name: `Select ${checkboxName}` });
  const deadline = Date.now() + FILE_TREE_CHECKBOX_INTERACTION_TIMEOUT_MS;

  await waitForFileExplorerSelectionIdle({
    ...(expectedSelectedCountBefore === undefined
      ? {}
      : { expectedSelectedCount: expectedSelectedCountBefore }),
    page,
    timeoutMs: getRemainingInteractionTimeout({
      deadline,
      label: `selection idle before toggling ${checkboxName}`,
    }),
  });

  if (expectedCheckboxStateBefore) {
    await expect(checkbox).toHaveAttribute('data-state', expectedCheckboxStateBefore, {
      timeout: getRemainingInteractionTimeout({
        deadline,
        label: `pre-click ${expectedCheckboxStateBefore} assertion for ${checkboxName}`,
      }),
    });
  }

  await checkbox.click({
    noWaitAfter: true,
    timeout: getRemainingInteractionTimeout({
      deadline,
      label: `clicking ${checkboxName}`,
    }),
  });

  await expect(checkbox).toHaveAttribute('data-state', expectedCheckboxStateAfter, {
    timeout: getRemainingInteractionTimeout({
      deadline,
      label: `post-click ${expectedCheckboxStateAfter} assertion for ${checkboxName}`,
    }),
  });
  await expect(page.getByTestId('selection-count')).toHaveText(String(expectedSelectedCountAfter), {
    timeout: getRemainingInteractionTimeout({
      deadline,
      label: `selection count assertion for ${checkboxName}`,
    }),
  });
  await waitForFileExplorerSelectionIdle({
    expectedSelectedCount: expectedSelectedCountAfter,
    page,
    timeoutMs: getRemainingInteractionTimeout({
      deadline,
      label: `selection idle after toggling ${checkboxName}`,
    }),
  });
}

/**
 * Whether a file is in the explorer's selection, across every root, read from
 * the explorer's own store. The Files app has no preview of the selection
 * (ADR-0021, BST-2018), so the selection itself is the observable state.
 */
export async function expectFileSelected(args: {
  fileName: string;
  page: Page;
  selected: boolean;
}): Promise<void> {
  const { fileName, page, selected } = args;
  await expect
    .poll(
      async () =>
        page.evaluate((targetFileName) => {
          const querySelectedPaths = (model: {
            materializedPaths?: Iterable<string> | null;
            queryDescriptor?: {
              excludedPaths?: readonly string[];
              includedPaths?: readonly string[];
            } | null;
          }): string[] => {
            const excluded = new Set(model.queryDescriptor?.excludedPaths ?? []);
            return [
              ...[...(model.materializedPaths ?? [])].filter((path) => !excluded.has(path)),
              ...(model.queryDescriptor?.includedPaths ?? []),
            ];
          };
          const state = (
            window as Window & {
              // biome-ignore lint/style/useNamingConvention: Renderer test hook global intentionally uses the app-owned key.
              __brainstrike_file_explorer_provider_store__?: {
                getState?: () => {
                  currentFolderId?: string | null;
                  folderStates?: Record<string, { selectedFilePaths?: Iterable<string> }>;
                  selectedFilePaths?: Iterable<string>;
                  // A Select All is a query: its files are the materialized paths.
                  selectionModel?: {
                    materializedPaths?: Iterable<string> | null;
                    mode?: string;
                    queryDescriptor?: {
                      excludedPaths?: readonly string[];
                      includedPaths?: readonly string[];
                    } | null;
                  };
                };
              };
            }
          ).__brainstrike_file_explorer_provider_store__?.getState?.();
          const keys = [
            ...(state?.selectedFilePaths ?? []),
            // The materialized cache outlives a query, so it counts only while one is
            // active, and as the store resolves it: what the query matched, less the
            // paths deselected since, plus the paths added beside it (BST-1953).
            ...(state?.selectionModel?.mode === 'query'
              ? querySelectedPaths(state.selectionModel)
              : []),
            // Only other roots' saved selections count: the focused root's saved copy is
            // refreshed when focus leaves it or the state is persisted, so it lags the live
            // selection above (BST-1953), as the sidebar's own count reads it.
            ...Object.entries(state?.folderStates ?? {}).flatMap(([folderId, folder]) =>
              folderId === state?.currentFolderId ? [] : [...(folder.selectedFilePaths ?? [])]
            ),
          ];
          return keys.some((key) => {
            const filePath = key.split('|@|').at(-1) ?? key;
            return filePath.replaceAll('\\', '/').split('/').at(-1) === targetFileName;
          });
        }, fileName),
      { timeout: 10_000 }
    )
    .toBe(selected);
}

/**
 * Fixed RootId used by every seeded selection fixture (storage v5).
 *
 * The app now keys `currentFolderId` / `folderStates` by a durable RootId UUID,
 * not by the root path. The desktop main process resolves a path to its RootId
 * via the `rootsList` storage entry (see file-system-ipc.ts `restoreRoots`), so
 * the seed functions below write a matching `rootsList` entry — the restored
 * root then carries this exact id and the seeded folder state hydrates.
 */
const E2E_ROOT_ID = 'e2e-root-00000000-0000-4000-8000-000000000001';

/** Fixed addedAt for the seeded rootsList entry — deterministic fixture data. */
const E2E_ROOT_ADDED_AT = 1_700_000_000_000;

function createBaseExplorerState(rootPath: string): FileExplorerState {
  return {
    ...DEFAULT_STATE,
    // Storage v5: identity is the RootId UUID; the path lives in rootDescriptors.
    activeRootIds: [E2E_ROOT_ID],
    currentFolderId: E2E_ROOT_ID,
    expandedDirectoryPaths: new Set<string>(),
    folderAccessOrder: [E2E_ROOT_ID],
    folderStates: {},
    isAccessLoading: false,
    querySelectionManifest: null,
    quickFilter: DEFAULT_STATE.quickFilter,
    rootDescriptors: {
      [E2E_ROOT_ID]: {
        displayName: path.basename(rootPath),
        path: rootPath,
        rootId: E2E_ROOT_ID,
      },
    },
    rootDirectoryHandle: null,
    selectedFilePaths: new Set<string>(),
  } as unknown as FileExplorerState;
}

function createRestoredExplicitSelectionSnapshot(args: {
  expandedDirectoryPaths: string[];
  rootPath: string;
  selectedFilePaths: string[];
}) {
  const { expandedDirectoryPaths, rootPath, selectedFilePaths } = args;
  // Storage v5: the folderId component of composite keys is the RootId UUID.
  const selectedCompositeKeys = selectedFilePaths.map((filePath) => `${E2E_ROOT_ID}|@|${filePath}`);
  const explicitSelectionModel = {
    ...createEmptySelectionModel(),
    explicitPaths: new Set(selectedCompositeKeys),
  };
  const state: FileExplorerState = {
    ...createBaseExplorerState(rootPath),
    currentFolderId: E2E_ROOT_ID,
    devInlineFixtureEnabled: DEFAULT_STATE.devInlineFixtureEnabled,
    excludeFilters: [...DEFAULT_STATE.excludeFilters],
    expandedDirectoryPaths: new Set(expandedDirectoryPaths),
    folderAccessOrder: [E2E_ROOT_ID],
    folderStates: {
      [E2E_ROOT_ID]: {
        excludeFilters: [...DEFAULT_STATE.excludeFilters],
        expandedDirectoryPaths: new Set(expandedDirectoryPaths),
        folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
        includeFilters: [...DEFAULT_STATE.includeFilters],
        includeProjectTree: DEFAULT_STATE.includeProjectTree,
        lastAccessed: Date.now(),
        lastActiveTab: DEFAULT_STATE.lastActiveTab,
        maxSelectionCount: DEFAULT_STATE.maxSelectionCount,
        selectedFilePaths: new Set(selectedCompositeKeys),
        selectionModel: explicitSelectionModel,
        useRegex: DEFAULT_STATE.useRegex,
        viewFilterPresetId: DEFAULT_STATE.viewFilterPresetId,
      },
    },
    folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
    includeFilters: [...DEFAULT_STATE.includeFilters],
    includeProjectTree: DEFAULT_STATE.includeProjectTree,
    isFiltersExpanded: DEFAULT_STATE.isFiltersExpanded,
    lastActiveTab: DEFAULT_STATE.lastActiveTab,
    maxSelectionCount: DEFAULT_STATE.maxSelectionCount,
    quickFilter: DEFAULT_STATE.quickFilter,
    selectedFilePaths: new Set(selectedCompositeKeys),
    selectionModel: explicitSelectionModel,
    useRegex: DEFAULT_STATE.useRegex,
    viewFilterPresetId: DEFAULT_STATE.viewFilterPresetId,
  };
  return {
    state: serializeState(state),
    version: FILE_EXPLORER_STORAGE_VERSION,
  };
}

function createRestoredQuerySelectionSnapshot(args: {
  coveredDirectoryPaths: string[];
  expandedDirectoryPaths: string[];
  excludeFilters?: string[];
  excludedPaths?: string[];
  includeFilters?: string[];
  includedPaths?: string[];
  manifestSnapshotId?: string | null;
  materializedPaths: string[];
  rootPath: string;
  selectionRootPath: string;
}) {
  const {
    coveredDirectoryPaths,
    expandedDirectoryPaths,
    excludeFilters = [...DEFAULT_STATE.excludeFilters],
    excludedPaths = [],
    includeFilters = [...DEFAULT_STATE.includeFilters],
    includedPaths = [],
    manifestSnapshotId = 'missing-snapshot-id',
    materializedPaths,
    rootPath,
    selectionRootPath,
  } = args;
  const materializedPathSet = new Set(materializedPaths);
  const uniqueSelectedPathCount = new Set([...materializedPaths, ...includedPaths]).size;
  const descriptor = {
    coveredDirectoryPaths,
    excludedPaths,
    excludeFilters,
    // Storage v5: SelectionQueryDescriptor.folderId is the RootId UUID;
    // rootPath stays an absolute path (scoping/display only — not identity).
    folderId: E2E_ROOT_ID,
    includedPaths,
    includeFilters,
    kind: 'recursive-folder' as const,
    manifestFingerprint: buildQuerySelectionFingerprint({
      excludeFilters,
      folderId: E2E_ROOT_ID,
      includeFilters,
      kind: 'recursive-folder',
      rootPath: selectionRootPath,
      useRegex: false,
    }),
    manifestSnapshotId,
    rootPath: selectionRootPath,
    totalSelectedCount: Math.max(0, uniqueSelectedPathCount - excludedPaths.length),
    useRegex: false,
  };

  const state: FileExplorerState = {
    ...createBaseExplorerState(rootPath),
    currentFolderId: E2E_ROOT_ID,
    devInlineFixtureEnabled: DEFAULT_STATE.devInlineFixtureEnabled,
    excludeFilters: [...excludeFilters],
    expandedDirectoryPaths: new Set(expandedDirectoryPaths),
    folderAccessOrder: [E2E_ROOT_ID],
    folderStates: {
      [E2E_ROOT_ID]: {
        excludeFilters: [...excludeFilters],
        expandedDirectoryPaths: new Set(expandedDirectoryPaths),
        folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
        includeFilters: [...includeFilters],
        includeProjectTree: DEFAULT_STATE.includeProjectTree,
        lastAccessed: Date.now(),
        lastActiveTab: DEFAULT_STATE.lastActiveTab,
        maxSelectionCount: DEFAULT_STATE.maxSelectionCount,
        selectedFilePaths: new Set<string>(),
        selectionModel: {
          ...createEmptySelectionModel(),
          materializedAt: new Date().toISOString(),
          materializedPaths: materializedPathSet,
          mode: 'query',
          queryDescriptor: descriptor,
        },
        useRegex: false,
        viewFilterPresetId: DEFAULT_STATE.viewFilterPresetId,
      },
    },
    folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
    includeFilters: [...includeFilters],
    includeProjectTree: DEFAULT_STATE.includeProjectTree,
    isFiltersExpanded: DEFAULT_STATE.isFiltersExpanded,
    lastActiveTab: DEFAULT_STATE.lastActiveTab,
    maxSelectionCount: DEFAULT_STATE.maxSelectionCount,
    querySelectionManifest: null,
    quickFilter: DEFAULT_STATE.quickFilter,
    selectedFilePaths: new Set<string>(),
    selectionModel: {
      ...createEmptySelectionModel(),
      materializedAt: new Date().toISOString(),
      materializedPaths: materializedPathSet,
      mode: 'query',
      queryDescriptor: descriptor,
    },
    useRegex: false,
    viewFilterPresetId: DEFAULT_STATE.viewFilterPresetId,
  };

  return {
    state: serializeState(state),
    version: FILE_EXPLORER_STORAGE_VERSION,
  };
}

/**
 * Saves the root in Main's ledgers and the Explorer snapshot in the renderer's `localStorage`,
 * reloads so the document restores both as a launch would, then closes the app for a restart.
 *
 * The running document owns the snapshot key: the reload flushes its in-memory state (ADR-0026
 * R1), so a value written behind its back is overwritten. The snapshot is therefore written by
 * an init script at the start of the replacement document, before its store hydrates.
 */
async function seedRestoredState(
  electronHarness: SeedableElectronHarness,
  rootPath: string,
  persistedState: unknown
): Promise<void> {
  const page = await electronHarness.ensureWindow();
  // Storage v5: main's restoreRoots resolves rootPath → E2E_ROOT_ID via this entry, so the
  // restored root carries the same RootId the snapshot is keyed by.
  await seedMainLedgers(page, {
    lastFolderPath: rootPath,
    rootsList: JSON.stringify([
      { addedAt: E2E_ROOT_ADDED_AT, path: rootPath, rootId: E2E_ROOT_ID },
    ]),
  });
  await page.addInitScript(
    ({ key, value }) => {
      if (window.top === window) {
        localStorage.setItem(key, value);
      }
    },
    { key: FILE_EXPLORER_STORAGE_KEY, value: JSON.stringify(persistedState) }
  );
  await reloadRenderer(page, 'file-explorer-selection: seed restored state');
  await electronHarness.closeForStateSeeding();
}

export async function seedRestoredExplicitSelectionState(args: {
  electronHarness: SeedableElectronHarness;
  expandedDirectoryPaths: string[];
  rootPath: string;
  selectedFilePaths: string[];
}): Promise<void> {
  const { electronHarness, expandedDirectoryPaths, rootPath, selectedFilePaths } = args;
  await seedRestoredState(
    electronHarness,
    rootPath,
    createRestoredExplicitSelectionSnapshot({ expandedDirectoryPaths, rootPath, selectedFilePaths })
  );
}

export async function seedRestoredQuerySelectionState(args: {
  coveredDirectoryPaths: string[];
  electronHarness: SeedableElectronHarness;
  expandedDirectoryPaths: string[];
  excludeFilters?: string[];
  excludedPaths?: string[];
  includeFilters?: string[];
  includedPaths?: string[];
  manifestSnapshotId?: string | null;
  materializedPaths: string[];
  rootPath: string;
  selectionRootPath: string;
}): Promise<void> {
  const { electronHarness, ...snapshot } = args;
  await seedRestoredState(
    electronHarness,
    snapshot.rootPath,
    createRestoredQuerySelectionSnapshot(snapshot)
  );
}

async function writeLive3dmolRestoreFixture(args: {
  filePaths: string[];
  rootPath: string;
}): Promise<void> {
  const { filePaths, rootPath } = args;
  await mkdir(rootPath, { recursive: true });

  for (const filePath of filePaths) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `export const fixture = ${JSON.stringify(path.basename(filePath))};`);
  }
}

export async function seedLive3dmolRestoreState(args: {
  electronHarness: SeedableElectronHarness;
  rootPath: string;
}): Promise<void> {
  const { rootPath } = args;
  const manifestSnapshotId = 'e9330985-3968-40d6-99ea-76f24eef3a71';
  const materializedPaths = [
    path.join(rootPath, 'src/App.tsx'),
    path.join(rootPath, 'src/main.tsx'),
    path.join(rootPath, 'src/vite-env.d.ts'),
    path.join(rootPath, 'src/hooks/use-molecule-sdf.test.ts'),
    path.join(rootPath, 'src/hooks/use-molecule-sdf.ts'),
    path.join(rootPath, 'src/hooks/use-resize-draw.ts'),
    path.join(rootPath, 'src/hooks/use-viewer.ts'),
    path.join(rootPath, 'src/types/3dmol-build.d.ts'),
    path.join(rootPath, 'src/types/molstar-viewer.d.ts'),
    path.join(rootPath, 'src/utils/3dmol-loader.ts'),
    path.join(rootPath, 'src/components/molecule-viewer.test.tsx'),
    path.join(rootPath, 'src/components/molecule-viewer.tsx'),
    path.join(rootPath, 'src/components/molstar-viewer.test.tsx'),
    path.join(rootPath, 'src/components/molstar-viewer.tsx'),
    path.join(rootPath, 'src/components/viewer-shell.tsx'),
  ];

  await writeLive3dmolRestoreFixture({ filePaths: materializedPaths, rootPath });

  await seedRestoredQuerySelectionState({
    coveredDirectoryPaths: [
      '/Users',
      '/Users/seandearnaley',
      '/Users/seandearnaley/Documents',
      '/Users/seandearnaley/Documents/GitHub',
      rootPath,
      path.join(rootPath, 'src'),
      path.join(rootPath, 'src/components'),
      path.join(rootPath, 'src/hooks'),
      path.join(rootPath, 'src/types'),
      path.join(rootPath, 'src/utils'),
    ],
    electronHarness: args.electronHarness,
    excludeFilters: [
      '.aider*',
      'node_modules',
      '.next',
      'coverage',
      'test-results',
      'playwright-report',
    ],
    expandedDirectoryPaths: [
      '/Users',
      '/Users/seandearnaley',
      '/Users/seandearnaley/Documents',
      '/Users/seandearnaley/Documents/GitHub',
      rootPath,
      path.join(rootPath, 'src'),
    ],
    includeFilters: ['*.tsx', '*.ts', '*.js', '*.jsx', '*.json'],
    manifestSnapshotId,
    materializedPaths,
    rootPath,
    selectionRootPath: path.join(rootPath, 'src'),
  });
}

/**
 * Writes the nested selection tree into a real folder: one root file and a
 * `src` directory with two files. The Explorer reads it through the agent host,
 * as it reads any folder.
 */
export async function writeNestedFolderFixture(rootPath: string): Promise<void> {
  await mkdir(path.join(rootPath, 'src'), { recursive: true });
  await writeFile(path.join(rootPath, 'mock-file1.ts'), 'export const rootValue = 1;');
  await writeFile(path.join(rootPath, 'src', 'index.ts'), 'export const value = 1;');
  await writeFile(path.join(rootPath, 'src', 'extra.ts'), 'export const extra = 2;');
}

/** Explorer tree-expansion actions, by their stable testids. */
export type ExplorerTreeAction = 'collapse-all' | 'expand-all';

const TREE_ACTION_MENU_ITEM: Record<ExplorerTreeAction, string> = {
  'collapse-all': 'Collapse all directories',
  'expand-all': 'Expand all directories',
};

/**
 * Click Expand All / Collapse All the way a user reaches them on desktop.
 *
 * RESPONSIVE since BST-1208: the toolbar's left track carries the buttons at
 * and above its 236px step, and the compact "More Explorer actions" menu
 * carries them below it. The desktop Explorer panel opens at its 180px
 * MINIMUM — the same default state BST-657 is about — so the menu is the live
 * route here and clicking the testid directly times out.
 *
 * Exactly one surface must be offering the action, so a layout change that
 * shows both (or neither) fails loudly rather than being hidden by a fallback.
 */
export async function clickExplorerTreeAction(
  page: Page,
  action: ExplorerTreeAction
): Promise<void> {
  const toolbar = page.getByTestId('file-explorer-toolbar');
  const wideButton = toolbar.getByTestId(`${action}-button-small`);
  const compactActions = toolbar.getByRole('button', { name: 'More Explorer actions' });
  const visibleActionSurfaces = wideButton.or(compactActions).filter({ visible: true });

  await expect(visibleActionSurfaces).toHaveCount(1, { timeout: 15_000 });

  if (await wideButton.isVisible()) {
    await clickExpandButton(wideButton);
    return;
  }

  await compactActions.click({ noWaitAfter: true, timeout: FILE_EXPLORER_CLICK_TIMEOUT_MS });
  const menuItem = page.getByRole('menuitem', { exact: true, name: TREE_ACTION_MENU_ITEM[action] });
  await expect(menuItem).toBeVisible({ timeout: 15_000 });
  await menuItem.click({ noWaitAfter: true, timeout: FILE_EXPLORER_CLICK_TIMEOUT_MS });
}
