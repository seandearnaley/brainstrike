import { HOST_STARTUP_TIMEOUT_MS } from '@brainstrike/host-lease';
import type { Page } from 'playwright';
import { expect } from 'vitest';
import { z } from 'zod';

/**
 * Adds `workspace` through the ordinary Add Folder grant/mount flow (the folder picker answers
 * with it) and returns its root id. Only this flow authorizes a folder for tools: a detached SQL
 * row is disconnected by workspace reconciliation.
 *
 * The folder is recorded through the profile host, so it appears once the host is admitted:
 * the wait is bounded by the host's own start-up contract, not Vitest's default poll clock.
 */
export async function addWorkspaceFolder(page: Page, workspace: string): Promise<string> {
  await page.getByRole('button', { exact: true, name: 'Add Folder to Workspace' }).click();
  let rootId: string | undefined;
  await expect
    .poll(
      async () => {
        const roots = await page.evaluate(async (folder) => {
          const hooks = window.__brainstrikeTestHooks__;
          if (!hooks) {
            return [];
          }
          const restored = await hooks.restoreWorkspaceRoots();
          return restored.filter((root) => root.handle.path === folder);
        }, workspace);
        rootId = z.array(z.object({ rootId: z.string() })).parse(roots)[0]?.rootId;
        return rootId !== undefined;
      },
      { timeout: HOST_STARTUP_TIMEOUT_MS }
    )
    .toBe(true);
  if (rootId === undefined) {
    throw new Error(`Add Folder did not mount ${workspace}`);
  }
  return rootId;
}
