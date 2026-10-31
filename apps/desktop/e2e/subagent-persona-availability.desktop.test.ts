import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { SettingsPage } from './page-objects/settings-page';
import { readHostRootRecords, waitForAppHost } from './utils/agent-host-log';
import { seedRoot } from './utils/seed-root';

test('shows actual host persona issues and refreshes an edited profile @smoke', async ({
  window,
  homePage,
  electron,
}) => {
  const root = electron.getWorkspaceRoot();
  const directory = path.join(root, '.brainstrike', 'agents');
  const profile = path.join(directory, 'availability-proof.md');
  await mkdir(directory, { recursive: true });
  await writeFile(
    profile,
    '---\ndescription: Availability proof\nmode: worker\nmodel: anthropic::bst1727-missing-model\ntools: bst1727_missing.edit, readWorkspaceFile\n---\nUse only the permitted tools.'
  );
  await seedRoot(window, root, {
    disableBackgroundIndexing: true,
    reloadReason: 'persona-availability-mounted-workspace',
    rootId: 'bst1727-availability-root',
  });
  // The fresh app's host publishes its record after the renderer is ready.
  await waitForAppHost(window);
  await expect
    .poll(
      async () =>
        (await readHostRootRecords(electron.getUserDataDir())).find(
          (row) => row.id === 'bst1727-availability-root'
        )?.status,
      { timeout: test.info().timeout }
    )
    .toBe('live');
  await homePage.openSettings();
  const settings = new SettingsPage(window);
  // ADR-0032: a folder's personas are listed, as runs load them, once the person trusts it.
  const trust = await settings.openCategory(/Workspace trust/iu, 'workspace-trust');
  const row = trust.getByRole('listitem').filter({ hasText: path.basename(root) });
  await row.getByRole('button', { exact: true, name: 'Trust' }).click();
  await expect(row).toContainText('Trusted');
  await settings.openCategory(/Subagents/iu, 'subagents');
  // Settings is keep-mounted; refresh after root reconciliation completed.
  await window.getByRole('button', { name: 'Refresh personas and host checks' }).click();
  const availability = window.getByTestId('subagent-persona-availability-availability-proof');
  await expect(availability).toContainText('bst1727-missing-model');
  await expect(availability).toContainText('bst1727_missing.edit');
  await expect(window.getByTestId('subagent-persona-scope-availability-proof')).toContainText(
    'Declared scope: Worker mode'
  );
  await writeFile(
    profile,
    '---\ndescription: Corrected read-only profile\n---\nInspect the workspace.'
  );
  await window.getByRole('button', { name: 'Refresh personas and host checks' }).click();
  await expect(window.getByText('Corrected read-only profile', { exact: true })).toBeVisible();
  await expect(availability).toBeEmpty();
  await expect(window.getByTestId('subagent-persona-scope-availability-proof')).toContainText(
    'Declared scope: Read-only'
  );
});
