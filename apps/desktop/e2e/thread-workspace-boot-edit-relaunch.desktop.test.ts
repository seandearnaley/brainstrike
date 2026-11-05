import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readHostThreadWorkspace, waitForAppHost } from './utils/agent-host-log';
import { openDurableUiFixture } from './utils/durable-ui-state';

const TAB_STORE = 'brainstrike:workspace-tab-selection.v1';
const HOST_READY_DELAY_MS = 15_000;

test.use({
  electronEnv: { BRAINSTRIKE_E2E_LIFECYCLE_DELAYS: `host-ready:${HOST_READY_DELAY_MS}` },
});

/**
 * BST-2281, live: every launch's agent host is slow to become ready, so the boot read of the
 * active thread's stored workspace is still pending when the user opens a tab and quits. Read
 * where each copy is committed: the tab store in the profile's localStorage, the thread's
 * workspace from the agent host.
 */
test('a tab opened while the agent host is still starting survives quit and relaunch', async ({
  electron,
  window,
}) => {
  test.setTimeout(300_000);
  // Launch 1: a thread whose workspace the host has stored, active in the window.
  const fixture = await openDurableUiFixture(electron, window);
  const userDataDir = electron.getUserDataDir();
  const saved = await readHostThreadWorkspace(userDataDir, fixture.threadId);
  expect(saved?.apps.openAppIds).not.toContain('logs');
  await electron.closeForStateSeeding();

  // Launch 2: before the host answers, the user opens Logs, then quits.
  const booting = await electron.ensureWindow({ preserveState: true });
  // The thread catalog read waits on the host; the workspace read goes through that catalog.
  const connecting = booting.getByText('Loading threads…');
  await expect(connecting).toBeVisible({ timeout: 10_000 });
  await booting.getByTestId('workspace-add-tab').click({ timeout: 10_000 });
  await booting.getByRole('menuitem', { name: /Logs/u }).click();
  await expect.poll(() => openAppIds(booting)).toContain('logs');
  // The catalog is still loading, so the boot workspace read cannot have been answered.
  await expect(connecting).toBeVisible();
  await electron.closeForStateSeeding();

  // Launch 3: what the user sees once hydration has applied.
  const reopened = await electron.ensureWindow({ preserveState: true });
  const atBoot = await openAppIds(reopened);
  await waitForAppHost(reopened);
  let row: readonly string[] | undefined;
  // Hydration has applied once the tab store and the host's row agree.
  await expect
    .poll(
      async () => {
        row = (await readHostThreadWorkspace(userDataDir, fixture.threadId))?.apps.openAppIds;
        return JSON.stringify(await openAppIds(reopened)) === JSON.stringify(row);
      },
      { timeout: 60_000 }
    )
    .toBe(true);
  expect({ afterHydration: await openAppIds(reopened), atBoot, row }).toEqual({
    afterHydration: expect.arrayContaining(['logs']),
    atBoot: expect.arrayContaining(['logs']),
    row: expect.arrayContaining(['logs']),
  });
});

async function openAppIds(page: Page): Promise<readonly string[]> {
  return await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw
      ? ((JSON.parse(raw) as { state?: { openAppIds?: string[] } }).state?.openAppIds ?? [])
      : [];
  }, TAB_STORE);
}
