/**
 * Session scroll restore: the explorer scroll position survives a restart.
 *
 * Seeds a root with many files (a tall, scrollable tree), scrolls the explorer
 * container down, then reloads the renderer (main-process storage persists —
 * the restart proxy) and asserts the container comes back at the same offset.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FILE_EXPLORER_STORAGE_KEY } from '@brainstrike/file-explorer/testing';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { updateIndexConfig } from './utils/index-config';
import { loadElectronHelpers } from './utils/load-electron-helpers';

let ROOT_DIR: string;

test.beforeAll(() => {
  ROOT_DIR = mkdtempSync(path.join(os.tmpdir(), 'brainstrike-scroll-'));
  // Enough files to make the explorer scroll well past the viewport.
  for (let i = 0; i < 200; i += 1) {
    writeFileSync(
      path.join(ROOT_DIR, `file-${String(i).padStart(3, '0')}.ts`),
      `export const v${i} = ${i};\n`
    );
  }
});

test.afterAll(() => {
  rmSync(ROOT_DIR, { force: true, recursive: true });
});

const SCROLL_SELECTOR = '[data-testid="explorer-scroll-root"]';

/** The offset the explorer's durable writer last stored, which a restart restores. */
async function persistedScrollTop(page: Page): Promise<unknown> {
  return await page.evaluate(async (key) => {
    const storage = (
      globalThis as typeof globalThis & {
        electronAPI?: { storage?: { getItem?: (k: string) => Promise<string | null> } };
      }
    ).electronAPI?.storage;
    if (!storage?.getItem) {
      throw new Error('electronAPI.storage.getItem is unavailable');
    }
    const stored = await storage.getItem(key);
    return stored === null
      ? null
      : (JSON.parse(stored) as { state?: { explorerScrollTop?: unknown } }).state
          ?.explorerScrollTop;
  }, FILE_EXPLORER_STORAGE_KEY);
}

/** The active scroller's offset, or -1 while the tree is not tall enough to hold 600px. */
async function restoredScrollTop(page: Page): Promise<number> {
  return await page.evaluate((selector) => {
    const root = document.querySelector(selector) as HTMLElement | null;
    if (!root) {
      return -1;
    }
    const el =
      root.querySelector<HTMLElement>('[data-testid="forest-sections-scroll"]') ??
      root.querySelector<HTMLElement>('[data-testid="tree-table-viewport"]') ??
      root;
    return el.scrollHeight - el.clientHeight < 600 ? -1 : el.scrollTop;
  }, SCROLL_SELECTOR);
}

test.describe('Explorer scroll restore', () => {
  test('@desktop-explorer-scroll-restore restores the scroll position across a restart', async ({
    window: page,
  }) => {
    test.setTimeout(3 * 60 * 1000);

    await page.evaluate(
      async ({ root }) => {
        const storage = (
          globalThis as typeof globalThis & {
            electronAPI?: { storage?: { setItem?: (k: string, v: string) => Promise<void> } };
          }
        ).electronAPI?.storage;
        if (!storage?.setItem) {
          throw new Error('electronAPI.storage.setItem is unavailable');
        }
        await storage.setItem('lastFolderPath', root);
        await storage.setItem(
          'rootsList',
          JSON.stringify([{ addedAt: 1_800_000_000_000, path: root, rootId: 'scroll-root-1' }])
        );
      },
      { root: ROOT_DIR }
    );
    await updateIndexConfig(page, { paused: true });

    const { reloadRenderer } = await loadElectronHelpers();
    await reloadRenderer(page, 'scroll-restore-seeded');
    await expect(page.getByText('file-000.ts').first()).toBeVisible({ timeout: 60_000 });

    const scroller = page.locator(SCROLL_SELECTOR).first();
    await expect(scroller).toBeVisible({ timeout: 30_000 });

    // The active scroll container is the outer root (single-root mode) OR the
    // inner forest container; resolve the same way the hook does, then scroll it.
    const scrollTarget = await page.evaluate((selector) => {
      const root = document.querySelector(selector) as HTMLElement | null;
      if (!root) {
        return null;
      }
      const el =
        root.querySelector<HTMLElement>('[data-testid="forest-sections-scroll"]') ??
        root.querySelector<HTMLElement>('[data-testid="tree-table-viewport"]') ??
        root;
      el.scrollTop = 600;
      return { scrollTop: el.scrollTop };
    }, SCROLL_SELECTOR);

    expect(scrollTarget).not.toBeNull();
    // The tree must actually be tall enough to hold the offset.
    expect(scrollTarget?.scrollTop ?? 0).toBeGreaterThan(0);
    const savedOffset = scrollTarget?.scrollTop ?? 0;

    // The capture commits the resting offset through the explorer's durable writer.
    await expect.poll(() => persistedScrollTop(page)).toBe(savedOffset);

    await reloadRenderer(page, 'scroll-restore-reloaded');
    await expect(scroller).toBeVisible({ timeout: 60_000 });

    // The hook restores after hydration once the tree is tall enough. Poll the
    // resolved scroller's offset — do NOT wait on the top file, which a correct
    // restore scrolls out of view (virtualized away). Restored within a few px of
    // where we left off (fixed row height → exact, small tolerance for sub-pixel
    // rounding).
    await expect
      .poll(async () => Math.abs((await restoredScrollTop(page)) - savedOffset), {
        timeout: 10_000,
      })
      .toBeLessThanOrEqual(4);
  });
});
