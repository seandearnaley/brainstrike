/** Current desktop conversations are created through the public host protocol. */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { withAppHost } from './agent-host-log';

/** A host-committed mounted workspace descriptor. */
export interface WorkspaceRootRow {
  readonly displayName: string;
  readonly id: string;
  readonly path: string | null;
}

/** One thread to seed. `folder: null` seeds an UNBOUND thread ("No folder"). */
export interface SeedThreadSpec {
  readonly folder: WorkspaceRootRow | null;
  readonly title: string;
}

/** Every reconciled root row, in id order. */
export async function readWorkspaceRootRows(page: Page): Promise<readonly WorkspaceRootRow[]> {
  return await page.evaluate(async () => {
    const files = window.electronAPI?.fileSystem;
    if (!files) {
      throw new Error('Desktop filesystem capability is unavailable');
    }
    const reply = await files.restoreRoots();
    if (!reply.ok) {
      throw new Error(reply.error.message);
    }
    return reply.value
      .map((root) => ({
        displayName: root.displayName,
        id: root.rootId,
        path: root.handle.path ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  });
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
          },
          threadId,
        });
      }
      ids.push(threadId);
    }
    return ids;
  });
}
