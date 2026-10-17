import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'brainstrike-persona-availability-'))
  );
  const directory = path.join(root, '.brainstrike', 'agents');
  const profile = path.join(directory, 'availability-proof.md');
  await mkdir(directory, { recursive: true });
  await writeFile(
    profile,
    '---\ndescription: Availability proof\nmode: worker\nmodel: anthropic::bst1727-missing-model\ntools: bst1727_missing.edit, readWorkspaceFile\n---\nUse only the permitted tools.'
  );
  try {
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
          )?.status
      )
      .toBe('live');
    await homePage.openSettings();
    await new SettingsPage(window).openCategory(/Subagents/i, 'subagents');
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
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
