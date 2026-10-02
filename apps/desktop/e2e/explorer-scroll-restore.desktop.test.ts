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
import { expect, test } from './fixtures/electron-fixture';
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

test.describe('Explorer scroll restore', () => {
  test.fixme('@desktop-explorer-scroll-restore restores the scroll position across a restart', {
    annotation: { description: 'BST-1952', type: 'quarantine' },
  }, async ({ window: page }) => {
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
        localStorage.setItem(
          'background-indexing-preferences.v1',
          JSON.stringify({
            state: {
              enabled: false,
              indexingPolicyPreset: 'full-root',
              managedCollectionId: null,
              mode: 'root-folder-cache',
              paused: true,
            },
            version: 4,
          })
        );
      },
      { root: ROOT_DIR }
    );

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

    // Let the rAF-throttled capture write the offset to the store, then persist.
    await page.waitForTimeout(500);

    await reloadRenderer(page, 'scroll-restore-reloaded');
    await expect(scroller).toBeVisible({ timeout: 60_000 });

    // The hook restores after hydration once the tree is tall enough. Poll the
    // resolved scroller's offset — do NOT wait on the top file, which a correct
    // restore scrolls out of view (virtualized away). `-1` means the tree has
    // not loaded/grown tall enough yet, so keep polling.
    let restored = -1;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      restored = await page.evaluate((selector) => {
        const root = document.querySelector(selector) as HTMLElement | null;
        if (!root) {
          return -1;
        }
        const el =
          root.querySelector<HTMLElement>('[data-testid="forest-sections-scroll"]') ??
          root.querySelector<HTMLElement>('[data-testid="tree-table-viewport"]') ??
          root;
        if (el.scrollHeight - el.clientHeight < 600) {
          return -1; // tree not tall enough yet
        }
        return el.scrollTop;
      }, SCROLL_SELECTOR);
      if (restored >= 0 && Math.abs(restored - savedOffset) <= 4) {
        break;
      }
      await page.waitForTimeout(250);
    }

    // Restored within a few px of where we left off (fixed row height → exact,
    // small tolerance for sub-pixel/measurement rounding).
    expect(Math.abs(restored - savedOffset)).toBeLessThanOrEqual(4);
  });
});
