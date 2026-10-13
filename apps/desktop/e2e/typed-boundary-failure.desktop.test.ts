import { symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  encodeFileMentionId,
  serializeFileMentionDirective,
} from '@brainstrike/assistant-contract';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { withAppHost } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { waitForSingleWorkspaceRootRow } from './utils/seed-threads';

/** Main reply fixture crosses the real sandboxed preload and contextBridge. */
test('a transported refusal keeps its remedy and reaches the shipped Settings surface', async ({
  electronApp,
}) => {
  const failure = {
    category: 'availability',
    code: 'logging.unavailable',
    kind: 'refusal',
    message: 'Logging preferences are unavailable.',
    remedy: 'Reopen Settings to try again.',
  } as const;
  await electronApp.app.evaluate(({ ipcMain }, wire) => {
    ipcMain.removeHandler('logging:get-preferences');
    ipcMain.handle('logging:get-preferences', () => ({ error: wire, ok: false }));
  }, failure);
  const wire = await electronApp.window.evaluate(() =>
    (
      window as unknown as Window & { logging: { getPreferences(): Promise<unknown> } }
    ).logging.getPreferences()
  );
  expect(wire).toEqual({ error: failure, ok: false });
  await new HomePage(electronApp.window).openSettings();
  const settings = new SettingsPage(electronApp.window);
  await settings.expectLoaded();
  const category = await settings.openCategory('Logging & Diagnostics', 'logging');
  await expect(
    category.getByText(`${failure.message} ${failure.remedy}`, { exact: true })
  ).toBeVisible();
});

/** BST-2007: an actual failed @file read must reach the person as well as the model. */
test('missing and dangling references show durable per-file notices while valid content is attached', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  await ensureMockWorkspaceOpen(page);
  await configureAssistantProvider(page);
  const root = await waitForSingleWorkspaceRootRow(page);
  if (!root.path) {
    throw new Error('Expected a mounted disposable workspace path');
  }
  const target = `${root.path}-absent-outside-target`;
  await writeFile(path.join(root.path, 'good.txt'), 'VALID_REFERENCE_CONTENT');
  await symlink(target, path.join(root.path, 'dangling.txt'));
  let modelContext: string | undefined;
  modelProvider.setScript(({ messages, requestBody, toolNames }) => {
    if ((requestBody as { stream?: unknown }).stream === true && toolNames.length > 0) {
      modelContext = JSON.stringify(messages);
      return { finalText: 'REFERENCE_NOTICE_REPLY' };
    }
    return { finalText: 'Referenced files' };
  });
  await ensureAssistantShellVisible(page);
  const panel = page.getByRole('region', { exact: true, name: 'Assistant' });
  const references = ['missing.txt', 'dangling.txt', 'good.txt'].map((file) =>
    serializeFileMentionDirective({ id: encodeFileMentionId(root.id, file), label: file })
  );
  await panel.getByRole('textbox', { name: 'Message input' }).fill(`Read ${references.join(' ')}`);
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(panel.getByText('REFERENCE_NOTICE_REPLY', { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  expect(modelContext).toContain('VALID_REFERENCE_CONTENT');
  expect(modelContext).toContain(JSON.stringify('Path "missing.txt" does not exist.').slice(1, -1));
  expect(modelContext).toContain('outside the selected workspace root');
  expect(modelContext).not.toContain(target);
  expect(modelContext).not.toContain(path.join(root.path, 'missing.txt'));
  expect(modelContext).not.toContain('ENOENT');
  const readNotices = () =>
    withAppHost(electron.getUserDataDir(), async (client) => {
      const { threads } = await client.request('thread/list', {});
      const logs = await Promise.all(
        threads.map((t) => client.request('thread/read', { fromSeq: 0, threadId: t.threadId }))
      );
      return logs
        .flatMap((log) => log.rows)
        .filter((row) => row.event.type === 'references.unavailable');
    });
  const committed = await readNotices();
  expect(committed).toHaveLength(1);
  const batch = committed[0]?.event;
  if (batch?.type !== 'references.unavailable') {
    throw new Error('Missing committed reference batch');
  }
  expect(batch.files).toHaveLength(2);
  const requests = modelProvider.requests().length;
  for (const reload of [false, true]) {
    if (reload) {
      await page.reload();
      await (await loadElectronHelpers()).waitForAppReady(page);
      await ensureAssistantShellVisible(page);
    }
    await expect(
      panel.getByText('Referenced file could not be attached', { exact: true })
    ).toHaveCount(2);
    await expect(
      panel.getByText('missing.txt: Path "missing.txt" does not exist.', { exact: true })
    ).toBeVisible();
    await expect(
      panel.getByText('dangling.txt: Path "dangling.txt" is outside the selected workspace root.', {
        exact: true,
      })
    ).toBeVisible();
    expect(await readNotices()).toEqual(committed);
    expect(modelProvider.requests().length).toBe(requests);
  }
  expect(modelProvider.refusals()).toEqual([]);
});
