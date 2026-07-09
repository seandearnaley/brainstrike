import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/web-fixture';
import { resetAppState } from './utils/app-state';
import { ensureRightPanelVisible, waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

const WORKSPACE_INDEX_TREE: FileTree = {
  docs: {
    'guide.md': '# Guide\n\nBackground indexing should include nested markdown files.',
  },
  'README.md': '# Web Workspace Index\n\nThis file should be discovered and chunked.',
  src: {
    'index.ts': 'export const webWorkspaceIndex = true;\n',
  },
};

interface WorkspaceIndexExpectedCount {
  readonly expectedFileCount: number;
}

interface WorkspaceIndexSyncStatus {
  readonly lastError?: string | null;
  readonly state: string;
}

interface WorkspaceIndexRuntimeReadiness {
  readonly serviceAvailable: boolean;
}

interface WorkspaceIndexDebugSnapshot {
  readonly accessIssues?: Array<{ readonly reason: string; readonly source: string }>;
  readonly backgroundEffectiveHasHydrated?: boolean;
  readonly backgroundPersistHasHydrated?: boolean;
  readonly backgroundPreferences: {
    readonly enabled?: boolean;
    readonly hasHydrated?: boolean;
    readonly managedCollectionId?: string | null;
  };
  readonly expectedCounts: WorkspaceIndexExpectedCount[];
  readonly fileRecordsByRoot: Array<{
    readonly chunked_file_count?: number | string;
    readonly file_count?: number | string;
  }>;
  readonly managedCollectionId: string | null;
  readonly roots: unknown[];
  readonly runtimeReadiness: WorkspaceIndexRuntimeReadiness;
  readonly syncStatus: WorkspaceIndexSyncStatus;
}

interface WorkspaceIndexDebugApi {
  readonly snapshot: () => Promise<WorkspaceIndexDebugSnapshot>;
}

interface WorkspaceIndexStartupSummary {
  readonly accessIssueCount: number;
  readonly backgroundEffectiveHasHydrated: boolean | null;
  readonly backgroundEnabled: boolean | null;
  readonly backgroundHydrated: boolean | null;
  readonly backgroundManagedCollectionId: string | null;
  readonly backgroundPersistHasHydrated: boolean | null;
  readonly chunkedFileCount: number;
  readonly expectedFileCount: number;
  readonly fileRecordCount: number;
  readonly hasManagedCollection: boolean;
  readonly hasRoot: boolean;
  readonly runtimeReady: boolean;
  readonly state: string | null;
  readonly statusLastError: string | null;
}

const INDEXING_WARNING_PATTERNS = [
  'FixtureAdapter',
  'FileImport:Chunking',
  'VectorQueueService',
  'WorkspaceCollectionSyncImport',
] as const;

declare global {
  interface Window {
    __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: WorkspaceIndexDebugApi;
  }
}

async function requireBoundingBox(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('Expected a visible indexing surface with measurable geometry.');
  }
  return box;
}

function expectStableRect(
  before: { height: number; width: number; x: number; y: number },
  after: { height: number; width: number; x: number; y: number }
): void {
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
}

async function readRenderedContrastRatio(locator: Locator): Promise<number> {
  return await locator.evaluate((element) => {
    type Rgba = readonly [red: number, green: number, blue: number, alpha: number];

    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('Canvas 2D context is required to verify rendered color contrast.');
    }

    const parseColor = (color: string): Rgba => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return [red ?? 0, green ?? 0, blue ?? 0, (alpha ?? 0) / 255];
    };

    const composite = (foreground: Rgba, background: Rgba): Rgba => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3]);
      if (alpha === 0) {
        return [0, 0, 0, 0];
      }
      return [
        (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) /
          alpha,
        (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) /
          alpha,
        (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) /
          alpha,
        alpha,
      ];
    };

    const ancestors: Element[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      ancestors.push(current);
    }
    let background: Rgba = [255, 255, 255, 1];
    for (const ancestor of ancestors.reverse()) {
      background = composite(parseColor(getComputedStyle(ancestor).backgroundColor), background);
    }

    const foreground = parseColor(getComputedStyle(element).color);
    const linearize = (channel: number): number => {
      const normalized = channel / 255;
      return normalized <= 0.040_45 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color: Rgba): number =>
      0.2126 * linearize(color[0]) + 0.7152 * linearize(color[1]) + 0.0722 * linearize(color[2]);
    const foregroundLuminance = luminance(foreground);
    const backgroundLuminance = luminance(background);
    return (
      (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
      (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
    );
  });
}

async function verifySemanticHoverContrasts(page: Page): Promise<void> {
  const toneClasses = [
    ['blocked', 'text-amber-800'],
    ['paused', 'text-red-800'],
    ['active', 'text-sky-800'],
    ['ready', 'text-emerald-800'],
  ] as const;
  await page.evaluate((tones) => {
    const probe = document.createElement('div');
    probe.dataset['testid'] = 'indexing-contrast-probe';
    probe.className = 'bg-accent';
    probe.style.position = 'fixed';
    probe.style.left = '-10000px';
    for (const [name, className] of tones) {
      const swatch = document.createElement('span');
      swatch.dataset['testid'] = `indexing-contrast-${name}`;
      swatch.className = className;
      swatch.textContent = name;
      probe.append(swatch);
    }
    document.body.append(probe);
  }, toneClasses);

  for (const [name] of toneClasses) {
    const ratio = await readRenderedContrastRatio(page.getByTestId(`indexing-contrast-${name}`));
    expect(ratio, `${name} tone contrast on the hover surface`).toBeGreaterThanOrEqual(4.5);
  }

  await page.getByTestId('indexing-contrast-probe').evaluate((element) => element.remove());
}

async function readWorkspaceIndexStartupSummary(
  page: Page
): Promise<WorkspaceIndexStartupSummary | null> {
  return await page.evaluate(async () => {
    const debug = window.__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__;
    if (!debug) {
      return null;
    }

    const toCount = (value: number | string | undefined): number => {
      if (typeof value === 'number') {
        return value;
      }
      if (typeof value === 'string') {
        return Number.parseInt(value, 10);
      }
      return 0;
    };

    const snapshot = await debug.snapshot();
    const expectedFileCount = snapshot.expectedCounts.reduce(
      (total, count) => total + count.expectedFileCount,
      0
    );
    const fileRecordCount = snapshot.fileRecordsByRoot.reduce(
      (total, row) => total + toCount(row.file_count),
      0
    );
    const chunkedFileCount = snapshot.fileRecordsByRoot.reduce(
      (total, row) => total + toCount(row.chunked_file_count),
      0
    );

    return {
      accessIssueCount: snapshot.accessIssues?.length ?? 0,
      backgroundEffectiveHasHydrated: snapshot.backgroundEffectiveHasHydrated ?? null,
      backgroundEnabled: snapshot.backgroundPreferences.enabled ?? null,
      backgroundHydrated: snapshot.backgroundPreferences.hasHydrated ?? null,
      backgroundManagedCollectionId: snapshot.backgroundPreferences.managedCollectionId ?? null,
      backgroundPersistHasHydrated: snapshot.backgroundPersistHasHydrated ?? null,
      chunkedFileCount,
      expectedFileCount,
      fileRecordCount,
      hasManagedCollection: snapshot.managedCollectionId !== null,
      hasRoot: snapshot.roots.length > 0,
      runtimeReady: snapshot.runtimeReadiness.serviceAvailable,
      state: snapshot.syncStatus.state,
      statusLastError: snapshot.syncStatus.lastError ?? null,
    };
  });
}

test.describe('Workspace Index background indexing (web) @stateful @web-indexing', () => {
  test('starts the managed Workspace Index for a web root and records chunked files', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const indexingConsoleIssues: string[] = [];
    page.on('console', (message) => {
      if (!(message.type() === 'warning' || message.type() === 'error')) {
        return;
      }
      const text = message.text();
      if (INDEXING_WARNING_PATTERNS.some((pattern) => text.includes(pattern))) {
        indexingConsoleIssues.push(`[${message.type()}] ${text}`);
      }
    });

    await mockBrowserApis(page, 'web-workspace-index-root', WORKSPACE_INDEX_TREE);
    await page.goto('/');
    await resetAppState(page);
    await page.reload({ waitUntil: 'load' });
    await waitForAppLoad(page, { timeoutMs: 120_000, waitForDatabase: true });

    await page.getByRole('button', { name: /^Add Folder to Workspace$/i }).click();

    await expect
      .poll(async () => await readWorkspaceIndexStartupSummary(page), {
        timeout: 120_000,
      })
      .toMatchObject({
        accessIssueCount: 0,
        backgroundEffectiveHasHydrated: true,
        backgroundEnabled: true,
        backgroundHydrated: true,
        backgroundManagedCollectionId: expect.any(String),
        chunkedFileCount: 3,
        expectedFileCount: 3,
        fileRecordCount: 3,
        hasManagedCollection: true,
        hasRoot: true,
        runtimeReady: true,
        statusLastError: null,
      });

    const finalSummary = await readWorkspaceIndexStartupSummary(page);
    expect(finalSummary?.state).not.toBe('disabled');
    expect(indexingConsoleIssues).toEqual([]);
    const indexingTrigger = page.getByTestId('indexing-status-trigger');
    await expect(indexingTrigger).toBeVisible({
      timeout: 15_000,
    });
    const indexingStatus = page.getByTestId('indexing-status-item');
    expect(await readRenderedContrastRatio(indexingStatus)).toBeGreaterThanOrEqual(4.5);
    await indexingTrigger.hover();
    expect(await readRenderedContrastRatio(indexingStatus)).toBeGreaterThanOrEqual(4.5);
    await verifySemanticHoverContrasts(page);

    const triggerBeforePause = await requireBoundingBox(indexingTrigger);
    await indexingTrigger.click();

    const indexingPopover = page.getByTestId('indexing-status-popover');
    await expect(indexingPopover).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => {
        const value = await indexingPopover.getByTestId('managed-stat-files').textContent();
        return Number(value?.replaceAll(',', '') ?? Number.NaN);
      })
      .toBe(3);
    await expect
      .poll(async () => {
        const value = await indexingPopover.getByTestId('managed-stat-chunks').textContent();
        return Number(value?.replaceAll(',', '') ?? Number.NaN);
      })
      .toBeGreaterThan(0);

    const popoverBeforePause = await requireBoundingBox(indexingPopover);
    await indexingPopover.getByRole('button', { name: 'Pause workspace index' }).click();
    await expect(indexingTrigger).toContainText('Paused', { timeout: 15_000 });

    expectStableRect(triggerBeforePause, await requireBoundingBox(indexingTrigger));
    expectStableRect(popoverBeforePause, await requireBoundingBox(indexingPopover));

    await indexingPopover.getByRole('button', { name: 'Resume workspace index' }).click();
    await expect(indexingTrigger).not.toContainText('Paused', { timeout: 15_000 });
    expectStableRect(triggerBeforePause, await requireBoundingBox(indexingTrigger));
    expectStableRect(popoverBeforePause, await requireBoundingBox(indexingPopover));

    await page.keyboard.press('Escape');
    await ensureRightPanelVisible(page);
    await page.getByRole('tab', { name: /database/i }).click();
    const databasePanel = page.getByRole('tabpanel', { name: /database/i });
    await expect(databasePanel.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });
    await expect(databasePanel.getByText('Workspace Index', { exact: true })).toHaveCount(0);
  });
});
