/**
 * Seed main's workspace ledgers through the E2E-only ledger seed channel and
 * reload, so the main process restores the roots on boot and the renderer
 * reconciles the durable `roots` rows the UI resolves against.
 *
 * Everything its callers differ on (the recents ledger among them) is a
 * PARAMETER.
 *
 * ONE evaluate, ONE reload — deliberately. `recentRootsList` MUST be written
 * in the same evaluate as `rootsList`, because the reload boots main, which
 * runs `restoreRoots` → `recordRecentRootIfNew`: a read-modify-write on
 * `recentRootsList`. Seeding recents in a SECOND evaluate after that reload
 * races that write, and seeding them before a second reload would just repeat
 * the race. Both ledgers go in before the only boot that reads them.
 */
import type { Page } from '@playwright/test';
import { updateIndexConfig } from './index-config';
import { loadElectronHelpers } from './load-electron-helpers';

export interface SeedRootOptions {
  /**
   * Pause the profile's search index through Main before the reload. Callers
   * that only exercise the `roots` table and the `git:`/`fs:` bridges want
   * this: indexing the seeded roots adds work and flake surface for no coverage.
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

/** One workspace root to seed; the first one seeded is Main. */
export interface SeededRoot {
  readonly path: string;
  readonly rootId: string;
}

export async function seedRoot(
  page: Page,
  rootPath: string,
  { rootId, ...options }: SeedRootOptions
): Promise<void> {
  await seedRoots(page, [{ path: rootPath, rootId }], options);
}

/** {@link seedRoot} for several roots, in workspace order. */
export async function seedRoots(
  page: Page,
  roots: readonly SeededRoot[],
  {
    disableBackgroundIndexing = false,
    recentPaths = [],
    reloadReason,
  }: Omit<SeedRootOptions, 'rootId'>
): Promise<void> {
  if (roots.length === 0) {
    throw new Error('seedRoots needs at least one root');
  }
  await seedMainLedgers(page, {
    lastFolderPath: roots[0]?.path ?? '',
    rootsList: JSON.stringify(
      roots.map((root, index) => ({
        addedAt: 1_800_000_000_000 + index,
        path: root.path,
        rootId: root.rootId,
      }))
    ),
    ...(recentPaths.length > 0
      ? {
          recentRootsList: JSON.stringify(
            recentPaths.map((recentPath) => ({ lastGrantedAt: 1, path: recentPath }))
          ),
        }
      : {}),
  });
  if (disableBackgroundIndexing) {
    await updateIndexConfig(page, { paused: true });
  }
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, reloadReason);
}

/**
 * Writes Main's workspace ledgers (`rootsList`, `recentRootsList`, `lastFolderPath`) through the
 * E2E-only seed channel. Main restores them on the next renderer reload.
 */
export async function seedMainLedgers(
  page: Page,
  ledgers: Readonly<Record<string, string>>
): Promise<void> {
  await page.evaluate(async (entries) => {
    const fileSystem = (
      globalThis as typeof globalThis & {
        electronAPI?: {
          fileSystem?: { seedLedgerForE2e?: (key: string, value: string) => Promise<void> };
        };
      }
    ).electronAPI?.fileSystem;
    if (!fileSystem?.seedLedgerForE2e) {
      throw new Error('electronAPI.fileSystem.seedLedgerForE2e is unavailable');
    }
    for (const [key, value] of Object.entries(entries)) {
      await fileSystem.seedLedgerForE2e(key, value);
    }
  }, ledgers);
}
