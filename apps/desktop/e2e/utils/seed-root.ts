/**
 * Seed main's workspace ledgers through the renderer's `storage:` bridge and
 * reload, so the main process restores the roots on boot and the renderer
 * reconciles the durable `roots` rows the UI resolves against.
 *
 * Lifted out of `git-panel.desktop.test.ts` (where the shape originated) when
 * `workspace-bar.desktop.test.ts` needed the same seed plus the recents
 * ledger. Everything the two callers differ on is a PARAMETER, so lifting
 * changed no existing test's behavior.
 *
 * ONE evaluate, ONE reload — deliberately. `recentRootsList` MUST be written
 * in the same evaluate as `rootsList`, because the reload boots main, which
 * runs `restoreRoots` → `recordRecentRootIfNew`: a read-modify-write on
 * `recentRootsList`. Seeding recents in a SECOND evaluate after that reload
 * races that write, and seeding them before a second reload would just repeat
 * the race. Both ledgers go in before the only boot that reads them.
 */
import type { Page } from '@playwright/test';
import { loadElectronHelpers } from './load-electron-helpers';

export interface SeedRootOptions {
  /**
   * Seed the background-indexing store OFF. Callers that only exercise the
   * `roots` table and the `git:`/`fs:` bridges want this: driving the
   * embedding pipeline would add minutes and flake surface for no coverage.
   */
  readonly disableBackgroundIndexing?: boolean;
  /**
   * Paths to plant in main's recent-roots ledger — the grants that authorize
   * the picker-less `fs:addRootByPath` (BST-1395). Omit for none.
   */
  readonly recentPaths?: readonly string[];
  /** `reloadRenderer` reason string, for log attribution. */
  readonly reloadReason: string;
  /** The durable root id the seeded `rootsList` entry claims. */
  readonly rootId: string;
}

interface SeedPayload {
  readonly disableBackgroundIndexing: boolean;
  readonly recentPaths: readonly string[];
  readonly rootId: string;
  readonly rootPath: string;
}

export async function seedRoot(
  page: Page,
  rootPath: string,
  { disableBackgroundIndexing = false, recentPaths = [], reloadReason, rootId }: SeedRootOptions
): Promise<void> {
  await page.evaluate(
    async ({
      disableBackgroundIndexing: disableIndexing,
      recentPaths: recents,
      rootId: id,
      rootPath: p,
    }: SeedPayload) => {
      const storage = (
        globalThis as typeof globalThis & {
          electronAPI?: { storage?: { setItem?: (k: string, v: string) => Promise<void> } };
        }
      ).electronAPI?.storage;
      if (!storage?.setItem) {
        throw new Error('electronAPI.storage.setItem unavailable');
      }
      await storage.setItem('lastFolderPath', p);
      await storage.setItem(
        'rootsList',
        JSON.stringify([{ addedAt: 1_800_000_000_000, path: p, rootId: id }])
      );
      if (recents.length > 0) {
        await storage.setItem(
          'recentRootsList',
          JSON.stringify(recents.map((recentPath) => ({ lastGrantedAt: 1, path: recentPath })))
        );
      }
      if (disableIndexing) {
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
      }
    },
    { disableBackgroundIndexing, recentPaths, rootId, rootPath } satisfies SeedPayload
  );
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, reloadReason);
}
