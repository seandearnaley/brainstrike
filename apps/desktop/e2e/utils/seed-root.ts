/**
 * Seed the profile's workspace ledgers through the agent host and reload, so the
 * host restores the roots on boot and the renderer reconciles the durable `roots`
 * rows the UI resolves against (ADR-0029 stage 4: the host owns the ledgers).
 *
 * Lifted out of `git-panel.desktop.test.ts` (where the shape originated) when
 * `workspace-bar.desktop.test.ts` needed the same seed plus the recents
 * ledger. Everything the two callers differ on is a PARAMETER, so lifting
 * changed no existing test's behavior.
 *
 * ONE seed, ONE reload — deliberately. The recent-roots ledger MUST be written
 * in the same seed as the roots, because the reload's boot restores the roots
 * and records each as a recent grant: a read-modify-write on the recents.
 * Seeding recents after that reload races that write, and seeding them before a
 * second reload would just repeat the race. Both ledgers go in before the only
 * boot that reads them.
 */
import type { RecentRootEntry, RootDescriptor } from '@brainstrike/types';
import type { Page } from '@playwright/test';
import { updateIndexConfig } from './index-config';
import { loadElectronHelpers } from './load-electron-helpers';

export interface SeedRootOptions {
  /**
   * Pause the profile's search index through Main before the reload. Callers
   * that only exercise the `roots` table and the host's git and file methods want
   * this: indexing the seeded roots adds work and flake surface for no coverage.
   */
  readonly disableBackgroundIndexing?: boolean;
  /**
   * Paths to plant in the recent-roots ledger — the grants that authorize
   * the picker-less `files/add-root-by-path` (BST-1395). Omit for none.
   */
  readonly recentPaths?: readonly string[];
  /** `reloadRenderer` reason string, for log attribution. */
  readonly reloadReason: string;
  /** The durable root id the seeded root claims. */
  readonly rootId: string;
}

/** One workspace root to seed; the first one seeded is Main. */
export interface SeededRoot {
  readonly path: string;
  readonly rootId: string;
}

/** The folder ledgers a test starts from: its roots, last folder and recent grants. */
export interface WorkspaceRootsSeed {
  readonly lastFolderPath: string;
  readonly recentPaths: readonly string[];
  readonly roots: readonly SeededRoot[];
}

/** The renderer's test-mode hooks onto the host's folder ledgers. */
interface WorkspaceRootTestHooks {
  readonly recentWorkspaceRoots: () => Promise<readonly RecentRootEntry[]>;
  readonly restoreWorkspaceRoots: () => Promise<readonly RootDescriptor[]>;
  readonly seedWorkspaceRoots: (seed: WorkspaceRootsSeed) => Promise<void>;
}
type TestHookGlobals = typeof globalThis & {
  readonly __brainstrikeTestHooks__?: WorkspaceRootTestHooks;
};

/** The hooks exist once the renderer's app has mounted. */
async function waitForRootHooks(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (globalThis as TestHookGlobals).__brainstrikeTestHooks__ !== undefined
  );
}

/**
 * Write the folder ledgers through the host, without reloading. The caller's
 * next boot (a reload or a relaunch) restores them.
 */
export async function seedWorkspaceLedgers(page: Page, seed: WorkspaceRootsSeed): Promise<void> {
  await waitForRootHooks(page);
  await page.evaluate(async (payload: WorkspaceRootsSeed) => {
    const hooks = (globalThis as TestHookGlobals).__brainstrikeTestHooks__;
    if (!hooks) {
      throw new Error('The desktop test hooks are unavailable');
    }
    await hooks.seedWorkspaceRoots(payload);
  }, seed);
}

/** Every folder the host restores, as the Explorer reads them. */
export async function restoredWorkspaceRoots(page: Page): Promise<readonly RootDescriptor[]> {
  await waitForRootHooks(page);
  return await page.evaluate(async () => {
    const hooks = (globalThis as TestHookGlobals).__brainstrikeTestHooks__;
    if (!hooks) {
      throw new Error('The desktop test hooks are unavailable');
    }
    return await hooks.restoreWorkspaceRoots();
  });
}

/** The host's recent-folder grants, newest first. */
export async function recentWorkspaceRoots(page: Page): Promise<readonly RecentRootEntry[]> {
  await waitForRootHooks(page);
  return await page.evaluate(async () => {
    const hooks = (globalThis as TestHookGlobals).__brainstrikeTestHooks__;
    if (!hooks) {
      throw new Error('The desktop test hooks are unavailable');
    }
    return await hooks.recentWorkspaceRoots();
  });
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
  const [first] = roots;
  if (!first) {
    throw new Error('seedRoots needs at least one root');
  }
  await seedWorkspaceLedgers(page, { lastFolderPath: first.path, recentPaths, roots });
  if (disableBackgroundIndexing) {
    await updateIndexConfig(page, { paused: true });
  }
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, reloadReason);
}
