import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildQuerySelectionFingerprint } from '@brainstrike/file-explorer';
import {
  FILE_EXPLORER_STORAGE_KEY,
  FILE_EXPLORER_STORAGE_VERSION,
  serializeState,
} from '@brainstrike/file-explorer/testing';
import type { FileExplorerState } from '@brainstrike/types';
import { createEmptySelectionModel, DEFAULT_STATE } from '@brainstrike/types';
import type { ElectronApplication, Locator, Page } from 'playwright';
import { expect, test } from './fixtures/electron-fixture';

export { expect, test };

import { getContextExplorerFileExplorerPanel } from './utils/context-explorer-locators';

// NOTE: deliberately no `loadElectronHelpers` re-export. This module documents
// that a harness-owned app must only be closed via `closeForStateSeeding()`, so
// it should not also hand callers `closeElectronApp`. Specs that genuinely need
// the helpers import './utils/load-electron-helpers' directly.
export { getContextExplorerFileExplorerPanel };

/**
 * Harness surface the seeding helpers need.
 *
 * `closeForStateSeeding` is mandatory: the harness registers every process it
 * launches with `ElectronProcessExitGuard`, so closing a harness-owned app any
 * other way (e.g. `closeElectronApp` directly) records the exit as unexpected
 * and fails the test before it reaches its first assertion (BST-1087).
 */
export interface SeedableElectronHarness {
  closeForStateSeeding: () => Promise<void>;
  ensureContext: () => Promise<{
    app: ElectronApplication;
    window: Page;
  }>;
}

export interface ElectronE2eFileSystemFixture {
  directoriesByPath: Record<string, unknown[]>;
  /**
   * Opt-in per-read delay (ms) honored by the main-process `fs:readDirectory`
   * handler (apps/desktop/src/ipc-domains/file-system-ipc.ts). Omit it — as
   * every fixture below this one does — to keep reads instant.
   */
  directoryReadDelayMs?: number;
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

export interface FileExplorerTestSnapshot {
  materializedPathCount: number;
  selectedFilePathCount: number;
  treeRootCount: number;
}

export interface FileExplorerTestHooksWindow {
  __brainstrikeFileExplorerTestHooks__?: {
    getSnapshot: () => FileExplorerTestSnapshot;
  };
}

export const FILE_EXPLORER_CLICK_TIMEOUT_MS = 15_000;
export const FILE_EXPLORER_SETTLE_TIMEOUT_MS = 15_000;
export const FILE_EXPLORER_SETTLE_POLL_MS = 100;
export const FILE_EXPLORER_SETTLE_STABLE_SAMPLES = 3;
export const FILE_TREE_CHECKBOX_INTERACTION_TIMEOUT_MS = 45_000;
export const FILE_TREE_MULTI_STEP_SELECTION_TEST_TIMEOUT_MS = 90_000;
export const MIN_PLAYWRIGHT_STEP_TIMEOUT_MS = 1000;
export const RENDERER_FRAME_SETTLE_COUNT = 2;
export const RENDERER_FRAME_SETTLE_TIMEOUT_MS = 5000;

export async function ensureFileExplorerPanelVisible(page: Page): Promise<void> {
  const explorerPanel = getContextExplorerFileExplorerPanel(page);
  const showExplorerPanelButton = page
    .getByTestId('show-explorer-panel')
    .or(page.getByRole('button', { name: /show explorer/i }));

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

export async function clickExpandButton(expandButton: Locator): Promise<void> {
  await expect(expandButton).toBeVisible({ timeout: 15_000 });
  await expandButton.click({ noWaitAfter: true, timeout: FILE_EXPLORER_CLICK_TIMEOUT_MS });
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function cssString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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
    .filter({ hasText: new RegExp(`(^|\\s)${escapeRegExp(directoryName)}(\\s|$)`) })
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

export async function setFileExplorerMaxSelectionCount(
  page: Page,
  maxSelectionCount: number
): Promise<void> {
  await dismissBlockingToastNotifications(page);

  const selectionSettingsButton = getContextExplorerFileExplorerPanel(page).getByRole('button', {
    name: 'Selection settings',
  });
  await expect(selectionSettingsButton).toBeVisible({ timeout: 15_000 });
  await selectionSettingsButton.click({
    noWaitAfter: true,
    timeout: FILE_EXPLORER_CLICK_TIMEOUT_MS,
  });

  const selectionCountInput = page.getByLabel('Maximum selection count input');
  await expect(selectionCountInput).toBeVisible({ timeout: 15_000 });
  await selectionCountInput.fill(String(maxSelectionCount));
  await selectionCountInput.press('Enter');
  await expect(page.getByTestId('selection-max')).toHaveText(String(maxSelectionCount), {
    timeout: 15_000,
  });
}

async function dismissBlockingToastNotifications(page: Page): Promise<void> {
  const notificationItems = page.locator(
    '[role="region"][aria-label^="Notifications"] [data-radix-collection-item]'
  );
  const closeButtons = page.locator('[role="region"][aria-label^="Notifications"] [toast-close]');

  for (let attempt = 0; attempt < 5; attempt++) {
    const notificationCount = await notificationItems.count();
    if (notificationCount === 0) {
      return;
    }

    const closeButtonCount = await closeButtons.count();
    if (closeButtonCount === 0) {
      break;
    }

    await closeButtons.first().click({ timeout: 2000 });
    await page.waitForTimeout(150);
  }

  await expect(notificationItems).toHaveCount(0, { timeout: 5000 });
}

export async function waitForRendererFrames(page: Page, timeoutMs: number): Promise<void> {
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

export async function readFileExplorerSnapshot(page: Page): Promise<FileExplorerTestSnapshot> {
  return page.evaluate(() => {
    const hooks = (window as FileExplorerTestHooksWindow).__brainstrikeFileExplorerTestHooks__;
    if (!hooks?.getSnapshot) {
      throw new Error('Missing required file explorer E2E test hooks');
    }
    return hooks.getSnapshot();
  });
}

export function getRemainingInteractionTimeout(args: { deadline: number; label: string }): number {
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

export async function clickFileTreeCheckboxAndWaitForSelection(args: {
  checkboxName: string;
  expectedSelectedCount: number;
  fileTree: ReturnType<Page['getByRole']>;
  page: Page;
}): Promise<void> {
  const { checkboxName, expectedSelectedCount, fileTree, page } = args;
  if (expectedSelectedCount < 1) {
    throw new Error(
      `File tree checkbox selection helper requires expectedSelectedCount >= 1; received ${expectedSelectedCount}.`
    );
  }
  const checkbox = fileTree.getByRole('checkbox', { name: `Select ${checkboxName}` });
  const deadline = Date.now() + FILE_TREE_CHECKBOX_INTERACTION_TIMEOUT_MS;

  await waitForFileExplorerSelectionIdle({
    expectedSelectedCount: expectedSelectedCount - 1,
    page,
    timeoutMs: getRemainingInteractionTimeout({
      deadline,
      label: `selection idle before selecting ${checkboxName}`,
    }),
  });
  await expect(checkbox).toHaveAttribute('data-state', 'unchecked', {
    timeout: getRemainingInteractionTimeout({
      deadline,
      label: `unchecked assertion for ${checkboxName}`,
    }),
  });
  await checkbox.click({
    noWaitAfter: true,
    timeout: getRemainingInteractionTimeout({
      deadline,
      label: `clicking ${checkboxName}`,
    }),
  });
  await expect(checkbox).toHaveAttribute('data-state', 'checked', {
    timeout: getRemainingInteractionTimeout({
      deadline,
      label: `checked assertion for ${checkboxName}`,
    }),
  });
  await expect(page.getByTestId('selection-count')).toHaveText(String(expectedSelectedCount), {
    timeout: getRemainingInteractionTimeout({
      deadline,
      label: `selection count assertion for ${checkboxName}`,
    }),
  });
  await waitForFileExplorerSelectionIdle({
    expectedSelectedCount,
    page,
    timeoutMs: getRemainingInteractionTimeout({
      deadline,
      label: `selection idle after selecting ${checkboxName}`,
    }),
  });
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
    expectedSelectedCount: expectedSelectedCountBefore,
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

export async function getExpandedDirectoryCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const fileExplorerStore = (
      window as Window & {
        // biome-ignore lint/style/useNamingConvention: Renderer test hook global intentionally uses the app-owned key.
        __brainstrike_file_explorer_provider_store__?: {
          getState?: () => { expandedDirectoryPaths?: Set<string> };
        };
      }
    ).__brainstrike_file_explorer_provider_store__;
    return fileExplorerStore?.getState?.().expandedDirectoryPaths?.size ?? 0;
  });
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
export const E2E_ROOT_ID = 'e2e-root-00000000-0000-4000-8000-000000000001';

/** Fixed addedAt for the seeded rootsList entry — deterministic fixture data. */
const E2E_ROOT_ADDED_AT = 1_700_000_000_000;

export function createBaseExplorerState(rootPath: string): FileExplorerState {
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

export function createRestoredExplicitSelectionSnapshot(args: {
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

export function createRestoredQuerySelectionSnapshot(args: {
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

export async function seedRestoredExplicitSelectionState(args: {
  electronHarness: SeedableElectronHarness;
  expandedDirectoryPaths: string[];
  rootPath: string;
  selectedFilePaths: string[];
}): Promise<void> {
  const { electronHarness, expandedDirectoryPaths, rootPath, selectedFilePaths } = args;
  const persistedState = createRestoredExplicitSelectionSnapshot({
    expandedDirectoryPaths,
    rootPath,
    selectedFilePaths,
  });
  const currentContext = await electronHarness.ensureContext();
  const userDataDir = await currentContext.app.evaluate(async ({ app }) => app.getPath('userData'));

  await electronHarness.closeForStateSeeding();

  const storagePath = path.join(userDataDir, 'electron-storage.json');
  let existingStorage: Record<string, string> = {};
  try {
    existingStorage = JSON.parse(await readFile(storagePath, 'utf8')) as Record<string, string>;
  } catch {
    existingStorage = {};
  }

  const nextStorage = {
    ...existingStorage,
    lastFolderPath: rootPath,
    // Storage v5: main's restoreRoots resolves rootPath → E2E_ROOT_ID via this
    // entry, so the restored root carries the same RootId the snapshot is keyed by.
    rootsList: JSON.stringify([
      { addedAt: E2E_ROOT_ADDED_AT, path: rootPath, rootId: E2E_ROOT_ID },
    ]),
    [FILE_EXPLORER_STORAGE_KEY]: JSON.stringify(persistedState),
  };

  await writeFile(storagePath, JSON.stringify(nextStorage, null, 2), 'utf8');
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
  const {
    coveredDirectoryPaths,
    electronHarness,
    expandedDirectoryPaths,
    excludeFilters,
    excludedPaths,
    includeFilters,
    includedPaths,
    manifestSnapshotId,
    materializedPaths,
    rootPath,
    selectionRootPath,
  } = args;
  const persistedState = createRestoredQuerySelectionSnapshot({
    coveredDirectoryPaths,
    excludedPaths,
    excludeFilters,
    expandedDirectoryPaths,
    includedPaths,
    includeFilters,
    manifestSnapshotId,
    materializedPaths,
    rootPath,
    selectionRootPath,
  });
  const currentContext = await electronHarness.ensureContext();
  const userDataDir = await currentContext.app.evaluate(async ({ app }) => app.getPath('userData'));

  await electronHarness.closeForStateSeeding();

  const storagePath = path.join(userDataDir, 'electron-storage.json');
  let existingStorage: Record<string, string> = {};
  try {
    existingStorage = JSON.parse(await readFile(storagePath, 'utf8')) as Record<string, string>;
  } catch {
    existingStorage = {};
  }

  const nextStorage = {
    ...existingStorage,
    lastFolderPath: rootPath,
    // Storage v5: main's restoreRoots resolves rootPath → E2E_ROOT_ID via this
    // entry, so the restored root carries the same RootId the snapshot is keyed by.
    rootsList: JSON.stringify([
      { addedAt: E2E_ROOT_ADDED_AT, path: rootPath, rootId: E2E_ROOT_ID },
    ]),
    [FILE_EXPLORER_STORAGE_KEY]: JSON.stringify(persistedState),
  };

  await writeFile(storagePath, JSON.stringify(nextStorage, null, 2), 'utf8');
}

export async function writeLive3dmolRestoreFixture(args: {
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
    `${rootPath}/src/App.tsx`,
    `${rootPath}/src/main.tsx`,
    `${rootPath}/src/vite-env.d.ts`,
    `${rootPath}/src/hooks/use-molecule-sdf.test.ts`,
    `${rootPath}/src/hooks/use-molecule-sdf.ts`,
    `${rootPath}/src/hooks/use-resize-draw.ts`,
    `${rootPath}/src/hooks/use-viewer.ts`,
    `${rootPath}/src/types/3dmol-build.d.ts`,
    `${rootPath}/src/types/molstar-viewer.d.ts`,
    `${rootPath}/src/utils/3dmol-loader.ts`,
    `${rootPath}/src/components/molecule-viewer.test.tsx`,
    `${rootPath}/src/components/molecule-viewer.tsx`,
    `${rootPath}/src/components/molstar-viewer.test.tsx`,
    `${rootPath}/src/components/molstar-viewer.tsx`,
    `${rootPath}/src/components/viewer-shell.tsx`,
  ];

  await writeLive3dmolRestoreFixture({ filePaths: materializedPaths, rootPath });

  await seedRestoredQuerySelectionState({
    coveredDirectoryPaths: [
      '/Users',
      '/Users/seandearnaley',
      '/Users/seandearnaley/Documents',
      '/Users/seandearnaley/Documents/GitHub',
      rootPath,
      `${rootPath}/src`,
      `${rootPath}/src/components`,
      `${rootPath}/src/hooks`,
      `${rootPath}/src/types`,
      `${rootPath}/src/utils`,
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
      `${rootPath}/src`,
    ],
    includeFilters: ['*.tsx', '*.ts', '*.js', '*.jsx', '*.json'],
    manifestSnapshotId,
    materializedPaths,
    rootPath,
    selectionRootPath: `${rootPath}/src`,
  });
}

export async function installNestedFolderFixture(
  electronApp: ElectronApplication,
  rootPath: string
): Promise<void> {
  const fixture: ElectronE2eFileSystemFixture = {
    directoriesByPath: {
      [rootPath]: [
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'mock-file1.ts',
            path: `${rootPath}/mock-file1.ts`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'mock-file1.ts',
          path: `${rootPath}/mock-file1.ts`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 100,
          type: 'file' as const,
        },
        {
          children: [],
          depth: 0,
          handle: {
            kind: 'directory' as const,
            name: 'src',
            path: `${rootPath}/src`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'src',
          path: `${rootPath}/src`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          type: 'directory' as const,
        },
      ],
      [`${rootPath}/src`]: [
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'index.ts',
            path: `${rootPath}/src/index.ts`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'index.ts',
          path: `${rootPath}/src/index.ts`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 120,
          type: 'file' as const,
        },
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'extra.ts',
            path: `${rootPath}/src/extra.ts`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'extra.ts',
          path: `${rootPath}/src/extra.ts`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 140,
          type: 'file' as const,
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
        // biome-ignore lint/style/useNamingConvention: Desktop E2E fixture global intentionally uses the app-owned key.
        __brainstrike_e2e_file_system_fixture__?: ElectronE2eFileSystemFixture | undefined;
      }
    ).__brainstrike_e2e_file_system_fixture__ = nextFixture;
  }, fixture);
}

export const WIDE_EXPAND_ALL_ROOT_DIRECTORY_COUNT = 30;
export const WIDE_EXPAND_ALL_CHILD_DIRECTORY_COUNT = 8;
/** Every directory expand-all must read: the root folders plus their children. */
export const WIDE_EXPAND_ALL_TOTAL_DIRECTORY_COUNT =
  WIDE_EXPAND_ALL_ROOT_DIRECTORY_COUNT +
  WIDE_EXPAND_ALL_ROOT_DIRECTORY_COUNT * WIDE_EXPAND_ALL_CHILD_DIRECTORY_COUNT;

/**
 * Per-read delay that makes expand-all genuinely cancellable for the test below.
 *
 * Without it the memory-served fixture answers every read in microseconds and
 * the whole 270-directory sweep finishes in ~35ms, leaving the Cancel button
 * on screen for roughly 3 frames — the test then passes only because Playwright
 * round-trips happen to land inside that window, and a single slow round-trip
 * on a loaded CI runner loses it.
 *
 * Sizing: the worker walks directories in serial batches of 10 (BATCH_SIZE,
 * packages/file-tree-worker/src/bfs-engine.ts) and each batch resolves as two
 * chunk-barriered groups of 5 (MAX_CONCURRENT_LOADS, use-file-tree-worker.ts),
 * so the sweep costs ~54 delays ≈ 13.5s — comfortably inside the test's 60s
 * budget even if cancellation never lands. Matches the browser lane's constant
 * (apps/web/e2e/performance/tree-rendering.test.ts, BST-1044).
 */
export const WIDE_EXPAND_ALL_DIRECTORY_READ_DELAY_MS = 250;

export async function installWideExpandAllFixture(
  electronApp: ElectronApplication,
  rootPath: string
): Promise<void> {
  const directoriesByPath: Record<string, unknown[]> = {};
  const fileContentsByPath: Record<string, string> = {};

  const createDirectoryEntry = (args: {
    depth: number;
    name: string;
    path: string;
    rootFolderId: string;
  }) => ({
    children: [],
    depth: args.depth,
    handle: {
      kind: 'directory' as const,
      name: args.name,
      path: args.path,
      platform: 'electron' as const,
    },
    isVisible: true,
    name: args.name,
    path: args.path,
    rootFolderId: args.rootFolderId,
    selectionState: 'unchecked' as const,
    size: 0,
    type: 'directory' as const,
  });

  const createFileEntry = (args: {
    depth: number;
    name: string;
    path: string;
    rootFolderId: string;
  }) => ({
    depth: args.depth,
    handle: {
      kind: 'file' as const,
      name: args.name,
      path: args.path,
      platform: 'electron' as const,
    },
    isVisible: true,
    name: args.name,
    path: args.path,
    rootFolderId: args.rootFolderId,
    selectionState: 'unchecked' as const,
    size: 100,
    type: 'file' as const,
  });

  directoriesByPath[rootPath] = Array.from(
    { length: WIDE_EXPAND_ALL_ROOT_DIRECTORY_COUNT },
    (_, rootIndex) =>
      createDirectoryEntry({
        depth: 0,
        name: `folder-${rootIndex}`,
        path: `${rootPath}/folder-${rootIndex}`,
        rootFolderId: rootPath,
      })
  );

  for (let rootIndex = 0; rootIndex < WIDE_EXPAND_ALL_ROOT_DIRECTORY_COUNT; rootIndex += 1) {
    const directoryPath = `${rootPath}/folder-${rootIndex}`;
    directoriesByPath[directoryPath] = Array.from(
      { length: WIDE_EXPAND_ALL_CHILD_DIRECTORY_COUNT },
      (_, childIndex) =>
        createDirectoryEntry({
          depth: 1,
          name: `child-${rootIndex}-${childIndex}`,
          path: `${directoryPath}/child-${rootIndex}-${childIndex}`,
          rootFolderId: rootPath,
        })
    );

    for (let childIndex = 0; childIndex < WIDE_EXPAND_ALL_CHILD_DIRECTORY_COUNT; childIndex += 1) {
      const childDirectoryPath = `${directoryPath}/child-${rootIndex}-${childIndex}`;
      const filePath = `${childDirectoryPath}/file-${rootIndex}-${childIndex}.ts`;
      directoriesByPath[childDirectoryPath] = [
        createFileEntry({
          depth: 2,
          name: `file-${rootIndex}-${childIndex}.ts`,
          path: filePath,
          rootFolderId: rootPath,
        }),
      ];
      fileContentsByPath[filePath] =
        `export const value${rootIndex}_${childIndex} = ${rootIndex + childIndex};`;
    }
  }

  const fixture: ElectronE2eFileSystemFixture = {
    directoriesByPath,
    directoryReadDelayMs: WIDE_EXPAND_ALL_DIRECTORY_READ_DELAY_MS,
    fileContentsByPath,
    readDirectoryCalls: [],
    readFileByPathCalls: [],
    readFileCalls: [],
    requestDirectoryAccessCount: 0,
    rootHandle: {
      id: 'mock-wide-expand-all-handle',
      kind: 'directory',
      name: 'mock-wide-expand-all-root',
      path: rootPath,
      platform: 'electron',
      type: 'directory',
    },
  };

  await electronApp.evaluate((_electron, nextFixture) => {
    (
      globalThis as typeof globalThis & {
        // biome-ignore lint/style/useNamingConvention: Desktop E2E fixture global intentionally uses the app-owned key.
        __brainstrike_e2e_file_system_fixture__?: ElectronE2eFileSystemFixture | undefined;
      }
    ).__brainstrike_e2e_file_system_fixture__ = nextFixture;
  }, fixture);
}

export async function installNestedPackagesFixture(
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
            name: 'docs',
            path: `${rootPath}/docs`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'docs',
          path: `${rootPath}/docs`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 0,
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
          size: 0,
          type: 'directory' as const,
        },
      ],
      [`${rootPath}/docs`]: [
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'readme.md',
            path: `${rootPath}/docs/readme.md`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'readme.md',
          path: `${rootPath}/docs/readme.md`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 50,
          type: 'file' as const,
        },
      ],
      [`${rootPath}/packages`]: [
        {
          children: [],
          depth: 0,
          handle: {
            kind: 'directory' as const,
            name: 'agent',
            path: `${rootPath}/packages/agent`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'agent',
          path: `${rootPath}/packages/agent`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 0,
          type: 'directory' as const,
        },
        {
          children: [],
          depth: 0,
          handle: {
            kind: 'directory' as const,
            name: 'app-shell',
            path: `${rootPath}/packages/app-shell`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'app-shell',
          path: `${rootPath}/packages/app-shell`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 0,
          type: 'directory' as const,
        },
      ],
      [`${rootPath}/packages/agent`]: [
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'index.ts',
            path: `${rootPath}/packages/agent/index.ts`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'index.ts',
          path: `${rootPath}/packages/agent/index.ts`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 100,
          type: 'file' as const,
        },
      ],
      [`${rootPath}/packages/app-shell`]: [
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'main.ts',
            path: `${rootPath}/packages/app-shell/main.ts`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'main.ts',
          path: `${rootPath}/packages/app-shell/main.ts`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 120,
          type: 'file' as const,
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
        // biome-ignore lint/style/useNamingConvention: Desktop E2E fixture global intentionally uses the app-owned key.
        __brainstrike_e2e_file_system_fixture__?: ElectronE2eFileSystemFixture | undefined;
      }
    ).__brainstrike_e2e_file_system_fixture__ = nextFixture;
  }, fixture);
}

export async function installIncrementalFolderSelectionFixture(
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
            name: 'e2e',
            path: `${rootPath}/e2e`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'e2e',
          path: `${rootPath}/e2e`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 0,
          type: 'directory' as const,
        },
      ],
      [`${rootPath}/e2e`]: [
        {
          children: [],
          depth: 0,
          handle: {
            kind: 'directory' as const,
            name: 'page-objects',
            path: `${rootPath}/e2e/page-objects`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'page-objects',
          path: `${rootPath}/e2e/page-objects`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 0,
          type: 'directory' as const,
        },
        {
          children: [],
          depth: 0,
          handle: {
            kind: 'directory' as const,
            name: 'types',
            path: `${rootPath}/e2e/types`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'types',
          path: `${rootPath}/e2e/types`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 0,
          type: 'directory' as const,
        },
        {
          children: [],
          depth: 0,
          handle: {
            kind: 'directory' as const,
            name: 'utils',
            path: `${rootPath}/e2e/utils`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'utils',
          path: `${rootPath}/e2e/utils`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 0,
          type: 'directory' as const,
        },
      ],
      [`${rootPath}/e2e/page-objects`]: [
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'file-explorer-page.ts',
            path: `${rootPath}/e2e/page-objects/file-explorer-page.ts`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'file-explorer-page.ts',
          path: `${rootPath}/e2e/page-objects/file-explorer-page.ts`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 100,
          type: 'file' as const,
        },
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'home-page.ts',
            path: `${rootPath}/e2e/page-objects/home-page.ts`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'home-page.ts',
          path: `${rootPath}/e2e/page-objects/home-page.ts`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 120,
          type: 'file' as const,
        },
      ],
      [`${rootPath}/e2e/types`]: [
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'performance.ts',
            path: `${rootPath}/e2e/types/performance.ts`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'performance.ts',
          path: `${rootPath}/e2e/types/performance.ts`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 80,
          type: 'file' as const,
        },
      ],
      [`${rootPath}/e2e/utils`]: [
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'layout-helpers.ts',
            path: `${rootPath}/e2e/utils/layout-helpers.ts`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'layout-helpers.ts',
          path: `${rootPath}/e2e/utils/layout-helpers.ts`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 90,
          type: 'file' as const,
        },
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'performance-helpers.ts',
            path: `${rootPath}/e2e/utils/performance-helpers.ts`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'performance-helpers.ts',
          path: `${rootPath}/e2e/utils/performance-helpers.ts`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 90,
          type: 'file' as const,
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
        // biome-ignore lint/style/useNamingConvention: Desktop E2E fixture global intentionally uses the app-owned key.
        __brainstrike_e2e_file_system_fixture__?: ElectronE2eFileSystemFixture | undefined;
      }
    ).__brainstrike_e2e_file_system_fixture__ = nextFixture;
  }, fixture);
}

export async function installMixedHookSelectionFixture(
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
            name: 'hooks',
            path: `${rootPath}/hooks`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'hooks',
          path: `${rootPath}/hooks`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 0,
          type: 'directory' as const,
        },
      ],
      [`${rootPath}/hooks`]: [
        {
          children: [],
          depth: 0,
          handle: {
            kind: 'directory' as const,
            name: 'src',
            path: `${rootPath}/hooks/src`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'src',
          path: `${rootPath}/hooks/src`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 0,
          type: 'directory' as const,
        },
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'package.json',
            path: `${rootPath}/hooks/package.json`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'package.json',
          path: `${rootPath}/hooks/package.json`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 80,
          type: 'file' as const,
        },
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'tsconfig.json',
            path: `${rootPath}/hooks/tsconfig.json`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'tsconfig.json',
          path: `${rootPath}/hooks/tsconfig.json`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 80,
          type: 'file' as const,
        },
      ],
      [`${rootPath}/hooks/src`]: [
        {
          children: [],
          depth: 0,
          handle: {
            kind: 'directory' as const,
            name: '__tests__',
            path: `${rootPath}/hooks/src/__tests__`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: '__tests__',
          path: `${rootPath}/hooks/src/__tests__`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 0,
          type: 'directory' as const,
        },
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'create-debounce.ts',
            path: `${rootPath}/hooks/src/create-debounce.ts`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'create-debounce.ts',
          path: `${rootPath}/hooks/src/create-debounce.ts`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 100,
          type: 'file' as const,
        },
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'index.ts',
            path: `${rootPath}/hooks/src/index.ts`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'index.ts',
          path: `${rootPath}/hooks/src/index.ts`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 120,
          type: 'file' as const,
        },
      ],
      [`${rootPath}/hooks/src/__tests__`]: [
        {
          depth: 0,
          handle: {
            kind: 'file' as const,
            name: 'use-file-filters.test.ts',
            path: `${rootPath}/hooks/src/__tests__/use-file-filters.test.ts`,
            platform: 'electron' as const,
          },
          isVisible: true,
          name: 'use-file-filters.test.ts',
          path: `${rootPath}/hooks/src/__tests__/use-file-filters.test.ts`,
          rootFolderId: rootPath,
          selectionState: 'unchecked' as const,
          size: 90,
          type: 'file' as const,
        },
      ],
    },
    fileContentsByPath: {
      [`${rootPath}/hooks/package.json`]: '{"name":"hooks"}',
      [`${rootPath}/hooks/tsconfig.json`]: '{"extends":"../../tsconfig.base.json"}',
      [`${rootPath}/hooks/src/create-debounce.ts`]: 'export const createDebounce = () => 1;',
      [`${rootPath}/hooks/src/index.ts`]: 'export const indexValue = 1;',
      [`${rootPath}/hooks/src/__tests__/use-file-filters.test.ts`]:
        'export const useFileFiltersTest = 1;',
    },
    readDirectoryCalls: [],
    readFileByPathCalls: [],
    readFileCalls: [],
    requestDirectoryAccessCount: 0,
    rootHandle: {
      id: 'mock-directory-handle-hooks',
      kind: 'directory',
      name: 'mock-desktop-selection-hooks-root',
      path: rootPath,
      platform: 'electron',
      type: 'directory',
    },
  };

  await electronApp.evaluate((_electron, nextFixture) => {
    (
      globalThis as typeof globalThis & {
        // biome-ignore lint/style/useNamingConvention: Desktop E2E fixture global intentionally uses the app-owned key.
        __brainstrike_e2e_file_system_fixture__?: ElectronE2eFileSystemFixture | undefined;
      }
    ).__brainstrike_e2e_file_system_fixture__ = nextFixture;
  }, fixture);
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

/**
 * Assert the tree-expansion actions are REACHABLE again — one surface offering
 * them, and it is live.
 *
 * Replaces `expect(expandAllButton).toBeEnabled()` at the Explorer's 180px
 * default, where that button is not in the DOM. It also cannot be swapped for
 * the compact menu's item mid-sweep: BST-657 makes the menu YIELD its slot to
 * the cancel affordance while an operation runs, so during a sweep neither
 * surface exposes the expansion actions at all. "Reachable again" is therefore
 * the honest post-condition, and it is exactly what the original assertion was
 * really checking — the operation finished and the control came back.
 */
export async function expectExplorerTreeActionsReachable(page: Page): Promise<void> {
  const toolbar = page.getByTestId('file-explorer-toolbar');
  const wideButton = toolbar.getByTestId('expand-all-button-small');
  const compactActions = toolbar.getByRole('button', { name: 'More Explorer actions' });
  await expect(wideButton.or(compactActions).filter({ visible: true })).toHaveCount(1, {
    timeout: 15_000,
  });
}
