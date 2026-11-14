/** Current desktop conversations are created through the public host protocol. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { withAppHost } from './agent-host-log';
import { restoreWorkspaceFolders } from './agent-host-request';

/** A host-committed mounted workspace descriptor. */
export interface WorkspaceRootRow {
  readonly displayName: string;
  readonly id: string;
  readonly path: string | null;
}

/** One thread to seed. `folder: null` seeds an UNBOUND thread ("No project"). */
export interface SeedThreadSpec {
  /**
   * A managed worktree the thread is checked out into: `folder` is the worktree's own root, and
   * `localRootId` the folder a hand-off returns it to.
   */
  readonly checkout?: {
    readonly localRootId: string;
    readonly worktreeId: string;
    readonly worktreePath: string;
  };
  readonly folder: WorkspaceRootRow | null;
  readonly title: string;
}

/** Every open folder the host's root registry restores, in id order. */
async function readWorkspaceRootRows(page: Page): Promise<readonly WorkspaceRootRow[]> {
  return (await restoreWorkspaceFolders(page))
    .map((root) => ({
      displayName: path.basename(root.path) || root.path,
      id: root.rootId,
      path: root.path,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Wait for the one host-committed mount expected by a fresh single-root fixture. */
export async function waitForSingleWorkspaceRootRow(
  page: Page,
  timeoutMs = 30_000
): Promise<WorkspaceRootRow> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen: readonly WorkspaceRootRow[] = [];
  for (;;) {
    lastSeen = await readWorkspaceRootRows(page);
    const [root] = lastSeen;
    if (lastSeen.length === 1 && root) {
      return root;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Expected exactly one reconciled workspace root within ${timeoutMs}ms, found ${lastSeen.length}: ${JSON.stringify(lastSeen)}`
      );
    }
    await page.waitForTimeout(250);
  }
}

/** Seed current conversations through the same owner that lists and opens them. */
export async function seedHostThreads(
  userDataDir: string,
  specs: readonly SeedThreadSpec[]
): Promise<readonly string[]> {
  return await withAppHost(userDataDir, async (host) => {
    const ids: string[] = [];
    for (const spec of specs) {
      const { threadId } = await host.request('thread/start', { commandId: randomUUID() });
      await host.request('thread/update', { commandId: randomUUID(), threadId, title: spec.title });
      if (spec.folder) {
        await host.request('thread/workspace/binding/update', {
          commandId: randomUUID(),
          patch: {
            operatingRootDisplayName: spec.folder.displayName,
            operatingRootId: spec.folder.id,
            ...(spec.folder.path ? { operatingRootPath: spec.folder.path } : {}),
            ...(spec.checkout
              ? {
                  checkoutLocalRootId: spec.checkout.localRootId,
                  checkoutMode: 'worktree',
                  checkoutWorktreeId: spec.checkout.worktreeId,
                  checkoutWorktreePath: spec.checkout.worktreePath,
                }
              : {}),
          },
          threadId,
        });
      }
      ids.push(threadId);
    }
    return ids;
  });
}
