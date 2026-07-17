import { expect, type Page, test } from '@playwright/test';
import { FileExplorerPage } from '../page-objects/file-explorer-page';
import { HomePage } from '../page-objects/home-page';
import {
  getExpandedDirectoryCount,
  persistCurrentExplorerStoreSnapshot,
  restoreInlineFixture,
} from '../utils/file-explorer-restoration';
import { waitForAppLoad } from '../utils/layout-helpers';
import { type FileTree, mockBrowserApis } from '../utils/mock-fs';

const ROOT_NAME = 'restored-resize-regression';
const RESTORED_RESIZE_ROOT_DIRECTORY_COUNT = 60;
const RESTORED_RESIZE_CHILD_DIRECTORY_COUNT = 12;
const RESTORED_RESIZE_LONG_TASK_BUDGET_MS = 500;
const RESIZE_DRAG_STEP_COUNT = 24;

// Keep this contract synchronized with the object literal returned by the browser-side probe.
interface DragMetrics {
  afterClientHeight: number;
  afterFirstIndex: number | null;
  afterLastIndex: number | null;
  afterRowCount: number;
  afterScrollHeight: number;
  afterTotalDataNodeCount: number;
  afterVirtualizerClientHeight: number;
  afterVirtualizerScrollHeight: number;
  beforeClientHeight: number;
  beforeFirstIndex: number | null;
  beforeLastIndex: number | null;
  beforeRowCount: number;
  beforeScrollHeight: number;
  beforeTotalDataNodeCount: number;
  beforeVirtualizerClientHeight: number;
  beforeVirtualizerScrollHeight: number;
  durationMs: number;
  frameCount: number;
  longTaskCount: number;
  maxFrameGapMs: number;
  over16Ms: number;
  over33Ms: number;
  over50Ms: number;
  totalLongTaskDurationMs: number;
}

function createExpandedTree(rootDirectoryCount: number, childDirectoryCount: number): FileTree {
  const tree: FileTree = {};

  for (let rootIndex = 0; rootIndex < rootDirectoryCount; rootIndex += 1) {
    const childTree: FileTree = {};
    for (let childIndex = 0; childIndex < childDirectoryCount; childIndex += 1) {
      childTree[`child-${rootIndex}-${childIndex}`] = {
        [`file-${rootIndex}-${childIndex}.ts`]: null,
      };
    }
    tree[`folder-${rootIndex}`] = childTree;
  }

  return tree;
}

async function installFrameProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const targetWindow = window as Window & {
      __brainstrikeResizeProbe__?: {
        finish: () => DragMetrics;
        frameCount: () => number;
      };
    };

    const frameGaps: number[] = [];
    const longTaskDurations: number[] = [];
    const fileTreeContainer = document.querySelector('[data-testid="file-tree-scroll-container"]');
    const virtualizerElement = document.querySelector('[role="treegrid"]')?.parentElement;
    const beforeRows = Array.from(fileTreeContainer?.querySelectorAll('[data-node-id]') ?? []);
    const beforeIndexes = beforeRows
      .map((element) => Number((element as HTMLElement).dataset['index']))
      .filter((index) => Number.isFinite(index));
    const beforeRowCount = beforeRows.length;
    const beforeFirstIndex = beforeIndexes.length > 0 ? Math.min(...beforeIndexes) : null;
    const beforeLastIndex = beforeIndexes.length > 0 ? Math.max(...beforeIndexes) : null;
    const beforeClientHeight = fileTreeContainer?.clientHeight ?? 0;
    const beforeScrollHeight = fileTreeContainer?.scrollHeight ?? 0;
    const beforeVirtualizerClientHeight = virtualizerElement?.clientHeight ?? 0;
    const beforeVirtualizerScrollHeight = virtualizerElement?.scrollHeight ?? 0;
    const beforeTotalDataNodeCount = document.querySelectorAll('[data-node-id]').length;
    let previousFrame = performance.now();
    let isRunning = true;

    const observer =
      typeof PerformanceObserver === 'function'
        ? new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              longTaskDurations.push(entry.duration);
            }
          })
        : null;

    observer?.observe({ entryTypes: ['longtask'] });

    const tick = (timestamp: number): void => {
      if (!isRunning) {
        return;
      }
      frameGaps.push(timestamp - previousFrame);
      previousFrame = timestamp;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    targetWindow.__brainstrikeResizeProbe__ = {
      finish: () => {
        isRunning = false;
        observer?.disconnect();
        const currentFileTreeContainer = document.querySelector(
          '[data-testid="file-tree-scroll-container"]'
        );
        const currentVirtualizerElement =
          document.querySelector('[role="treegrid"]')?.parentElement;
        const afterRows = Array.from(
          currentFileTreeContainer?.querySelectorAll('[data-node-id]') ?? []
        );
        const afterIndexes = afterRows
          .map((element) => Number((element as HTMLElement).dataset['index']))
          .filter((index) => Number.isFinite(index));
        const afterRowCount = afterRows.length;
        const afterFirstIndex = afterIndexes.length > 0 ? Math.min(...afterIndexes) : null;
        const afterLastIndex = afterIndexes.length > 0 ? Math.max(...afterIndexes) : null;
        const afterClientHeight = currentFileTreeContainer?.clientHeight ?? 0;
        const afterScrollHeight = currentFileTreeContainer?.scrollHeight ?? 0;
        const afterVirtualizerClientHeight = currentVirtualizerElement?.clientHeight ?? 0;
        const afterVirtualizerScrollHeight = currentVirtualizerElement?.scrollHeight ?? 0;
        const afterTotalDataNodeCount = document.querySelectorAll('[data-node-id]').length;
        return {
          afterClientHeight,
          afterFirstIndex,
          afterLastIndex,
          afterRowCount,
          afterScrollHeight,
          afterTotalDataNodeCount,
          afterVirtualizerClientHeight,
          afterVirtualizerScrollHeight,
          beforeClientHeight,
          beforeFirstIndex,
          beforeLastIndex,
          beforeRowCount,
          beforeScrollHeight,
          beforeTotalDataNodeCount,
          beforeVirtualizerClientHeight,
          beforeVirtualizerScrollHeight,
          durationMs: frameGaps.reduce((total, gap) => total + gap, 0),
          frameCount: frameGaps.length,
          longTaskCount: longTaskDurations.length,
          maxFrameGapMs: Math.max(0, ...frameGaps),
          over16Ms: frameGaps.filter((gap) => gap > 16.7).length,
          over33Ms: frameGaps.filter((gap) => gap > 33.4).length,
          over50Ms: frameGaps.filter((gap) => gap > 50).length,
          totalLongTaskDurationMs: longTaskDurations.reduce(
            (total, duration) => total + duration,
            0
          ),
        };
      },
      frameCount: () => frameGaps.length,
    };
  });
}

async function getFrameProbeFrameCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = (
      window as Window & {
        __brainstrikeResizeProbe__?: {
          frameCount: () => number;
        };
      }
    ).__brainstrikeResizeProbe__;
    if (!probe) {
      throw new Error('Resize probe was not installed');
    }
    return probe.frameCount();
  });
}

async function waitForFrameProbeFrames(page: Page, additionalFrameCount: number): Promise<void> {
  const initialFrameCount = await getFrameProbeFrameCount(page);
  await expect
    .poll(() => getFrameProbeFrameCount(page), { timeout: 5000 })
    .toBeGreaterThanOrEqual(initialFrameCount + additionalFrameCount);
}

async function finishFrameProbe(page: Page): Promise<DragMetrics> {
  return page.evaluate(() => {
    const probe = (
      window as Window & {
        __brainstrikeResizeProbe__?: {
          finish: () => DragMetrics;
        };
      }
    ).__brainstrikeResizeProbe__;
    if (!probe) {
      throw new Error('Resize probe was not installed');
    }
    return probe.finish();
  });
}

test('keeps restored expanded explorer windowed during panel resize drag', async ({ page }) => {
  // Produces 60 top-level dirs, 720 child dirs, and 720 files: enough scale to
  // catch restored-state full-tree rendering without making the focused spec slow.
  const tree = createExpandedTree(
    RESTORED_RESIZE_ROOT_DIRECTORY_COUNT,
    RESTORED_RESIZE_CHILD_DIRECTORY_COUNT
  );
  await mockBrowserApis(page, ROOT_NAME, tree);
  await new HomePage(page).goto({ waitForDatabase: false });

  const explorer = new FileExplorerPage(page);
  await explorer.selectRoot();
  await page.getByTestId('expand-all-button-small').click();
  await expect(page.getByTestId('expand-all-button-small')).toBeEnabled({ timeout: 60_000 });
  await expect.poll(() => getExpandedDirectoryCount(page), { timeout: 10_000 }).toBeGreaterThan(0);
  await persistCurrentExplorerStoreSnapshot(page);

  await page.reload();
  await waitForAppLoad(page, { waitForDatabase: false });
  await restoreInlineFixture(page, ROOT_NAME, tree);
  await expect(explorer.fileTree).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => getExpandedDirectoryCount(page), { timeout: 10_000 }).toBeGreaterThan(0);

  const treeContainer = explorer.fileTreeScrollContainer;
  await expect(treeContainer).toBeVisible();
  const treeBox = await treeContainer.boundingBox();
  if (!treeBox) {
    throw new Error('File tree scroll container bounding box is unavailable');
  }

  const x = treeBox.x + treeBox.width + 2;
  const y = treeBox.y + treeBox.height / 2;

  await installFrameProbe(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 0; step < RESIZE_DRAG_STEP_COUNT; step += 1) {
    const delta = step % 2 === 0 ? 70 : -50;
    await page.mouse.move(x + delta, y, { steps: 2 });
  }
  await page.mouse.up();
  await waitForFrameProbeFrames(page, 5);

  const metrics = await finishFrameProbe(page);
  console.log(`RESTORED_EXPLORER_RESIZE_METRICS ${JSON.stringify(metrics)}`);
  expect(metrics.beforeRowCount).toBeGreaterThan(0);
  expect(metrics.afterRowCount).toBeLessThan(200);
  expect(metrics.afterLastIndex ?? 0).toBeLessThan(200);
  expect(metrics.totalLongTaskDurationMs).toBeLessThan(RESTORED_RESIZE_LONG_TASK_BUDGET_MS);
});
