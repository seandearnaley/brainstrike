import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileExplorerState } from '@brainstrike/types';
import { createEmptySelectionModel, DEFAULT_STATE } from '@brainstrike/types';
import type { ElectronApplication, Locator, Page } from 'playwright';
import { FILE_EXPLORER_STORAGE_VERSION } from '../../../packages/file-explorer/src/persistence/persistence-constants.ts';
import { serializeState } from '../../../packages/file-explorer/src/persistence/state-serialization.ts';
import { buildQuerySelectionFingerprint } from '../../../packages/file-explorer/src/utils/query-selection-manifest.ts';
import { expect, test } from './fixtures/electron-fixture';

export { expect, test };

import {
  getContextExplorerFileExplorerPanel,
  getContextExplorerMiddlePanel,
} from './utils/context-explorer-locators';
import { loadElectronHelpers } from './utils/load-electron-helpers';

export { getContextExplorerFileExplorerPanel, getContextExplorerMiddlePanel, loadElectronHelpers };

export interface ElectronE2eFileSystemFixture {
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

export async function expectContextExplorerFileVisibility(args: {
  fileName: string;
  page: Page;
  visible: boolean;
}): Promise<void> {
  const { fileName, page, visible } = args;
  await expect(getContextExplorerMiddlePanel(page)).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () =>
        page.evaluate((targetFileName) => {
          const hooks = (
            window as Window & {
              __brainstrikeContextExplorerPreviewTestHooks__?: {
                getSnapshot?: () => { renderedFilePaths?: string[] };
              };
            }
          ).__brainstrikeContextExplorerPreviewTestHooks__;

          const renderedFilePaths = hooks?.getSnapshot?.().renderedFilePaths ?? [];
          return renderedFilePaths.some((filePath) => {
            const normalizedPath = filePath.replaceAll('\\', '/');
            const segments = normalizedPath.split('/');
            return segments.at(-1) === targetFileName;
          });
        }, fileName),
      {
        timeout: 10_000,
      }
    )
    .toBe(visible);
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

export function createBaseExplorerState(rootPath: string): FileExplorerState {
  return {
    ...DEFAULT_STATE,
    currentFolderId: rootPath,
    folderStates: {},
    folderAccessOrder: [rootPath],
    selectedFilePaths: new Set<string>(),
    expandedDirectoryPaths: new Set<string>(),
    quickFilter: DEFAULT_STATE.quickFilter,
    rootDirectoryHandle: null,
    isAccessLoading: false,
    querySelectionManifest: null,
  } as unknown as FileExplorerState;
}

export function createRestoredExplicitSelectionSnapshot(args: {
  expandedDirectoryPaths: string[];
  rootPath: string;
  selectedFilePaths: string[];
}) {
  const { expandedDirectoryPaths, rootPath, selectedFilePaths } = args;
  const selectedCompositeKeys = selectedFilePaths.map((filePath) => `${rootPath}|@|${filePath}`);
  const explicitSelectionModel = {
    ...createEmptySelectionModel(),
    explicitPaths: new Set(selectedCompositeKeys),
  };
  const state: FileExplorerState = {
    ...createBaseExplorerState(rootPath),
    currentFolderId: rootPath,
    folderStates: {
      [rootPath]: {
        selectedFilePaths: new Set(selectedCompositeKeys),
        selectionModel: explicitSelectionModel,
        expandedDirectoryPaths: new Set(expandedDirectoryPaths),
        includeFilters: [...DEFAULT_STATE.includeFilters],
        excludeFilters: [...DEFAULT_STATE.excludeFilters],
        useRegex: DEFAULT_STATE.useRegex,
        includeProjectTree: DEFAULT_STATE.includeProjectTree,
        tokenBudget: DEFAULT_STATE.tokenBudget,
        folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
        maxSelectionCount: DEFAULT_STATE.maxSelectionCount,
        lastActiveTab: DEFAULT_STATE.lastActiveTab,
        lastAccessed: Date.now(),
        viewFilterPresetId: DEFAULT_STATE.viewFilterPresetId,
      },
    },
    folderAccessOrder: [rootPath],
    selectedFilePaths: new Set(selectedCompositeKeys),
    expandedDirectoryPaths: new Set(expandedDirectoryPaths),
    includeFilters: [...DEFAULT_STATE.includeFilters],
    excludeFilters: [...DEFAULT_STATE.excludeFilters],
    useRegex: DEFAULT_STATE.useRegex,
    includeProjectTree: DEFAULT_STATE.includeProjectTree,
    tokenBudget: DEFAULT_STATE.tokenBudget,
    folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
    maxSelectionCount: DEFAULT_STATE.maxSelectionCount,
    lastActiveTab: DEFAULT_STATE.lastActiveTab,
    quickFilter: DEFAULT_STATE.quickFilter,
    devInlineFixtureEnabled: DEFAULT_STATE.devInlineFixtureEnabled,
    selectionModel: explicitSelectionModel,
    viewFilterPresetId: DEFAULT_STATE.viewFilterPresetId,
    isFiltersExpanded: DEFAULT_STATE.isFiltersExpanded,
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
    kind: 'recursive-folder' as const,
    folderId: rootPath,
    rootPath: selectionRootPath,
    coveredDirectoryPaths,
    includeFilters,
    excludeFilters,
    includedPaths,
    excludedPaths,
    manifestFingerprint: buildQuerySelectionFingerprint({
      excludeFilters,
      folderId: rootPath,
      includeFilters,
      kind: 'recursive-folder',
      rootPath: selectionRootPath,
      useRegex: false,
    }),
    manifestSnapshotId,
    totalSelectedCount: Math.max(0, uniqueSelectedPathCount - excludedPaths.length),
    useRegex: false,
  };

  const state: FileExplorerState = {
    ...createBaseExplorerState(rootPath),
    currentFolderId: rootPath,
    folderStates: {
      [rootPath]: {
        selectedFilePaths: new Set<string>(),
        selectionModel: {
          ...createEmptySelectionModel(),
          mode: 'query',
          materializedPaths: materializedPathSet,
          materializedAt: new Date().toISOString(),
          queryDescriptor: descriptor,
        },
        expandedDirectoryPaths: new Set(expandedDirectoryPaths),
        includeFilters: [...includeFilters],
        excludeFilters: [...excludeFilters],
        useRegex: false,
        includeProjectTree: DEFAULT_STATE.includeProjectTree,
        tokenBudget: DEFAULT_STATE.tokenBudget,
        folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
        maxSelectionCount: DEFAULT_STATE.maxSelectionCount,
        lastActiveTab: DEFAULT_STATE.lastActiveTab,
        lastAccessed: Date.now(),
        viewFilterPresetId: DEFAULT_STATE.viewFilterPresetId,
      },
    },
    folderAccessOrder: [rootPath],
    selectedFilePaths: new Set<string>(),
    expandedDirectoryPaths: new Set(expandedDirectoryPaths),
    includeFilters: [...includeFilters],
    excludeFilters: [...excludeFilters],
    useRegex: false,
    includeProjectTree: DEFAULT_STATE.includeProjectTree,
    tokenBudget: DEFAULT_STATE.tokenBudget,
    folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
    maxSelectionCount: DEFAULT_STATE.maxSelectionCount,
    lastActiveTab: DEFAULT_STATE.lastActiveTab,
    quickFilter: DEFAULT_STATE.quickFilter,
    devInlineFixtureEnabled: DEFAULT_STATE.devInlineFixtureEnabled,
    selectionModel: {
      ...createEmptySelectionModel(),
      mode: 'query',
      materializedPaths: materializedPathSet,
      materializedAt: new Date().toISOString(),
      queryDescriptor: descriptor,
    },
    querySelectionManifest: null,
    viewFilterPresetId: DEFAULT_STATE.viewFilterPresetId,
    isFiltersExpanded: DEFAULT_STATE.isFiltersExpanded,
  };

  return {
    state: serializeState(state),
    version: FILE_EXPLORER_STORAGE_VERSION,
  };
}

export async function seedRestoredExplicitSelectionState(args: {
  electronHarness: {
    ensureContext: () => Promise<{
      app: ElectronApplication;
      window: Page;
    }>;
  };
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
  const { closeElectronApp } = await loadElectronHelpers();

  await closeElectronApp(currentContext);

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
    'file-explorer-storage-v4': JSON.stringify(persistedState),
  };

  await writeFile(storagePath, JSON.stringify(nextStorage, null, 2), 'utf8');
}

export async function seedRestoredQuerySelectionState(args: {
  coveredDirectoryPaths: string[];
  electronHarness: {
    ensureContext: () => Promise<{
      app: ElectronApplication;
      window: Page;
    }>;
  };
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
    expandedDirectoryPaths,
    excludeFilters,
    excludedPaths,
    includeFilters,
    includedPaths,
    manifestSnapshotId,
    materializedPaths,
    rootPath,
    selectionRootPath,
  });
  const currentContext = await electronHarness.ensureContext();
  const userDataDir = await currentContext.app.evaluate(async ({ app }) => app.getPath('userData'));
  const { closeElectronApp } = await loadElectronHelpers();

  await closeElectronApp(currentContext);

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
    'file-explorer-storage-v4': JSON.stringify(persistedState),
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
  electronHarness: {
    ensureContext: () => Promise<{
      app: ElectronApplication;
      window: Page;
    }>;
  };
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
    electronHarness: args.electronHarness,
    rootPath,
    selectionRootPath: `${rootPath}/src`,
    expandedDirectoryPaths: [
      '/Users',
      '/Users/seandearnaley',
      '/Users/seandearnaley/Documents',
      '/Users/seandearnaley/Documents/GitHub',
      rootPath,
      `${rootPath}/src`,
    ],
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
    includeFilters: ['*.tsx', '*.ts', '*.js', '*.jsx', '*.json'],
    excludeFilters: [
      '.aider*',
      'node_modules',
      '.next',
      'coverage',
      'test-results',
      'playwright-report',
    ],
    manifestSnapshotId,
    materializedPaths,
  });
}

export async function seedSelectionSnapshotRows(args: {
  electronHarness: {
    ensureContext: () => Promise<{
      app: ElectronApplication;
      window: Page;
    }>;
  };
  filePaths: string[];
  snapshotId: string;
}): Promise<void> {
  const { electronHarness, filePaths, snapshotId } = args;
  const currentContext = await electronHarness.ensureContext();

  await currentContext.window.evaluate(
    async ({ filePaths: nextFilePaths, snapshotId: nextSnapshotId }) => {
      const api = (
        window as Window & {
          electronAPI?: {
            db?: {
              query?: (sql: string, params?: unknown[]) => Promise<{ rows?: unknown[] }>;
            };
          };
        }
      ).electronAPI;

      if (!api?.db?.query) {
        throw new Error('Electron db.query bridge is not available');
      }

      await api.db.query('DELETE FROM selection_snapshot_files');
      await api.db.query('DELETE FROM selection_snapshots');
      await api.db.query(
        `INSERT INTO selection_snapshots (id, expires_at)
         VALUES ($1, NOW() + (24 * INTERVAL '1 hour'))`,
        [nextSnapshotId]
      );
      await api.db.query(
        `INSERT INTO selection_snapshot_files (snapshot_id, file_path)
         SELECT $1, UNNEST($2::text[])`,
        [nextSnapshotId, nextFilePaths]
      );
    },
    {
      filePaths,
      snapshotId,
    }
  );
}

export async function installNestedFolderFixture(
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
        // biome-ignore lint/style/useNamingConvention: Desktop E2E fixture global intentionally uses the app-owned key.
        __brainstrike_e2e_file_system_fixture__?: ElectronE2eFileSystemFixture | undefined;
      }
    ).__brainstrike_e2e_file_system_fixture__ = nextFixture;
  }, fixture);
}

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
    name: args.name,
    path: args.path,
    type: 'directory' as const,
    size: 0,
    depth: args.depth,
    selectionState: 'unchecked' as const,
    rootFolderId: args.rootFolderId,
    isVisible: true,
    children: [],
    handle: {
      kind: 'directory' as const,
      name: args.name,
      path: args.path,
      platform: 'electron' as const,
    },
  });

  const createFileEntry = (args: {
    depth: number;
    name: string;
    path: string;
    rootFolderId: string;
  }) => ({
    name: args.name,
    path: args.path,
    type: 'file' as const,
    size: 100,
    depth: args.depth,
    selectionState: 'unchecked' as const,
    rootFolderId: args.rootFolderId,
    isVisible: true,
    handle: {
      kind: 'file' as const,
      name: args.name,
      path: args.path,
      platform: 'electron' as const,
    },
  });

  directoriesByPath[rootPath] = Array.from({ length: 30 }, (_, rootIndex) =>
    createDirectoryEntry({
      depth: 0,
      name: `folder-${rootIndex}`,
      path: `${rootPath}/folder-${rootIndex}`,
      rootFolderId: rootPath,
    })
  );

  for (let rootIndex = 0; rootIndex < 30; rootIndex += 1) {
    const directoryPath = `${rootPath}/folder-${rootIndex}`;
    directoriesByPath[directoryPath] = Array.from({ length: 8 }, (_, childIndex) =>
      createDirectoryEntry({
        depth: 1,
        name: `child-${rootIndex}-${childIndex}`,
        path: `${directoryPath}/child-${rootIndex}-${childIndex}`,
        rootFolderId: rootPath,
      })
    );

    for (let childIndex = 0; childIndex < 8; childIndex += 1) {
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
          name: 'hooks',
          path: `${rootPath}/hooks`,
          type: 'directory' as const,
          size: 0,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          children: [],
          handle: {
            kind: 'directory' as const,
            name: 'hooks',
            path: `${rootPath}/hooks`,
            platform: 'electron' as const,
          },
        },
      ],
      [`${rootPath}/hooks`]: [
        {
          name: 'src',
          path: `${rootPath}/hooks/src`,
          type: 'directory' as const,
          size: 0,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          children: [],
          handle: {
            kind: 'directory' as const,
            name: 'src',
            path: `${rootPath}/hooks/src`,
            platform: 'electron' as const,
          },
        },
        {
          name: 'package.json',
          path: `${rootPath}/hooks/package.json`,
          type: 'file' as const,
          size: 80,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'package.json',
            path: `${rootPath}/hooks/package.json`,
            platform: 'electron' as const,
          },
        },
        {
          name: 'tsconfig.json',
          path: `${rootPath}/hooks/tsconfig.json`,
          type: 'file' as const,
          size: 80,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'tsconfig.json',
            path: `${rootPath}/hooks/tsconfig.json`,
            platform: 'electron' as const,
          },
        },
      ],
      [`${rootPath}/hooks/src`]: [
        {
          name: '__tests__',
          path: `${rootPath}/hooks/src/__tests__`,
          type: 'directory' as const,
          size: 0,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          children: [],
          handle: {
            kind: 'directory' as const,
            name: '__tests__',
            path: `${rootPath}/hooks/src/__tests__`,
            platform: 'electron' as const,
          },
        },
        {
          name: 'create-debounce.ts',
          path: `${rootPath}/hooks/src/create-debounce.ts`,
          type: 'file' as const,
          size: 100,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'create-debounce.ts',
            path: `${rootPath}/hooks/src/create-debounce.ts`,
            platform: 'electron' as const,
          },
        },
        {
          name: 'index.ts',
          path: `${rootPath}/hooks/src/index.ts`,
          type: 'file' as const,
          size: 120,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'index.ts',
            path: `${rootPath}/hooks/src/index.ts`,
            platform: 'electron' as const,
          },
        },
      ],
      [`${rootPath}/hooks/src/__tests__`]: [
        {
          name: 'use-file-filters.test.ts',
          path: `${rootPath}/hooks/src/__tests__/use-file-filters.test.ts`,
          type: 'file' as const,
          size: 90,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: rootPath,
          isVisible: true,
          handle: {
            kind: 'file' as const,
            name: 'use-file-filters.test.ts',
            path: `${rootPath}/hooks/src/__tests__/use-file-filters.test.ts`,
            platform: 'electron' as const,
          },
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
