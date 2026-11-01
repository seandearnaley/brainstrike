import { HOST_STARTUP_TIMEOUT_MS } from '@brainstrike/host-lease';
import type { Page } from 'playwright';
import { expect } from 'vitest';
import { readOpenWorkspaceFolders } from '../../../e2e/utils/agent-host-log';

/**
 * Adds `workspace` through the ordinary Add Folder grant/mount flow (the folder picker answers
 * with it) and returns its root id. Only this flow authorizes a folder for tools: a detached SQL
 * row is disconnected by workspace reconciliation.
 *
 * The host's root registry commits the open folder in `hostRoot`'s store once the host is
 * admitted: the wait is bounded by the host's own start-up contract, not Vitest's default poll
 * clock.
 */
export async function addWorkspaceFolder(
  page: Page,
  workspace: string,
  hostRoot: string
): Promise<string> {
  await page.getByRole('button', { exact: true, name: 'Add Folder to Workspace' }).click();
  let rootId: string | undefined;
  await expect
    .poll(
      () => {
        rootId = readOpenWorkspaceFolders(hostRoot).find(
          (root) => root.path === workspace && root.status === 'live'
        )?.id;
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
