import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readCommittedRuns } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

/** The pid in the host record the app publishes under its user-data directory. */
async function hostPid(userDataDir: string): Promise<number> {
  const entries = await readdir(userDataDir, { recursive: true });
  const match = entries.find((entry) => path.basename(String(entry)) === 'host.json');
  if (!match) {
    throw new Error(`No host.json under ${userDataDir}`);
  }
  return decodeHostRecord(JSON.parse(await readFile(path.join(userDataDir, String(match)), 'utf8')))
    .pid;
}

/**
 * The host exits under the GUI (BST-1945, test 2): the window says the agent
 * host is restarting, reattaches to a new host, and a top-level approval is
 * still waiting, from the log, with no model call made by the restart.
 */
test('a host that exits under the GUI is replaced, and a waiting approval survives', async ({
  electron,
  modelProvider,
  window,
}) => {
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(window);
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  await new HomePage(window).openSettings();
  await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
  await window.getByRole('combobox', { exact: true, name: 'Read permission' }).selectOption('ask');
  modelProvider.setScript(({ requestBody, toolNames }) =>
    (requestBody as { stream?: unknown }).stream === true && toolNames.length > 0
      ? {
          finalText: 'Read after the restart.',
          toolCall: { arguments: { path: 'notes.txt' }, name: 'brainstrike_readWorkspaceFile' },
        }
      : { finalText: 'Restart check' }
  );
  await ensureAssistantShellVisible(window);
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill('Read notes.txt');
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  const approve = panel.getByRole('button', {
    exact: true,
    name: 'Approve brainstrike.readWorkspaceFile',
  });
  await expect(approve).toBeVisible({ timeout: E2E_TIMEOUTS.messageVisibility });
  const tabId = await window
    .getByRole('tablist', { name: 'Open assistant threads' })
    .getByRole('tab')
    .first()
    .getAttribute('id');
  const threadId = String(tabId).replace('assistant-thread-tab-', '');
  const requestsBefore = modelProvider.requests().length;

  // Record the restart notice as it appears: the reattach may be quick.
  await window.evaluate(() => {
    const seen = new Set<string>();
    (globalThis as { __restartNotices?: Set<string> }).__restartNotices = seen;
    new MutationObserver(() => {
      if (document.body.innerText.includes('Agent host restarting')) {
        seen.add('restarting');
      }
    }).observe(document.body, { characterData: true, childList: true, subtree: true });
  });
  const userDataDir = electron.getUserDataDir();
  const exited = await hostPid(userDataDir);
  process.kill(exited, 'SIGKILL');

  // A new host serves the window, and the notice appeared while it reattached.
  await expect
    .poll(() => hostPid(userDataDir).catch(() => exited), { timeout: 30_000 })
    .not.toBe(exited);
  await expect
    .poll(() =>
      window.evaluate(() =>
        [...((globalThis as { __restartNotices?: Set<string> }).__restartNotices ?? [])].join()
      )
    )
    .toBe('restarting');
  await expect(panel.getByText('Agent host restarting…')).toHaveCount(0, { timeout: 30_000 });

  // The approval is still waiting, from the log, and the restart made no model call.
  const runs = await readCommittedRuns(userDataDir, threadId);
  expect(runs.at(-1)).toMatchObject({ status: 'running' });
  expect(runs.at(-1)?.approvals).toHaveLength(1);
  expect(modelProvider.requests()).toHaveLength(requestsBefore);
  await expect(approve).toBeVisible();

  // Approving it on the new host finishes the run.
  await approve.click();
  await expect(panel.getByText('Read after the restart.', { exact: true })).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  expect(modelProvider.refusals()).toEqual([]);
});
