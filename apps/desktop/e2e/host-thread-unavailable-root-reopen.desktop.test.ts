import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readHostThreadTree, withAppHost } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';

const API_KEY = 'test-key-root-restore';
const MODEL = 'openrouter::anthropic/claude-sonnet-4.6';
test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function send(page: Page, prompt: string, reply: string): Promise<void> {
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  await region.getByRole('textbox', { name: 'Message input' }).fill(prompt);
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText(reply, { exact: true })).toBeVisible({ timeout: 90_000 });
}

test('after all saved folders become unavailable, a fresh unbound chat sends while the old binding stays unavailable @smoke', async ({
  electron,
  electronApp,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(240_000);
  const rootPath = await electronApp.app.evaluate(
    () => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] ?? ''
  );
  expect(rootPath).not.toBe('');
  const parkedPath = `${rootPath}-unavailable`;
  let parked = false;
  await writeFile(path.join(rootPath, 'root-restore.txt'), 'current-format root fixture\n');
  modelProvider.setScript(({ messages }) => ({
    finalText: JSON.stringify(messages).includes('UNBOUND_AFTER_REOPEN')
      ? 'UNBOUND_SEND_SUCCEEDED'
      : 'BOUND_SEND_SUCCEEDED',
  }));
  try {
    await ensureMockWorkspaceOpen(page);
    await expect(page.getByText('root-restore.txt').first()).toBeVisible({ timeout: 60_000 });
    await configureAssistantProvider(page, {
      apiKey: API_KEY,
      compositeModelKey: MODEL,
      provider: 'openrouter',
    });
    await enableAssistantCatalogModel(page, MODEL);
    await ensureAssistantShellVisible(page);
    await send(page, 'BOUND_BEFORE_REOPEN', 'BOUND_SEND_SUCCEEDED');
    const userDataDir = electron.getUserDataDir();
    const boundThread = (await readHostThreadTree(userDataDir)).find(({ rows }) =>
      rows.some(({ event }) => event.type === 'run.started')
    );
    if (!boundThread) {
      throw new Error('The first send committed no host thread');
    }
    const before = await withAppHost(userDataDir, (client) =>
      client.request('thread/workspace/binding/read', { threadId: boundThread.threadId })
    );
    expect(before.binding?.operatingRootId).toBeTruthy();

    // Actual process shutdown and physical unavailability, with the saved grant
    // and current-format application/profile data left intact.
    await electron.closeForStateSeeding();
    await rename(rootPath, parkedPath);
    parked = true;
    const reopened = (await electron.restart()).window;
    await ensureAssistantShellVisible(reopened);
    const folder = reopened
      .getByRole('region', { exact: true, name: 'Assistant' })
      .getByTestId('workspace-bar-folder-chip');
    await expect(folder).toHaveAccessibleName(/removed from the workspace/u, { timeout: 30_000 });
    await folder.click();
    await reopened.getByTestId(`workspace-bar-root-${before.binding?.operatingRootId}`).focus();
    await reopened.keyboard.press('ArrowRight');
    await expect(reopened.getByText('Re-add folder', { exact: true })).toBeVisible();
    await reopened.keyboard.press('ArrowLeft');
    await reopened.keyboard.press('Escape');

    await reopened.getByTestId('assistant-new-thread-button').click();
    await expect(folder).toHaveAccessibleName('Choose a folder');
    await send(reopened, 'UNBOUND_AFTER_REOPEN', 'UNBOUND_SEND_SUCCEEDED');
    const after = await withAppHost(userDataDir, (client) =>
      client.request('thread/workspace/binding/read', { threadId: boundThread.threadId })
    );
    expect(after.binding).toEqual(before.binding);
    const newThread = (await readHostThreadTree(userDataDir)).find(
      ({ threadId, rows }) =>
        threadId !== boundThread.threadId && rows.some(({ event }) => event.type === 'run.started')
    );
    expect(newThread).toBeDefined();
    const starts = newThread?.rows.flatMap(({ event }) =>
      event.type === 'run.started' ? [event.snapshot] : []
    );
    expect(starts).toHaveLength(1);
    expect(starts?.[0]?.workspaceBinding?.operatingRootId).toBeUndefined();
    expect(starts?.[0]?.configuration['intent']).not.toHaveProperty('selectionFolderId');
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    if (parked) {
      await rename(parkedPath, rootPath);
    }
  }
});
