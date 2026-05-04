import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FileExplorerState } from '@brainstrike/types';
import { createEmptySelectionModel, DEFAULT_STATE } from '@brainstrike/types';
import type { ElectronApplication, Locator, Page } from 'playwright';
import { FILE_EXPLORER_STORAGE_VERSION } from '../../../packages/file-explorer/src/persistence/persistence-constants.ts';
import { serializeState } from '../../../packages/file-explorer/src/persistence/state-serialization.ts';
import { buildQuerySelectionFingerprint } from '../../../packages/file-explorer/src/utils/query-selection-manifest.ts';
import { expect, test } from './fixtures/electron-fixture';
import {
  getContextExplorerLeftPanel,
  getContextExplorerMiddlePanel,
} from './utils/context-explorer-locators';
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

async function ensureLeftPanelVisible(page: Page): Promise<void> {
  const leftPanel = getContextExplorerLeftPanel(page);
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

async function expandDirectoryIfNeeded(args: {
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
  await expandButton.click({ noWaitAfter: true, timeout: 5000 });
}

async function setFileExplorerMaxSelectionCount(
  page: Page,
  maxSelectionCount: number
): Promise<void> {
  const selectionSettingsButton = getContextExplorerLeftPanel(page).getByRole('button', {
    name: 'Selection settings',
  });
  await expect(selectionSettingsButton).toBeVisible({ timeout: 15_000 });
  await selectionSettingsButton.click({ timeout: 5000 });

  const selectionCountInput = page.getByLabel('Maximum selection count input');
  await expect(selectionCountInput).toBeVisible({ timeout: 15_000 });
  await selectionCountInput.fill(String(maxSelectionCount));
  await selectionCountInput.press('Enter');
  await expect(page.getByTestId('selection-max')).toHaveText(String(maxSelectionCount), {
    timeout: 15_000,
  });
}

async function expectContextExplorerFileVisibility(args: {
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

async function getExpandedDirectoryCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const fileExplorerStore = (
      window as Window & {
        __brainstrike_file_explorer_provider_store__?: {
          getState?: () => { expandedDirectoryPaths?: Set<string> };
        };
      }
    ).__brainstrike_file_explorer_provider_store__;
    return fileExplorerStore?.getState?.().expandedDirectoryPaths?.size ?? 0;
  });
}

function createBaseExplorerState(rootPath: string): FileExplorerState {
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

function createRestoredExplicitSelectionSnapshot(args: {
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

async function seedRestoredExplicitSelectionState(args: {
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

async function seedRestoredQuerySelectionState(args: {
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

async function seedLive3dmolRestoreState(args: {
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

async function seedSelectionSnapshotRows(args: {
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

async function installWideExpandAllFixture(
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

async function installMixedHookSelectionFixture(
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

  test('expand all progressively reveals directories and leaves a valid tree after cancel or completion', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(60_000);

    await installWideExpandAllFixture(electronApp.app, '/mock/desktop-expand-all-progressive');
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ timeout: 5000 });

    await expect(window.getByRole('treegrid', { name: 'File tree' })).toBeVisible({
      timeout: 15_000,
    });
    const initialExpandedCount = await getExpandedDirectoryCount(window);
    const expandAllButton = window.getByTestId('expand-all-button-small');
    await expect(expandAllButton).toBeVisible({ timeout: 15_000 });
    await expandAllButton.click({ timeout: 5000 });

    const cancelButton = window.getByRole('button', { name: 'Cancel operation' });
    await expect(cancelButton).toBeVisible({ timeout: 15_000 });
    await window.waitForFunction((previousExpandedCount) => {
      const testWindow = (
        globalThis as typeof globalThis & {
          window?: Window & {
            __brainstrike_file_explorer_provider_store__?: {
              getState?: () => { expandedDirectoryPaths?: Set<string> };
            };
          };
        }
      ).window;
      const expandedDirectoryCount =
        testWindow?.__brainstrike_file_explorer_provider_store__?.getState?.()
          .expandedDirectoryPaths?.size ?? 0;
      return expandedDirectoryCount > previousExpandedCount;
    }, initialExpandedCount);
    await expect(expandAllButton).toBeDisabled();

    await cancelButton.click({ timeout: 5000 }).catch(async (error: unknown) => {
      const operationStillRunning = await window
        .getByTestId('inline-scanning-indicator')
        .isVisible()
        .catch(() => false);
      if (operationStillRunning) {
        throw error;
      }
    });

    await expect(window.getByTestId('inline-scanning-indicator')).not.toBeVisible({
      timeout: 15_000,
    });
    await expect(expandAllButton).toBeEnabled();
    expect(await getExpandedDirectoryCount(window)).toBeGreaterThan(initialExpandedCount);
  });

  test('unchecking a selected folder removes its files from the context explorer on desktop', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    await installNestedFolderFixture(electronApp.app, '/mock/desktop-context-deselect');
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ timeout: 5000 });

    const contextExplorerSurface = getContextExplorerMiddlePanel(window);
    await expect(contextExplorerSurface).toBeVisible({ timeout: 15_000 });
    await expect(window.getByText('3 files', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expectContextExplorerFileVisibility({
      fileName: 'index.ts',
      page: window,
      visible: true,
    });
    await expectContextExplorerFileVisibility({
      fileName: 'extra.ts',
      page: window,
      visible: true,
    });
    await expectContextExplorerFileVisibility({
      fileName: 'mock-file1.ts',
      page: window,
      visible: true,
    });

    const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
    await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
    await srcCheckbox.click({ timeout: 5000 });

    await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(window.getByText('1 files', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expectContextExplorerFileVisibility({
      fileName: 'mock-file1.ts',
      page: window,
      visible: true,
    });
    await expectContextExplorerFileVisibility({
      fileName: 'index.ts',
      page: window,
      visible: false,
    });
    await expectContextExplorerFileVisibility({
      fileName: 'extra.ts',
      page: window,
      visible: false,
    });
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

  test('root Select All keeps expanded folders fully checked when all descendants are selected', async ({
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
    await setFileExplorerMaxSelectionCount(window, 10);

    const packagesCheckbox = fileTree.getByRole('checkbox', { name: 'Select packages' });
    await expect(packagesCheckbox).toHaveAttribute('data-state', 'unchecked');

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ timeout: 5000 });

    await expect(window.getByRole('button', { name: /^Deselect All$/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(packagesCheckbox).toHaveAttribute('data-state', 'checked');

    const expandButtons = window.locator('button[aria-label="Expand"]');
    await expect(expandButtons).toHaveCount(2, { timeout: 15_000 });
    await expandButtons.nth(1).click({ timeout: 5000 });

    await expect(fileTree.getByText('agent')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('app-shell')).toBeVisible({ timeout: 15_000 });
    await expect(packagesCheckbox).toHaveAttribute('data-state', 'checked');
    await expect(fileTree.getByRole('checkbox', { name: 'Select agent' })).toHaveAttribute(
      'data-state',
      'checked'
    );
    await expect(fileTree.getByRole('checkbox', { name: 'Select app-shell' })).toHaveAttribute(
      'data-state',
      'checked'
    );
  });

  test('clicking a checked query-selected folder checkbox deselects it instead of re-running recursive selection', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    const rootPath = '/mock/desktop-selection-root-toggle';
    await installMixedHookSelectionFixture(electronApp.app, rootPath);
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await setFileExplorerMaxSelectionCount(window, 10);

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ timeout: 5000 });

    const hooksCheckbox = fileTree.getByRole('checkbox', { name: 'Select hooks' });
    const expandButtons = window.locator('button[aria-label="Expand"]');
    await expect(expandButtons).toHaveCount(1, { timeout: 15_000 });
    await expandButtons.first().click({ timeout: 5000 });

    await expect(fileTree.getByText('src')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('package.json')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('tsconfig.json')).toBeVisible({ timeout: 15_000 });

    const srcExpandButton = window.locator('button[aria-label="Expand"]').first();
    await expect(srcExpandButton).toBeVisible({ timeout: 15_000 });
    await srcExpandButton.click({ timeout: 5000 });

    await expect(fileTree.getByText('__tests__')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('create-debounce.ts')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('index.ts')).toBeVisible({ timeout: 15_000 });

    const testsExpandButton = window.locator('button[aria-label="Expand"]').first();
    await expect(testsExpandButton).toBeVisible({ timeout: 15_000 });
    await testsExpandButton.click({ timeout: 5000 });

    await expect(fileTree.getByText('use-file-filters.test.ts')).toBeVisible({
      timeout: 15_000,
    });
    await expect(hooksCheckbox).toHaveAttribute('data-state', 'checked');

    await hooksCheckbox.click({ timeout: 5000 });

    await expect(hooksCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(fileTree.getByRole('checkbox', { name: 'Select src' })).toHaveAttribute(
      'data-state',
      'unchecked'
    );
    await expect(fileTree.getByRole('checkbox', { name: 'Select __tests__' })).toHaveAttribute(
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

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await setFileExplorerMaxSelectionCount(window, 10);

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

  test('clicking an indeterminate parent folder clears all selected descendants', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    const rootPath = '/mock/desktop-selection-root-e2e-deselect';
    await installIncrementalFolderSelectionFixture(electronApp.app, rootPath);
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await setFileExplorerMaxSelectionCount(window, 10);

    const expandButtons = window.locator('button[aria-label="Expand"]');
    await expect(expandButtons).toHaveCount(1, { timeout: 15_000 });
    await expandButtons.first().click({ timeout: 5000 });

    await expect(fileTree.getByText('page-objects')).toBeVisible({ timeout: 15_000 });

    const e2eCheckbox = fileTree.getByRole('checkbox', { name: 'Select e2e' });
    const pageObjectsCheckbox = fileTree.getByRole('checkbox', { name: 'Select page-objects' });
    const typesCheckbox = fileTree.getByRole('checkbox', { name: 'Select types' });
    const utilsCheckbox = fileTree.getByRole('checkbox', { name: 'Select utils' });

    await pageObjectsCheckbox.click({ timeout: 5000 });
    await expect(window.getByText('2/10')).toBeVisible({ timeout: 15_000 });
    await expect(e2eCheckbox).toHaveAttribute('data-state', 'indeterminate');

    await e2eCheckbox.click({ timeout: 5000 });

    await expect(window.getByTestId('selection-count')).toHaveText('0', { timeout: 15_000 });
    await expect(e2eCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(pageObjectsCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(typesCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(utilsCheckbox).toHaveAttribute('data-state', 'unchecked');
  });

  test('promotes explicit mixed file-and-folder parents to checked as files are selected one by one', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    const rootPath = '/mock/desktop-selection-root-hooks-explicit';
    await installMixedHookSelectionFixture(electronApp.app, rootPath);
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await setFileExplorerMaxSelectionCount(window, 10);

    const hooksExpandButton = window.locator('button[aria-label="Expand"]').first();
    await expect(hooksExpandButton).toBeVisible({ timeout: 15_000 });
    await hooksExpandButton.click({ timeout: 5000 });

    const srcExpandButton = window.locator('button[aria-label="Expand"]').first();
    await expect(srcExpandButton).toBeVisible({ timeout: 15_000 });
    await srcExpandButton.click({ timeout: 5000 });

    const testsExpandButton = window.locator('button[aria-label="Expand"]').first();
    await expect(testsExpandButton).toBeVisible({ timeout: 15_000 });
    await testsExpandButton.click({ timeout: 5000 });

    const hooksCheckbox = fileTree.getByRole('checkbox', { name: 'Select hooks' });
    const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
    const testsCheckbox = fileTree.getByRole('checkbox', { name: 'Select __tests__' });

    await expect(hooksCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
    await expect(testsCheckbox).toHaveAttribute('data-state', 'unchecked');

    await fileTree.getByRole('checkbox', { name: 'Select package.json' }).click({ timeout: 5000 });
    await fileTree.getByRole('checkbox', { name: 'Select tsconfig.json' }).click({ timeout: 5000 });
    await fileTree
      .getByRole('checkbox', { name: 'Select create-debounce.ts' })
      .click({ timeout: 5000 });
    await fileTree.getByRole('checkbox', { name: 'Select index.ts' }).click({ timeout: 5000 });
    await fileTree
      .getByRole('checkbox', { name: 'Select use-file-filters.test.ts' })
      .click({ timeout: 5000 });

    await expect(testsCheckbox).toHaveAttribute('data-state', 'checked');
    await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
    await expect(hooksCheckbox).toHaveAttribute('data-state', 'checked');
  });

  test('root Select All marks mixed file-and-folder query-selected parents checked after expansion', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(45_000);

    const rootPath = '/mock/desktop-selection-root-hooks';
    await installMixedHookSelectionFixture(electronApp.app, rootPath);
    await ensureLeftPanelVisible(window);

    const selectRootButton = window.getByTestId('select-root-button');
    await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
    await selectRootButton.click({ timeout: 5000 });

    const fileTree = window.getByRole('treegrid', { name: 'File tree' });
    await expect(fileTree).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('hooks')).toBeVisible({ timeout: 15_000 });
    await setFileExplorerMaxSelectionCount(window, 10);

    const selectAllButton = window.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ timeout: 5000 });

    const hooksCheckbox = fileTree.getByRole('checkbox', { name: 'Select hooks' });
    await expect(hooksCheckbox).toHaveAttribute('data-state', 'checked');

    const expandButtons = fileTree.getByRole('button', { name: 'Expand' });
    await expect(expandButtons).toHaveCount(1, { timeout: 15_000 });
    await clickExpandButton(expandButtons.first());

    await expect(fileTree.getByText('src')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('package.json')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('tsconfig.json')).toBeVisible({ timeout: 15_000 });

    const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
    await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');

    const srcExpandButton = fileTree.getByRole('button', { name: 'Expand' }).first();
    await clickExpandButton(srcExpandButton);

    await expect(fileTree.getByText('__tests__')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('create-debounce.ts')).toBeVisible({ timeout: 15_000 });
    await expect(fileTree.getByText('index.ts')).toBeVisible({ timeout: 15_000 });

    await expect(fileTree.getByRole('checkbox', { name: 'Select __tests__' })).toHaveAttribute(
      'data-state',
      'checked'
    );
    await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
    await expect(hooksCheckbox).toHaveAttribute('data-state', 'checked');
  });

  test('restored explicit folders can be deselected and reselected after app restart', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-tree-restore-'));

    try {
      await mkdir(path.join(rootPath, 'hooks/src/__tests__'), { recursive: true });
      await writeFile(path.join(rootPath, 'hooks/package.json'), '{"name":"hooks"}');
      await writeFile(path.join(rootPath, 'hooks/src/create-debounce.ts'), 'export const x = 1;');
      await writeFile(path.join(rootPath, 'hooks/src/index.ts'), 'export const y = 1;');
      await writeFile(
        path.join(rootPath, 'hooks/src/__tests__/use-file-filters.test.ts'),
        'export const z = 1;'
      );

      await seedRestoredExplicitSelectionState({
        electronHarness,
        rootPath,
        expandedDirectoryPaths: [
          path.join(rootPath, 'hooks'),
          path.join(rootPath, 'hooks/src'),
          path.join(rootPath, 'hooks/src/__tests__'),
        ],
        selectedFilePaths: [
          path.join(rootPath, 'hooks/package.json'),
          path.join(rootPath, 'hooks/src/create-debounce.ts'),
          path.join(rootPath, 'hooks/src/index.ts'),
          path.join(rootPath, 'hooks/src/__tests__/use-file-filters.test.ts'),
        ],
      });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureLeftPanelVisible(restartedWindow);
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('4', {
        timeout: 15_000,
      });

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      await expect(fileTree).toBeVisible({ timeout: 15_000 });
      const hooksCheckbox = fileTree.getByRole('checkbox', { name: 'Select hooks' });
      const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
      const testsCheckbox = fileTree.getByRole('checkbox', { name: 'Select __tests__' });

      await expect(fileTree.getByText('hooks')).toBeVisible({ timeout: 15_000 });
      await expect(hooksCheckbox).toHaveAttribute('data-state', 'checked');

      await hooksCheckbox.click({ timeout: 5000 });

      await expect(hooksCheckbox).toHaveAttribute('data-state', 'unchecked');

      await hooksCheckbox.click({ timeout: 5000 });

      await expect(hooksCheckbox).toHaveAttribute('data-state', 'checked');

      await expandDirectoryIfNeeded({
        directoryName: 'hooks',
        expectedChildText: 'src',
        fileTree,
        page: restartedWindow,
      });
      await expect(fileTree.getByText('package.json')).toBeVisible({ timeout: 15_000 });

      await expandDirectoryIfNeeded({
        directoryName: 'src',
        expectedChildText: 'create-debounce.ts',
        fileTree,
        page: restartedWindow,
      });
      await expect(fileTree.getByText('index.ts')).toBeVisible({ timeout: 15_000 });
      await expect(fileTree.getByText('__tests__')).toBeVisible({ timeout: 15_000 });

      await expandDirectoryIfNeeded({
        directoryName: '__tests__',
        expectedChildText: 'use-file-filters.test.ts',
        fileTree,
        page: restartedWindow,
      });

      await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(testsCheckbox).toHaveAttribute('data-state', 'checked');
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  test('restored partial explicit selection remains interactive after app restart', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-tree-restore-partial-'));

    try {
      await mkdir(path.join(rootPath, 'src/components'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/hooks'), { recursive: true });
      await mkdir(path.join(rootPath, 'docs'), { recursive: true });
      await writeFile(path.join(rootPath, 'src/main.tsx'), 'export const main = 1;');
      await writeFile(path.join(rootPath, 'src/vite-env.d.ts'), 'declare const viteEnv: string;');
      await writeFile(path.join(rootPath, 'src/App.tsx'), 'export const App = () => null;');
      await writeFile(
        path.join(rootPath, 'src/components/viewer.tsx'),
        'export const Viewer = () => null;'
      );
      await writeFile(
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        'export const useViewer = () => null;'
      );
      await writeFile(path.join(rootPath, 'docs/guide.ts'), 'export const guide = 1;');

      await seedRestoredExplicitSelectionState({
        electronHarness,
        rootPath,
        expandedDirectoryPaths: [path.join(rootPath, 'src')],
        selectedFilePaths: [
          path.join(rootPath, 'src/main.tsx'),
          path.join(rootPath, 'src/vite-env.d.ts'),
        ],
      });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureLeftPanelVisible(restartedWindow);
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('2', {
        timeout: 15_000,
      });

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      await expect(fileTree).toBeVisible({ timeout: 15_000 });
      await expandDirectoryIfNeeded({
        directoryName: path.basename(rootPath),
        expectedChildText: 'src',
        fileTree,
        page: restartedWindow,
      });

      const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
      const docsCheckbox = fileTree.getByRole('checkbox', { name: 'Select docs' });
      const mainCheckbox = fileTree.getByRole('checkbox', { name: 'Select main.tsx' });
      const viteCheckbox = fileTree.getByRole('checkbox', { name: 'Select vite-env.d.ts' });
      const appCheckbox = fileTree.getByRole('checkbox', { name: 'Select App.tsx' });

      await expect(srcCheckbox).toHaveAttribute('data-state', 'indeterminate');
      await expect(mainCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(viteCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(appCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expectContextExplorerFileVisibility({
        fileName: 'main.tsx',
        page: restartedWindow,
        visible: true,
      });
      await expectContextExplorerFileVisibility({
        fileName: 'vite-env.d.ts',
        page: restartedWindow,
        visible: true,
      });

      await mainCheckbox.click({ timeout: 5000 });
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('1', {
        timeout: 15_000,
      });
      await expect(mainCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(srcCheckbox).toHaveAttribute('data-state', 'indeterminate');
      await expectContextExplorerFileVisibility({
        fileName: 'vite-env.d.ts',
        page: restartedWindow,
        visible: true,
      });
      await expectContextExplorerFileVisibility({
        fileName: 'main.tsx',
        page: restartedWindow,
        visible: false,
      });

      await appCheckbox.click({ timeout: 5000 });
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('2', {
        timeout: 15_000,
      });
      await expect(appCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(srcCheckbox).toHaveAttribute('data-state', 'indeterminate');
      await expectContextExplorerFileVisibility({
        fileName: 'App.tsx',
        page: restartedWindow,
        visible: true,
      });

      await srcCheckbox.click({ timeout: 5000 });
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('0', {
        timeout: 15_000,
      });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expectContextExplorerFileVisibility({
        fileName: 'main.tsx',
        page: restartedWindow,
        visible: false,
      });
      await expectContextExplorerFileVisibility({
        fileName: 'vite-env.d.ts',
        page: restartedWindow,
        visible: false,
      });
      await expectContextExplorerFileVisibility({
        fileName: 'App.tsx',
        page: restartedWindow,
        visible: false,
      });

      await srcCheckbox.click({ timeout: 5000 });
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('5', {
        timeout: 15_000,
      });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
      await expectContextExplorerFileVisibility({
        fileName: 'main.tsx',
        page: restartedWindow,
        visible: true,
      });
      await expectContextExplorerFileVisibility({
        fileName: 'vite-env.d.ts',
        page: restartedWindow,
        visible: true,
      });
      await expectContextExplorerFileVisibility({
        fileName: 'App.tsx',
        page: restartedWindow,
        visible: true,
      });

      await srcCheckbox.click({ timeout: 5000 });
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('0', {
        timeout: 15_000,
      });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');

      await docsCheckbox.click({ timeout: 5000 });
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('1', {
        timeout: 15_000,
      });
      await expect(docsCheckbox).toHaveAttribute('data-state', 'checked');

      await docsCheckbox.click({ timeout: 5000 });
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('0', {
        timeout: 15_000,
      });
      await expect(docsCheckbox).toHaveAttribute('data-state', 'unchecked');
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  test('restored filtered query selections remain interactive before the manifest snapshot loads', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-tree-restore-query-'));

    try {
      await mkdir(path.join(rootPath, 'public'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/components'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/hooks'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/types'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/utils'), { recursive: true });

      await writeFile(path.join(rootPath, 'public/config.json'), '{"public":true}');
      await writeFile(path.join(rootPath, 'src/App.tsx'), 'export const App = () => null;');
      await writeFile(path.join(rootPath, 'src/main.tsx'), 'export const main = 1;');
      await writeFile(path.join(rootPath, 'src/vite-env.d.ts'), 'declare const viteEnv: string;');
      await writeFile(
        path.join(rootPath, 'src/components/molecule-viewer.tsx'),
        'export const MoleculeViewer = () => null;'
      );
      await writeFile(
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        'export const useViewer = () => null;'
      );
      await writeFile(path.join(rootPath, 'src/types/viewer.d.ts'), 'export type Viewer = string;');
      await writeFile(path.join(rootPath, 'src/utils/viewer.ts'), 'export const viewer = 1;');

      const materializedPaths = [
        path.join(rootPath, 'src/App.tsx'),
        path.join(rootPath, 'src/main.tsx'),
        path.join(rootPath, 'src/vite-env.d.ts'),
        path.join(rootPath, 'src/components/molecule-viewer.tsx'),
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        path.join(rootPath, 'src/types/viewer.d.ts'),
        path.join(rootPath, 'src/utils/viewer.ts'),
      ];

      await seedRestoredQuerySelectionState({
        electronHarness,
        rootPath,
        selectionRootPath: path.join(rootPath, 'src'),
        expandedDirectoryPaths: [
          rootPath,
          path.join(rootPath, 'src'),
          path.join(rootPath, 'src/components'),
          path.join(rootPath, 'src/hooks'),
          path.join(rootPath, 'src/types'),
          path.join(rootPath, 'src/utils'),
        ],
        coveredDirectoryPaths: [
          path.join(rootPath, 'src'),
          path.join(rootPath, 'src/components'),
          path.join(rootPath, 'src/hooks'),
          path.join(rootPath, 'src/types'),
          path.join(rootPath, 'src/utils'),
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
        materializedPaths,
      });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureLeftPanelVisible(restartedWindow);

      await expect(restartedWindow.getByTestId('selection-count')).toHaveText(
        String(materializedPaths.length),
        {
          timeout: 15_000,
        }
      );

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      await expect(fileTree).toBeVisible({ timeout: 15_000 });

      const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
      const componentsCheckbox = fileTree.getByRole('checkbox', { name: 'Select components' });
      const publicCheckbox = fileTree.getByRole('checkbox', { name: 'Select public' });

      await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(componentsCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(publicCheckbox).toHaveAttribute('data-state', 'unchecked');

      await srcCheckbox.click({ timeout: 5000 });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(componentsCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('0', {
        timeout: 15_000,
      });

      await srcCheckbox.click({ timeout: 5000 });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(componentsCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText(
        String(materializedPaths.length),
        {
          timeout: 15_000,
        }
      );

      await componentsCheckbox.click({ timeout: 5000 });
      await expect(componentsCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText(
        String(materializedPaths.length - 1),
        {
          timeout: 15_000,
        }
      );

      await publicCheckbox.click({ timeout: 5000 });
      await expect(publicCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText(
        String(materializedPaths.length),
        {
          timeout: 15_000,
        }
      );
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  test('restored query selections compute token totals from materialized descendants', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-tree-restore-query-tokens-')
    );

    try {
      await mkdir(path.join(rootPath, 'src/components'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/hooks'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/utils'), { recursive: true });

      await writeFile(path.join(rootPath, 'src/App.tsx'), 'export const App = () => null;');
      await writeFile(
        path.join(rootPath, 'src/components/molecule-viewer.tsx'),
        'export const MoleculeViewer = () => null;'
      );
      await writeFile(
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        'export const useViewer = () => null;'
      );
      await writeFile(path.join(rootPath, 'src/utils/viewer.ts'), 'export const viewer = 1;');

      const materializedPaths = [
        path.join(rootPath, 'src/App.tsx'),
        path.join(rootPath, 'src/components/molecule-viewer.tsx'),
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        path.join(rootPath, 'src/utils/viewer.ts'),
      ];

      await seedRestoredQuerySelectionState({
        electronHarness,
        rootPath,
        selectionRootPath: path.join(rootPath, 'src'),
        expandedDirectoryPaths: [rootPath],
        coveredDirectoryPaths: [
          path.join(rootPath, 'src'),
          path.join(rootPath, 'src/components'),
          path.join(rootPath, 'src/hooks'),
          path.join(rootPath, 'src/utils'),
        ],
        includeFilters: ['*.tsx', '*.ts'],
        excludeFilters: [
          '.aider*',
          'node_modules',
          '.next',
          'coverage',
          'test-results',
          'playwright-report',
        ],
        materializedPaths,
      });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureLeftPanelVisible(restartedWindow);

      await expect(restartedWindow.getByTestId('selection-count')).toHaveText(
        String(materializedPaths.length),
        {
          timeout: 15_000,
        }
      );

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      await expect(fileTree).toBeVisible({ timeout: 15_000 });
      await expect(fileTree.getByText('src')).toBeVisible({ timeout: 15_000 });
      await expect(fileTree.getByText('molecule-viewer.tsx')).toBeVisible({ timeout: 15_000 });

      const tokenSummary = restartedWindow.getByText(/[1-9]\d*(?:,\d{3})* output/);
      await expect(tokenSummary).toBeVisible({ timeout: 20_000 });
      await expect(restartedWindow.getByText(/estimating…/)).not.toBeVisible({ timeout: 20_000 });
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  test('restored root-level query-selected folders remain interactive after app restart', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-tree-restore-root-query-'));

    try {
      await mkdir(path.join(rootPath, 'public'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/components'), { recursive: true });
      await mkdir(path.join(rootPath, 'docs'), { recursive: true });

      await writeFile(path.join(rootPath, 'public/config.json'), '{"public":true}');
      await writeFile(path.join(rootPath, 'src/App.tsx'), 'export const App = () => null;');
      await writeFile(
        path.join(rootPath, 'src/components/viewer.tsx'),
        'export const Viewer = () => null;'
      );
      await writeFile(path.join(rootPath, 'docs/guide.ts'), 'export const guide = 1;');

      const materializedPaths = [
        path.join(rootPath, 'public/config.json'),
        path.join(rootPath, 'src/App.tsx'),
        path.join(rootPath, 'src/components/viewer.tsx'),
        path.join(rootPath, 'docs/guide.ts'),
      ];

      await seedRestoredQuerySelectionState({
        electronHarness,
        rootPath,
        selectionRootPath: rootPath,
        expandedDirectoryPaths: [
          rootPath,
          path.join(rootPath, 'public'),
          path.join(rootPath, 'src'),
          path.join(rootPath, 'src/components'),
          path.join(rootPath, 'docs'),
        ],
        coveredDirectoryPaths: [
          rootPath,
          path.join(rootPath, 'public'),
          path.join(rootPath, 'src'),
          path.join(rootPath, 'src/components'),
          path.join(rootPath, 'docs'),
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
        materializedPaths,
      });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureLeftPanelVisible(restartedWindow);

      await expect(restartedWindow.getByTestId('selection-count')).toHaveText(
        String(materializedPaths.length),
        {
          timeout: 15_000,
        }
      );

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      await expect(fileTree).toBeVisible({ timeout: 15_000 });

      const publicCheckbox = fileTree.getByRole('checkbox', { name: 'Select public' });
      const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
      const docsCheckbox = fileTree.getByRole('checkbox', { name: 'Select docs' });

      await expect(publicCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(docsCheckbox).toHaveAttribute('data-state', 'checked');

      await srcCheckbox.click({ timeout: 5000 });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('2', {
        timeout: 15_000,
      });

      await publicCheckbox.click({ timeout: 5000 });
      await expect(publicCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('1', {
        timeout: 15_000,
      });

      await docsCheckbox.click({ timeout: 5000 });
      await expect(docsCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('0', {
        timeout: 15_000,
      });
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  test('restored query selections with manual included paths stay interactive after the post-click settle window', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-tree-restore-root-query-included-')
    );

    try {
      await mkdir(path.join(rootPath, 'src/components'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/hooks'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/types'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/utils'), { recursive: true });

      await writeFile(path.join(rootPath, 'eslint.config.js'), 'export default [];');
      await writeFile(path.join(rootPath, 'src/App.tsx'), 'export const App = () => null;');
      await writeFile(path.join(rootPath, 'src/main.tsx'), 'export const main = 1;');
      await writeFile(path.join(rootPath, 'src/vite-env.d.ts'), 'declare const viteEnv: string;');
      await writeFile(
        path.join(rootPath, 'src/components/molecule-viewer.tsx'),
        'export const MoleculeViewer = () => null;'
      );
      await writeFile(
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        'export const useViewer = () => null;'
      );
      await writeFile(path.join(rootPath, 'src/types/viewer.d.ts'), 'export type Viewer = string;');
      await writeFile(path.join(rootPath, 'src/utils/viewer.ts'), 'export const viewer = 1;');

      const materializedPaths = [
        path.join(rootPath, 'src/App.tsx'),
        path.join(rootPath, 'src/main.tsx'),
        path.join(rootPath, 'src/vite-env.d.ts'),
        path.join(rootPath, 'src/components/molecule-viewer.tsx'),
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        path.join(rootPath, 'src/types/viewer.d.ts'),
        path.join(rootPath, 'src/utils/viewer.ts'),
      ];

      await seedRestoredQuerySelectionState({
        electronHarness,
        rootPath,
        selectionRootPath: path.join(rootPath, 'src'),
        expandedDirectoryPaths: [
          rootPath,
          path.join(rootPath, 'src'),
          path.join(rootPath, 'src/components'),
          path.join(rootPath, 'src/hooks'),
          path.join(rootPath, 'src/types'),
          path.join(rootPath, 'src/utils'),
        ],
        coveredDirectoryPaths: [
          rootPath,
          path.join(rootPath, 'src'),
          path.join(rootPath, 'src/components'),
          path.join(rootPath, 'src/hooks'),
          path.join(rootPath, 'src/types'),
          path.join(rootPath, 'src/utils'),
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
        includedPaths: [path.join(rootPath, 'eslint.config.js')],
        materializedPaths,
      });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureLeftPanelVisible(restartedWindow);

      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('8', {
        timeout: 15_000,
      });

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
      const eslintCheckbox = fileTree.getByRole('checkbox', { name: 'Select eslint.config.js' });

      await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(eslintCheckbox).toHaveAttribute('data-state', 'checked');

      await srcCheckbox.click({ timeout: 5000 });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('1', {
        timeout: 15_000,
      });

      await restartedWindow.waitForTimeout(1200);
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(eslintCheckbox).toHaveAttribute('data-state', 'checked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('1');
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  test('snapshot-backed restored root folders stay interactive after the post-click settle window', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-tree-restore-snapshot-root-')
    );

    try {
      await mkdir(path.join(rootPath, 'src/components'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/hooks'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/types'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/utils'), { recursive: true });

      await writeFile(path.join(rootPath, 'src/App.tsx'), 'export const App = () => null;');
      await writeFile(path.join(rootPath, 'src/main.tsx'), 'export const main = 1;');
      await writeFile(path.join(rootPath, 'src/vite-env.d.ts'), 'declare const viteEnv: string;');
      await writeFile(
        path.join(rootPath, 'src/components/molecule-viewer.tsx'),
        'export const MoleculeViewer = () => null;'
      );
      await writeFile(
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        'export const useViewer = () => null;'
      );
      await writeFile(path.join(rootPath, 'src/types/viewer.d.ts'), 'export type Viewer = string;');
      await writeFile(path.join(rootPath, 'src/utils/viewer.ts'), 'export const viewer = 1;');

      const snapshotId = '11111111-2222-4333-8444-555555555555';
      const materializedPaths = [
        path.join(rootPath, 'src/App.tsx'),
        path.join(rootPath, 'src/main.tsx'),
        path.join(rootPath, 'src/vite-env.d.ts'),
        path.join(rootPath, 'src/components/molecule-viewer.tsx'),
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        path.join(rootPath, 'src/types/viewer.d.ts'),
        path.join(rootPath, 'src/utils/viewer.ts'),
      ];

      await seedSelectionSnapshotRows({
        electronHarness,
        snapshotId,
        filePaths: materializedPaths,
      });

      await seedRestoredQuerySelectionState({
        electronHarness,
        rootPath,
        selectionRootPath: path.join(rootPath, 'src'),
        expandedDirectoryPaths: [
          '/Users',
          '/Users/seandearnaley',
          '/Users/seandearnaley/Documents',
          '/Users/seandearnaley/Documents/GitHub',
          rootPath,
          path.join(rootPath, 'src'),
        ],
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
        includeFilters: ['*.tsx', '*.ts', '*.js', '*.jsx', '*.json'],
        excludeFilters: [
          '.aider*',
          'node_modules',
          '.next',
          'coverage',
          'test-results',
          'playwright-report',
        ],
        manifestSnapshotId: snapshotId,
        materializedPaths,
      });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureLeftPanelVisible(restartedWindow);

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      await expect(fileTree).toBeVisible({ timeout: 15_000 });
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('7', {
        timeout: 15_000,
      });

      const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');

      await srcCheckbox.click({ timeout: 5000 });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('0', {
        timeout: 15_000,
      });

      await restartedWindow.waitForTimeout(1200);
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('0');
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  test('restored snapshot-backed query parents ignore unmatched child directories when computing root checkbox state', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-tree-restore-snapshot-unmatched-child-')
    );

    try {
      await mkdir(path.join(rootPath, 'src/assets'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/components'), { recursive: true });
      await mkdir(path.join(rootPath, 'src/hooks'), { recursive: true });

      await writeFile(path.join(rootPath, 'src/assets/react.svg'), '<svg />');
      await writeFile(path.join(rootPath, 'src/App.tsx'), 'export const App = () => null;');
      await writeFile(path.join(rootPath, 'src/main.tsx'), 'export const main = 1;');
      await writeFile(
        path.join(rootPath, 'src/components/viewer.tsx'),
        'export const Viewer = () => null;'
      );
      await writeFile(
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
        'export const useViewer = () => null;'
      );

      const snapshotId = '22222222-3333-4444-8555-666666666666';
      const materializedPaths = [
        path.join(rootPath, 'src/App.tsx'),
        path.join(rootPath, 'src/main.tsx'),
        path.join(rootPath, 'src/components/viewer.tsx'),
        path.join(rootPath, 'src/hooks/use-viewer.ts'),
      ];

      await seedSelectionSnapshotRows({
        electronHarness,
        snapshotId,
        filePaths: materializedPaths,
      });

      await seedRestoredQuerySelectionState({
        electronHarness,
        rootPath,
        selectionRootPath: path.join(rootPath, 'src'),
        expandedDirectoryPaths: [
          '/Users',
          '/Users/seandearnaley',
          '/Users/seandearnaley/Documents',
          '/Users/seandearnaley/Documents/GitHub',
          rootPath,
          path.join(rootPath, 'src'),
        ],
        coveredDirectoryPaths: [
          '/Users',
          '/Users/seandearnaley',
          '/Users/seandearnaley/Documents',
          '/Users/seandearnaley/Documents/GitHub',
          rootPath,
          path.join(rootPath, 'src'),
          path.join(rootPath, 'src/components'),
          path.join(rootPath, 'src/hooks'),
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
        manifestSnapshotId: snapshotId,
        materializedPaths,
      });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureLeftPanelVisible(restartedWindow);

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      await expect(fileTree).toBeVisible({ timeout: 15_000 });
      const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });

      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('4', {
        timeout: 15_000,
      });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');

      await srcCheckbox.click({ timeout: 5000 });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('0', {
        timeout: 15_000,
      });

      await restartedWindow.waitForTimeout(1200);
      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('0');
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  test('isolated replay of the live 3dmol-react restore state keeps the restored root folder interactive', async ({
    electronHarness,
  }) => {
    test.setTimeout(60_000);

    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-3dmol-restore-'));

    try {
      await seedLive3dmolRestoreState({ electronHarness, rootPath });

      const restartedContext = await electronHarness.restart();
      const restartedWindow = restartedContext.window;
      await ensureLeftPanelVisible(restartedWindow);

      const fileTree = restartedWindow.getByRole('treegrid', { name: 'File tree' });
      await expect(fileTree).toBeVisible({ timeout: 15_000 });
      const srcCheckbox = fileTree.getByRole('checkbox', { name: 'Select src' });

      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('15', {
        timeout: 15_000,
      });
      await expect(srcCheckbox).toHaveAttribute('data-state', 'checked');

      await srcCheckbox.click({ timeout: 5000 });
      await restartedWindow.waitForTimeout(1200);

      await expect(srcCheckbox).toHaveAttribute('data-state', 'unchecked');
      await expect(restartedWindow.getByTestId('selection-count')).toHaveText('0');
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });
});
