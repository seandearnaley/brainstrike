/**
 * Seed the agent host's open folders and recent folders through its E2E-only
 * seed method, then reload, so the renderer restores the folders and reconciles
 * the durable `roots` rows the UI resolves against.
 *
 * Everything its callers differ on (the recents ledger among them) is a
 * PARAMETER. Both go in one host call, before the only reload that restores
 * them, so the restore's own recents bookkeeping never races the seed.
 */
import type { Page } from '@playwright/test';
import { requestAgentHost } from './agent-host-request';
import { loadElectronHelpers } from './load-electron-helpers';

export interface SeedRootOptions {
  /**
   * Paths to plant in the host's recent-folders ledger: the grants that authorize
   * the picker-less `workspace/roots/add` (BST-1395). Omit for none.
   */
  readonly recentPaths?: readonly string[];
  /** `reloadRenderer` reason string, for log attribution. */
  readonly reloadReason: string;
  /** The durable root id the seeded folder claims. */
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
  { recentPaths = [], reloadReason }: Omit<SeedRootOptions, 'rootId'>
): Promise<void> {
  if (roots.length === 0) {
    throw new Error('seedRoots needs at least one root');
  }
  await seedWorkspaceFolders(page, { recentPaths, roots });
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, reloadReason);
}

/**
 * Replaces the agent host's open folders (with their ids) and recent folders through its E2E-only
 * `workspace/roots/seed-for-e2e`. The renderer restores them on its next reload.
 */
export async function seedWorkspaceFolders(
  page: Page,
  seed: {
    readonly recentPaths?: readonly string[];
    readonly roots: readonly SeededRoot[];
  }
): Promise<void> {
  await requestAgentHost(page, 'workspace/roots/seed-for-e2e', {
    recentPaths: [...(seed.recentPaths ?? [])],
    roots: seed.roots.map((root) => ({ path: root.path, rootId: root.rootId })),
  });
}
