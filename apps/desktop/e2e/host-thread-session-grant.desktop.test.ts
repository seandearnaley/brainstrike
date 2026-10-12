import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const TOOL = 'brainstrike.writeWorkspaceFile';
const FINAL = 'Both files written.';
// The mock workspace is this real disposable folder, so edits land on disk.
const workspace = mkdtempSync(join(tmpdir(), 'bs-e2e-session-grant-'));

test.use({ electronEnv: { BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace } });
test.afterAll(() => rmSync(workspace, { force: true, recursive: true }));

/** A session grant chosen on one approval reaches the host: the run's next edit does not ask. */
test('approving with "Allow edits this session" lets the same run edit again without asking', async ({
  modelProvider,
  window,
}) => {
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  await new HomePage(window).openSettings();
  await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
  await window.getByTestId('permission-policy-edit').selectOption('ask');
  modelProvider.setScript(({ requestBody, toolNames }) =>
    (requestBody as { stream?: unknown }).stream === true && toolNames.length > 0
      ? {
          finalText: FINAL,
          toolCallStages: [
            [
              {
                arguments: { content: 'first\n', path: 'first.txt' },
                name: 'brainstrike_writeWorkspaceFile',
              },
            ],
            [
              {
                arguments: { content: 'second\n', path: 'second.txt' },
                name: 'brainstrike_writeWorkspaceFile',
              },
            ],
          ],
        }
      : { finalText: 'Session grant check' }
  );
  await ensureAssistantShellVisible(window);
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill('Write first.txt, then second.txt.');
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();

  const grant = panel.getByRole('button', {
    exact: true,
    name: `Allow edits this session ${TOOL}`,
  });
  await expect(grant).toBeVisible({ timeout: E2E_TIMEOUTS.messageVisibility });
  await grant.click();

  // The second edit ran without a request: the run finished with no other click.
  await expect(panel.getByText(FINAL).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  expect(await readFile(join(workspace, 'first.txt'), 'utf8')).toBe('first\n');
  expect(await readFile(join(workspace, 'second.txt'), 'utf8')).toBe('second\n');
  await expect(panel.getByRole('button', { exact: true, name: `Approve ${TOOL}` })).toHaveCount(0);
  expect(modelProvider.refusals()).toEqual([]);
});
