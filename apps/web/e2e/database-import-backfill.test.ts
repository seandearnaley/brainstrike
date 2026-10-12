import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/web-fixture';
import { FileExplorerPage } from './page-objects/file-explorer-page';
import { resetAppState } from './utils/app-state';
import {
  expectExplorerImportSelectionCount,
  importSelectedFilesFromExplorer,
} from './utils/explorer-import';
import { ensureRightPanelVisible, waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

interface CollectionSummaryCounts {
  embeddedChunks: number;
  fileCount: number;
  totalChunks: number;
}

interface HeapSnapshot {
  label: string;
  limitMB: number;
  totalMB: number;
  usedMB: number;
}

interface DatabaseImportSnapshot {
  activeCollectionId: string | null;
  isImporting: boolean;
  progress: {
    chunkingProgress: {
      chunksCreated: number;
      currentFile: string;
      filesProcessed: number;
      strategyUsed: string;
      totalFiles: number;
    } | null;
    completed: number;
    current: string;
    errors: Array<{ error: string; file: string }>;
    phase: string;
    total: number;
  } | null;
  recordCount: number;
  selectedFileCount: number;
}

const ROOT_NAME = 'database-import-backfill-root';
const IMPORT_MEMORY_FIXTURE_FILE_COUNT = 80;
const CODE_FILE_TREE: FileTree = {
  'alpha.ts': 'export const alpha = "database import backfill";\nexport const beta = "web flow";',
  'notes.ts':
    'export const notes = ["Database Import Flow", "This fixture ensures the browser import flow creates chunks and embeddings."];',
};
const DOCS_FILE_TREE: FileTree = {
  'README.md':
    '# Database import backfill\n\n## Workflow\n\nUse this fixture to validate semantic markdown chunking.',
  'runbook.md': '# Runbook\n\n## Recovery\n\nDocument chunking should preserve heading families.',
};

function createLargeCodeFixtureTree(fileCount: number): FileTree {
  const tree: FileTree = {};

  for (let index = 0; index < fileCount; index += 1) {
    const folderName = `pkg-${Math.floor(index / 40) + 1}`;
    const folderValue = tree[folderName];
    if (!(folderValue && typeof folderValue === 'object')) {
      tree[folderName] = {};
    }

    const folder = tree[folderName];
    if (!(folder && typeof folder === 'object')) {
      throw new Error(`Expected directory fixture bucket for ${folderName}`);
    }

    folder[`module-${index + 1}.ts`] = [
      `export const moduleId${index} = "module-${index + 1}";`,
      `export function computeValue${index}(input: number): string {`,
      '  const tokens = [',
      `    "module-${index + 1}",`,
      `    "import-memory-diagnostic-${index}",`,
      '    "bounded-batch-processing",',
      '    "chunking-should-not-leak",',
      '    "deterministic-import-flow",',
      '  ];',
      `  return tokens.map((token, tokenIndex) => \`\${token}:\${input + tokenIndex}\`).join("\\n");`,
      '}',
      `export const summary${index} = Array.from({ length: 24 }, (_, itemIndex) => computeValue${index}(itemIndex)).join("\\n");`,
    ].join('\n');
  }

  return tree;
}

function parseCollectionSummaryCounts(summaryText: string): CollectionSummaryCounts {
  const normalized = summaryText.replace(/\s+/g, ' ').trim();
  const match = normalized.match(
    /(\d+)\s+files?.*?(\d+)\s+chunks?.*?(\d+)\s*\/\s*(\d+)\s+embedded/i
  );

  if (!match) {
    throw new Error(`Unable to parse collection summary counts from: ${summaryText}`);
  }

  return {
    embeddedChunks: Number(match[3]),
    fileCount: Number(match[1]),
    totalChunks: Number(match[2]),
  };
}

async function getCollectionSummaryText(page: Page, collectionName: string): Promise<string> {
  const databasePanel = page.getByTestId('database-demo-panel');
  const collectionList = databasePanel.getByRole('listbox', { name: 'Search Collection' });
  await expect(collectionList).toBeVisible({ timeout: 15_000 });
  const option = collectionList.getByRole('option').filter({ hasText: collectionName }).first();
  await expect(option).toBeVisible({ timeout: 15_000 });
  return await option.innerText();
}

async function enableDatabaseDemoTestHooks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as Window & { desktopLifecycle?: { isTestMode: boolean } }).desktopLifecycle = {
      isTestMode: true,
    };
  });
}

async function readDatabaseImportSnapshot(page: Page): Promise<DatabaseImportSnapshot | null> {
  return await page.evaluate(() => {
    const hooks = (
      window as Window & {
        __brainstrikeDatabaseDemoTestHooks__?: {
          getImportSnapshot: () => DatabaseImportSnapshot;
        };
      }
    ).__brainstrikeDatabaseDemoTestHooks__;

    return hooks?.getImportSnapshot() ?? null;
  });
}

async function waitForDatabaseImportSnapshot(
  page: Page,
  predicate: (snapshot: DatabaseImportSnapshot) => boolean,
  timeoutMs = 240_000
): Promise<DatabaseImportSnapshot> {
  const startedAt = Date.now();
  let lastSnapshot: DatabaseImportSnapshot | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastSnapshot = await readDatabaseImportSnapshot(page);
    if (lastSnapshot && predicate(lastSnapshot)) {
      return lastSnapshot;
    }
    await page.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for database import snapshot. Last snapshot: ${JSON.stringify(lastSnapshot)}`
  );
}

async function ensureDatabasePanelVisible(page: Page): Promise<void> {
  await ensureRightPanelVisible(page);
  const databaseTab = page.getByRole('tab', { name: /collections/i });
  await expect(databaseTab).toBeVisible({ timeout: 15_000 });
  await databaseTab.click();
  await expect(page.getByRole('tabpanel', { name: /collections/i })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });
}

async function openImportSettings(page: Page): Promise<void> {
  const settingsButton = page
    .getByTestId('database-demo-panel')
    .getByRole('button', { exact: true, name: 'Import Settings' });
  await expect(settingsButton).toBeVisible({ timeout: 15_000 });
  await settingsButton.click();
  await expect(page.getByText('Chunking Studio')).toBeVisible({ timeout: 15_000 });
}

async function chooseChunkingPreset(
  page: Page,
  presetName: RegExp,
  presetId?: string
): Promise<void> {
  const presetButton = presetId
    ? page.getByTestId(`chunking-preset-${presetId}`)
    : page.getByRole('button', { name: presetName });
  await expect(presetButton).toBeVisible({ timeout: 15_000 });
  await presetButton.evaluate((element) => {
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error('Chunking preset control must be a button');
    }
    element.click();
  });
}

async function readImportSettingsState(page: Page): Promise<{
  enableChunking: boolean;
  chunkingPreset: string;
  chunkingStrategy: string;
}> {
  return await page.evaluate(() => {
    const stored = window.localStorage.getItem('import-settings.v1');
    if (!stored) {
      throw new Error('import-settings.v1 is missing');
    }
    const parsed = JSON.parse(stored) as {
      state?: {
        enableChunking?: boolean;
        chunkingPreset?: string;
        chunkingStrategy?: string;
      };
    };
    const enableChunking = parsed.state?.enableChunking;
    const chunkingPreset = parsed.state?.chunkingPreset;
    const chunkingStrategy = parsed.state?.chunkingStrategy;
    if (
      typeof enableChunking !== 'boolean' ||
      typeof chunkingPreset !== 'string' ||
      typeof chunkingStrategy !== 'string'
    ) {
      throw new Error('Import settings state is missing canonical chunking fields');
    }
    return { chunkingPreset, chunkingStrategy, enableChunking };
  });
}

async function readStoredImportSettingsSnapshot(page: Page): Promise<string | null> {
  return await page.evaluate(() => window.localStorage.getItem('import-settings.v1'));
}

async function clearPersistedExplorerIncludeFilters(page: Page): Promise<void> {
  await page.evaluate(() => {
    const storageKey = 'file-explorer-storage-v5';
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) {
      throw new Error('file-explorer-storage-v5 is missing');
    }

    const parsed = JSON.parse(stored) as {
      state?: {
        folderStates?: Record<
          string,
          {
            includeFilters?: unknown;
            viewFilterPresetId?: unknown;
          }
        >;
        includeFilters?: unknown;
        viewFilterPresetId?: unknown;
      };
      version?: unknown;
    };

    if (!parsed.state || typeof parsed.state !== 'object') {
      throw new Error('file-explorer-storage-v5 is missing state');
    }

    const folderStates = parsed.state.folderStates;
    if (!folderStates || typeof folderStates !== 'object') {
      throw new Error('file-explorer-storage-v5 is missing folderStates');
    }

    const normalizedFolderStates = Object.fromEntries(
      Object.entries(folderStates).map(([folderId, folderState]) => {
        if (!folderState || typeof folderState !== 'object') {
          throw new Error(`Invalid folder state for ${folderId}`);
        }

        return [
          folderId,
          {
            ...folderState,
            includeFilters: [],
            viewFilterPresetId: null,
          },
        ];
      })
    );

    const next = {
      ...parsed,
      state: {
        ...parsed.state,
        folderStates: normalizedFolderStates,
        includeFilters: [],
        viewFilterPresetId: null,
      },
    };

    window.localStorage.setItem(storageKey, JSON.stringify(next));
  });
}

async function createCollection(page: Page, collectionName: string): Promise<void> {
  const databasePanel = page.getByTestId('database-demo-panel');
  await databasePanel.getByRole('button', { name: 'New' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Create Search Collection')).toBeVisible({ timeout: 15_000 });

  const nameInput = dialog.getByLabel('Name *');
  await expect(nameInput).toBeVisible({ timeout: 15_000 });
  await nameInput.fill(collectionName);

  const createButton = dialog.getByRole('button', { name: 'Create Collection' });
  await expect(createButton).toBeEnabled({ timeout: 15_000 });
  await createButton.click();

  await expect(dialog).toBeHidden({ timeout: 15_000 });
  const collectionList = databasePanel.getByRole('listbox', { name: 'Search Collection' });
  await expect(collectionList).toBeVisible({ timeout: 15_000 });
  await expect(
    collectionList.getByRole('option').filter({ hasText: collectionName }).first()
  ).toBeVisible({
    timeout: 30_000,
  });
}

async function selectFilesForImport(page: Page, expectedSelectedCount: number): Promise<void> {
  const explorer = new FileExplorerPage(page);
  const showExplorerButton = page
    .locator('button[aria-label="Show explorer panel"]')
    .or(page.getByRole('button', { name: 'Show explorer panel' }))
    .first();
  if (await showExplorerButton.isVisible().catch(() => false)) {
    await showExplorerButton.click();
  }
  await explorer.selectRootButton.click();
  const noMatchingFiles = page.getByText('No matching files found');
  await expect
    .poll(
      async () =>
        (await noMatchingFiles.isVisible().catch(() => false)) ||
        (await explorer.fileTree.isVisible().catch(() => false)),
      {
        timeout: 30_000,
      }
    )
    .toBe(true);

  if (await noMatchingFiles.isVisible().catch(() => false)) {
    const filterChipNames = [
      '*.tsx',
      '*.ts',
      '*.js',
      '*.jsx',
      '*.json',
      '.aider*',
      'node_modules',
      '.next',
      'coverage',
      'test-results',
      'playwright-report',
    ] as const;

    for (const filterChipName of filterChipNames) {
      const filterChip = page.getByRole('button', { name: filterChipName }).first();
      if (await filterChip.isVisible().catch(() => false)) {
        await filterChip.click();
      }
    }
  }

  await expect(explorer.fileTree).toBeVisible({ timeout: 30_000 });
  if (expectedSelectedCount > 10) {
    const settingsButton = page.getByRole('button', { name: /Selection settings/i });
    await expect(settingsButton).toBeVisible({ timeout: 15_000 });
    await settingsButton.click();

    const input = page.getByLabel('Maximum selection count input');
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill(String(expectedSelectedCount));
    await page.getByRole('button', { name: 'Apply selection count' }).click();
    await expect(input).toBeHidden({ timeout: 15_000 });
  }
  await expect(explorer.selectAllButton).toBeEnabled({ timeout: 15_000 });
  await explorer.selectAllButton.click();
  await expectExplorerImportSelectionCount(page, expectedSelectedCount);
}

async function waitForCollectionSummary(
  page: Page,
  collectionName: string,
  predicate: (counts: CollectionSummaryCounts) => boolean,
  timeoutMs = 120_000
): Promise<CollectionSummaryCounts> {
  const startedAt = Date.now();
  let lastSummaryText: string | null = null;
  let lastError: string | null = null;
  let lastImportSnapshot: DatabaseImportSnapshot | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastImportSnapshot = await readDatabaseImportSnapshot(page);
      lastSummaryText = await getCollectionSummaryText(page, collectionName);
      const counts = parseCollectionSummaryCounts(lastSummaryText);
      if (predicate(counts)) {
        return counts;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await page.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for collection summary for '${collectionName}'. Last summary: ${
      lastSummaryText ?? 'unavailable'
    }. Last import snapshot: ${JSON.stringify(lastImportSnapshot)}. Last error: ${
      lastError ?? 'none'
    }`
  );
}

async function forceGarbageCollection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const globalWindow = window as Window & { gc?: () => void };
    globalWindow.gc?.();
  });
  await page.waitForTimeout(500);
}

async function readHeapSnapshot(page: Page, label: string): Promise<HeapSnapshot> {
  return await page.evaluate<HeapSnapshot, string>((snapshotLabel) => {
    const memory = (
      performance as Performance & {
        memory?: {
          usedJSHeapSize: number;
          totalJSHeapSize: number;
          jsHeapSizeLimit: number;
        };
      }
    ).memory;
    if (!memory) {
      throw new Error('performance.memory is unavailable in this browser runtime');
    }

    return {
      label: snapshotLabel,
      limitMB: Math.round((memory.jsHeapSizeLimit / 1024 / 1024) * 10) / 10,
      totalMB: Math.round((memory.totalJSHeapSize / 1024 / 1024) * 10) / 10,
      usedMB: Math.round((memory.usedJSHeapSize / 1024 / 1024) * 10) / 10,
    };
  }, label);
}

async function releaseImportedAppState(page: Page): Promise<void> {
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
  });

  // Navigate away from the app so browser-level workers and large in-memory graphs
  // are eligible for reclamation before the next Playwright file reuses this worker.
  await page.goto('about:blank');
  await page.waitForTimeout(500);
}

test.describe
  .fixme('Database import and backfill (web) @stateful @web-import-indexing', {
    annotation: { description: 'BST-1963', type: 'quarantine' },
  }, () => {
    test.describe.configure({ mode: 'serial' });

    test('imports files, chunks them, backfills, and updates collection coverage without reload', async ({
      page,
    }) => {
      test.setTimeout(180_000);

      await mockBrowserApis(page, ROOT_NAME, CODE_FILE_TREE);
      await page.goto('/');
      await waitForAppLoad(page);

      await resetAppState(page);
      await page.reload();
      await waitForAppLoad(page);
      await expect
        .poll(async () => await readStoredImportSettingsSnapshot(page), {
          timeout: 15_000,
        })
        .toBeNull();

      const collectionName = `Web Import Backfill ${Date.now()}`;
      await ensureDatabasePanelVisible(page);
      await createCollection(page, collectionName);

      await selectFilesForImport(page, 2);

      await ensureDatabasePanelVisible(page);
      await openImportSettings(page);
      await page.getByTestId('chunking-preset-balanced').click();
      await expect
        .poll(async () => await readImportSettingsState(page), {
          timeout: 15_000,
        })
        .toEqual({
          chunkingPreset: 'balanced',
          chunkingStrategy: 'auto',
          enableChunking: true,
        });
      await page.keyboard.press('Escape');
      await expect(page.getByText('Chunking Studio')).toBeHidden({ timeout: 15_000 });

      const databasePanel = page.getByTestId('database-demo-panel');

      const timeOriginBeforeBackfill = await page.evaluate(() => window.performance.timeOrigin);

      await importSelectedFilesFromExplorer(page, { expectedSelectedCount: 2 });

      const importedCounts = await waitForCollectionSummary(
        page,
        collectionName,
        (counts) => counts.fileCount === 2 && counts.totalChunks > 0 && counts.embeddedChunks === 0
      );
      expect(importedCounts.fileCount).toBe(2);
      expect(importedCounts.totalChunks).toBeGreaterThan(0);
      expect(importedCounts.embeddedChunks).toBe(0);

      const backfillButton = databasePanel.getByRole('button', {
        name: /^(?:Backfill|Start & Backfill)(?:\s|$)/,
      });
      await expect(backfillButton).toBeVisible({ timeout: 15_000 });
      await expect(backfillButton).toBeEnabled({ timeout: 15_000 });
      await backfillButton.click();

      const embeddedCounts = await waitForCollectionSummary(
        page,
        collectionName,
        (counts) => counts.totalChunks > 0 && counts.embeddedChunks === counts.totalChunks
      );

      expect(embeddedCounts.fileCount).toBe(2);
      expect(embeddedCounts.totalChunks).toBeGreaterThan(0);
      expect(embeddedCounts.embeddedChunks).toBe(embeddedCounts.totalChunks);
      await expect(backfillButton).toContainText(/Backfill/, { timeout: 15_000 });

      const timeOriginAfterBackfill = await page.evaluate(() => window.performance.timeOrigin);
      expect(timeOriginAfterBackfill).toBe(timeOriginBeforeBackfill);
    });

    test('keeps retained renderer heap bounded while importing a large chunked codebase', async ({
      page,
    }) => {
      test.setTimeout(300_000);

      await enableDatabaseDemoTestHooks(page);
      await mockBrowserApis(
        page,
        `${ROOT_NAME}-import-memory`,
        createLargeCodeFixtureTree(IMPORT_MEMORY_FIXTURE_FILE_COUNT)
      );
      await page.goto('/');
      await waitForAppLoad(page);

      await resetAppState(page);
      await page.reload();
      await waitForAppLoad(page);

      const collectionName = `Web Import Memory ${Date.now()}`;
      await ensureDatabasePanelVisible(page);
      await createCollection(page, collectionName);
      await selectFilesForImport(page, IMPORT_MEMORY_FIXTURE_FILE_COUNT);
      await ensureDatabasePanelVisible(page);

      await openImportSettings(page);
      await page.getByTestId('chunking-preset-balanced').click();
      await expect
        .poll(async () => await readImportSettingsState(page), {
          timeout: 15_000,
        })
        .toEqual({
          chunkingPreset: 'balanced',
          chunkingStrategy: 'auto',
          enableChunking: true,
        });
      await page.keyboard.press('Escape');
      await expect(page.getByText('Chunking Studio')).toBeHidden({ timeout: 15_000 });

      try {
        const baseline = await readHeapSnapshot(page, 'before-import');

        await importSelectedFilesFromExplorer(page, {
          expectedSelectedCount: IMPORT_MEMORY_FIXTURE_FILE_COUNT,
        });

        const completedImport = await waitForDatabaseImportSnapshot(
          page,
          (snapshot) =>
            !snapshot.isImporting &&
            snapshot.progress?.phase === 'complete' &&
            snapshot.progress.chunkingProgress?.filesProcessed === IMPORT_MEMORY_FIXTURE_FILE_COUNT,
          240_000
        );
        expect(completedImport.progress?.errors).toEqual([]);
        expect(completedImport.progress?.chunkingProgress?.chunksCreated).toBeGreaterThanOrEqual(
          IMPORT_MEMORY_FIXTURE_FILE_COUNT
        );

        const importedCounts = await waitForCollectionSummary(
          page,
          collectionName,
          (counts) =>
            counts.fileCount === IMPORT_MEMORY_FIXTURE_FILE_COUNT &&
            counts.totalChunks >= IMPORT_MEMORY_FIXTURE_FILE_COUNT &&
            counts.embeddedChunks === 0
        );

        await forceGarbageCollection(page);
        await forceGarbageCollection(page);
        const retained = await readHeapSnapshot(page, 'after-import');
        const retainedGrowthMB = retained.usedMB - baseline.usedMB;

        console.log(
          JSON.stringify({
            baseline,
            collectionName,
            importedCounts,
            retained,
            retainedGrowthMB,
            type: 'web-import-memory-diagnostic',
          })
        );

        expect(importedCounts.fileCount).toBe(IMPORT_MEMORY_FIXTURE_FILE_COUNT);
        expect(importedCounts.totalChunks).toBeGreaterThanOrEqual(IMPORT_MEMORY_FIXTURE_FILE_COUNT);
        expect(importedCounts.embeddedChunks).toBe(0);
        expect(retainedGrowthMB).toBeLessThan(180);
      } finally {
        await releaseImportedAppState(page);
      }
    });

    test('shows adaptive codebase routing and persists the auto strategy', async ({ page }) => {
      test.setTimeout(180_000);

      await mockBrowserApis(page, `${ROOT_NAME}-codebase-preset`, CODE_FILE_TREE);
      await page.goto('/');
      await waitForAppLoad(page);

      await resetAppState(page);
      await page.reload();
      await waitForAppLoad(page);

      await ensureDatabasePanelVisible(page);
      await openImportSettings(page);

      await chooseChunkingPreset(page, /^Codebase/, 'codebase');
      await expect(page.getByText('Adaptive mixed-repo preset')).toBeVisible({
        timeout: 15_000,
      });
      await page.getByRole('button', { name: /Routing plan/ }).click();
      const docsRoute = page.getByTestId('chunking-route-docs-getting-started-md');
      await expect(docsRoute).toBeVisible({ timeout: 15_000 });
      await expect(docsRoute.getByText('semantic-markdown')).toBeVisible({ timeout: 15_000 });
      const codeRoute = page.getByTestId('chunking-route-src-assistant-retrieval-ts');
      await expect(codeRoute).toBeVisible({ timeout: 15_000 });
      await expect(codeRoute.getByText('recursive')).toBeVisible({ timeout: 15_000 });

      await expect
        .poll(async () => await readImportSettingsState(page), {
          timeout: 15_000,
        })
        .toEqual({
          chunkingPreset: 'codebase',
          chunkingStrategy: 'auto',
          enableChunking: true,
        });

      await page.reload();
      await waitForAppLoad(page);
      await ensureDatabasePanelVisible(page);
      await openImportSettings(page);
      await expect(page.getByText('Adaptive mixed-repo preset')).toBeVisible({
        timeout: 15_000,
      });
    });

    test('imports markdown successfully after choosing the docs preset in Chunking Studio', async ({
      page,
    }) => {
      test.setTimeout(180_000);

      await mockBrowserApis(page, `${ROOT_NAME}-docs-preset`, DOCS_FILE_TREE);
      await page.goto('/');
      await waitForAppLoad(page);

      await resetAppState(page);
      await page.reload();
      await waitForAppLoad(page);
      await clearPersistedExplorerIncludeFilters(page);
      await page.reload();
      await waitForAppLoad(page);

      const collectionName = `Web Docs Preset ${Date.now()}`;
      await ensureDatabasePanelVisible(page);
      await createCollection(page, collectionName);
      await selectFilesForImport(page, 2);
      await ensureDatabasePanelVisible(page);
      await openImportSettings(page);

      await chooseChunkingPreset(page, /^Docs/, 'docs');
      await expect(
        page.getByText(
          'Prefers semantic markdown grouping for guides, notes, and README-heavy content.'
        )
      ).toBeVisible({ timeout: 15_000 });

      await expect
        .poll(async () => await readImportSettingsState(page), {
          timeout: 15_000,
        })
        .toEqual({
          chunkingPreset: 'docs',
          chunkingStrategy: 'semantic-markdown',
          enableChunking: true,
        });

      await page.keyboard.press('Escape');
      await expect(page.getByText('Chunking Studio')).toBeHidden({ timeout: 15_000 });

      const timeOriginBeforeImport = await page.evaluate(() => window.performance.timeOrigin);
      await importSelectedFilesFromExplorer(page, { expectedSelectedCount: 2 });

      const importedCounts = await waitForCollectionSummary(
        page,
        collectionName,
        (counts) => counts.fileCount === 2 && counts.totalChunks > 0
      );

      expect(importedCounts.fileCount).toBe(2);
      expect(importedCounts.totalChunks).toBeGreaterThan(0);

      const timeOriginAfterImport = await page.evaluate(() => window.performance.timeOrigin);
      expect(timeOriginAfterImport).toBe(timeOriginBeforeImport);
    });
  });
