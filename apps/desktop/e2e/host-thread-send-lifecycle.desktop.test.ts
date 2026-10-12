import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';

async function openHostThread(page: Page): Promise<void> {
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(page);
  await ensureMockWorkspaceOpen(page);
  await configureAssistantProvider(page);
  await ensureAssistantShellVisible(page);
}

function assistantRegion(page: Page) {
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  return { input: region.getByRole('textbox', { name: 'Message input' }), region };
}

/**
 * BST-1981: the composer's running state follows the host's committed run, so
 * it lags the host's admission of a send. Only the external provider is
 * simulated; admission, the committed log and the composer are the real ones.
 */
test('a second send while the first is being admitted keeps its draft and starts no second run', async ({
  electron,
  modelProvider,
}) => {
  test.setTimeout(120_000);
  const page = await electron.ensureWindow();
  await openHostThread(page);
  const hold = Promise.withResolvers<void>();
  modelProvider.setScript(({ messages, toolNames }) => {
    // The title request carries no tools.
    if (toolNames.length === 0) {
      return { finalText: 'Send lifecycle' };
    }
    return JSON.stringify(messages).includes('Second message')
      ? { finalText: 'SECOND_REPLY' }
      : { beforeFinalText: hold.promise, finalText: 'FIRST_REPLY' };
  });
  const { input, region } = assistantRegion(page);
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill('First message');
  // Two Enters milliseconds apart, as a fast typist sends them.
  await input.press('Enter');
  await input.fill('Second message');
  await input.press('Enter');

  await expect(region.getByRole('button', { exact: true, name: 'Stop' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('alert', { name: 'Agent command error' })).toHaveCount(0);
  await expect(input).toHaveValue('Second message');
  hold.resolve();
  await expect(region.getByText('FIRST_REPLY', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(region.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);
  await expect(input).toHaveValue('Second message');
  const runTurns = () => modelProvider.requests().filter(({ toolNames }) => toolNames.length > 0);
  expect(JSON.stringify(runTurns().map(({ messages }) => messages))).not.toContain(
    'Second message'
  );

  // The kept draft sends normally once the first run has ended.
  await input.press('Enter');
  await expect(region.getByText('SECOND_REPLY', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('alert', { name: 'Agent command error' })).toHaveCount(0);
  expect(modelProvider.refusals()).toEqual([]);
});

test('a run the host interrupted when the app quit is marked after relaunch', async ({
  electron,
  modelProvider,
}) => {
  test.setTimeout(180_000);
  let page = await electron.ensureWindow();
  await openHostThread(page);
  const hold = Promise.withResolvers<void>();
  modelProvider.setScript(({ toolNames }) =>
    toolNames.length === 0
      ? { finalText: 'Interrupted lifecycle' }
      : { beforeFinalText: hold.promise, finalText: 'NEVER_COMMITTED' }
  );
  const { input, region } = assistantRegion(page);
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill('Run until the app quits.');
  await input.press('Enter');
  await expect(region.getByRole('button', { exact: true, name: 'Stop' })).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(() => modelProvider.requests().filter(({ toolNames }) => toolNames.length > 0).length)
    .toBeGreaterThan(0);

  // Quit mid-run: the provider turn is still open, so the host ends the run.
  await electron.closeForStateSeeding();
  hold.resolve();
  page = await electron.ensureWindow();
  await openHostThread(page);
  const relaunched = assistantRegion(page).region;
  await expect(relaunched.getByText('Run until the app quits.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(relaunched.getByText('Reply interrupted', { exact: true })).toBeVisible();
  await expect(relaunched.getByText('NEVER_COMMITTED', { exact: true })).toHaveCount(0);
});
