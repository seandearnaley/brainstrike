import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readHostRootRecords, readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import {
  clearDatabaseRecords,
  ensureAssistantShellVisible,
  ensureMockWorkspaceOpen,
} from './utils/layout-helpers';

// Incident #1978: an empty toast is not proof that real durable content cleared.
// Current host approval events replace the retired Mastra workflow SQL fixture.
test('Clear Database removes folders and a waiting host run while retaining configuration @destructive @desktop-db-storage', async ({
  electron,
  modelProvider,
}) => {
  modelProvider.setScript(() => ({
    finalText: 'Read complete',
    toolCall: {
      arguments: { path: 'reset-probe.txt' },
      name: 'brainstrike_readWorkspaceFile',
    },
  }));
  try {
    const page = await electron.ensureWindow();
    const app = await electron.ensureContext();
    const workspace = await app.app.evaluate(
      () => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] ?? ''
    );
    const userData = await app.app.evaluate(({ app }) => app.getPath('userData'));
    expect(workspace).not.toBe('');
    await writeFile(join(workspace, 'reset-probe.txt'), 'Reset probe.\n', 'utf8');
    await ensureMockWorkspaceOpen(page);
    await expect.poll(async () => (await readHostRootRecords(userData)).length).toBe(1);
    await configureAssistantProvider(page, {
      compositeModelKey: 'openrouter::anthropic/claude-sonnet-4.6',
      provider: 'openrouter',
    });
    await enableAssistantCatalogModel(page, 'openrouter::anthropic/claude-sonnet-4.6');
    await new HomePage(page).openSettings();
    await new SettingsPage(page).openCategory(/Permissions/iu, 'permissions');
    await page.getByRole('combobox', { exact: true, name: 'Read permission' }).selectOption('ask');
    await ensureAssistantShellVisible(page);
    const assistant = page.getByRole('region', { exact: true, name: 'Assistant' });
    await assistant.getByRole('textbox', { name: 'Message input' }).fill('Read reset-probe.txt.');
    await assistant.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(
      assistant.getByRole('button', { name: 'Review 1 pending approval' })
    ).toBeVisible();
    const before = await readHostThreadTree(userData);
    expect(
      before.some((thread) => thread.rows.some((row) => row.event.type === 'interaction.requested'))
    ).toBe(true);
    await new HomePage(page).openSettings();
    await new SettingsPage(page).openCategory(/AI Tools/iu, 'ai-tools');
    await page.getByRole('tab', { exact: true, name: 'Tools' }).click();
    const appsToggle = page.getByTestId('mcp-extension-toggle-apps');
    await expect(appsToggle).toHaveAttribute('data-state', 'checked');
    await appsToggle.click();
    await expect(appsToggle).toHaveAttribute('data-state', 'unchecked');
    await expect(appsToggle).toBeEnabled();
    await expect(page.getByTestId('mcp-extension-toggle-tasks')).toHaveAttribute(
      'data-state',
      'checked'
    );
    const retained = await page.evaluate(async () => {
      if (!(window.modelCatalog && window.viewFilterPresets)) {
        throw new Error('Configuration capabilities missing');
      }
      localStorage.setItem('clear-content-retained-setting', 'retained');
      await window.viewFilterPresets
        .request({
          input: { excludes: [], includes: ['src/**'], name: 'Clear retained preset' },
          operation: 'create',
        })
        .then((result) => {
          if (!result.ok) {
            throw new Error(result.error.message);
          }
          return result.value;
        });
      return {
        models: await window.modelCatalog.read().then((result) => {
          if (!result.ok) {
            throw new Error(result.error.message);
          }
          return result.value;
        }),
        presets: await window.viewFilterPresets.request({ operation: 'list' }).then((result) => {
          if (!result.ok) {
            throw new Error(result.error.message);
          }
          return result.value;
        }),
      };
    });
    await clearDatabaseRecords(page);
    const assertCleared = async (current: typeof page) => {
      await expect
        .poll(() =>
          readHostThreadTree(userData).then(
            () => 'answering',
            (error: unknown) => String(error)
          )
        )
        .toBe('answering');
      expect(await readHostRootRecords(userData)).toEqual([]);
      const tree = await readHostThreadTree(userData);
      expect(tree.some((thread) => before.some((old) => old.threadId === thread.threadId))).toBe(
        false
      );
      await new HomePage(current).openSettings();
      await new SettingsPage(current).openCategory(/AI Tools/iu, 'ai-tools');
      await current.getByRole('tab', { exact: true, name: 'Tools' }).click();
      await expect(current.getByTestId('mcp-extension-toggle-apps')).toBeEnabled();
      await expect(current.getByTestId('mcp-extension-toggle-apps')).toHaveAttribute(
        'data-state',
        'unchecked'
      );
      await expect(current.getByTestId('mcp-extension-toggle-tasks')).toHaveAttribute(
        'data-state',
        'checked'
      );
      expect(
        await current.evaluate(async () => ({
          models: await window.modelCatalog!.read().then((result) => {
            if (!result.ok) {
              throw new Error(result.error.message);
            }
            return result.value;
          }),
          presets: await window.viewFilterPresets!.request({ operation: 'list' }).then((result) => {
            if (!result.ok) {
              throw new Error(result.error.message);
            }
            return result.value;
          }),
        }))
      ).toEqual(retained);
      expect(
        await current.evaluate(() => localStorage.getItem('clear-content-retained-setting'))
      ).toBe('retained');
    };
    await assertCleared(page);
    const reopened = await electron.restart();
    await assertCleared(reopened.window);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
  }
});
