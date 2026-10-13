import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readHostThreadTree, withAppHost } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { clearDatabaseRecords, ensureAssistantShellVisible } from './utils/layout-helpers';
import { readNativeResetProbe, seedNativeResetProbe } from './utils/reset-seed-helpers';

// Incident #1978: an empty toast is not proof that real durable content cleared.
// Current host approval events replace the retired Mastra workflow SQL fixture.
test('Clear Database removes native files and a waiting host run while retaining configuration @destructive @desktop-db-storage', async ({
  electron,
  modelProvider,
}) => {
  modelProvider.setScript(() => ({
    finalText: 'Read complete',
    toolCall: {
      arguments: { path: 'reset-indexed-probe.txt' },
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
    const probe = await seedNativeResetProbe(page, workspace);
    await configureAssistantProvider(page, {
      compositeModelKey: 'openrouter::anthropic/claude-sonnet-4.6',
      provider: 'openrouter',
    });
    await enableAssistantCatalogModel(page, 'openrouter::anthropic/claude-sonnet-4.6');
    await new HomePage(page).openSettings();
    await new SettingsPage(page).openCategory(/Permissions/i, 'permissions');
    await page.getByRole('combobox', { exact: true, name: 'Read permission' }).selectOption('ask');
    await ensureAssistantShellVisible(page);
    const assistant = page.getByRole('region', { exact: true, name: 'Assistant' });
    await assistant
      .getByRole('textbox', { name: 'Message input' })
      .fill('Read reset-indexed-probe.txt.');
    await assistant.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(
      assistant.getByRole('button', { name: 'Review 1 pending approval' })
    ).toBeVisible();
    const before = await readHostThreadTree(userData);
    expect(
      before.some((thread) => thread.rows.some((row) => row.event.type === 'interaction.requested'))
    ).toBe(true);
    await withAppHost(userData, (client) =>
      client.request('mcp/extensions/set', { apps: false, tasks: true })
    );
    const retained = await page.evaluate(async () => {
      if (!(window.modelCatalog && window.viewFilterPresets)) {
        throw new Error('Configuration capabilities missing');
      }
      localStorage.setItem('clear-content-retained-setting', 'retained');
      await window.viewFilterPresets.request({
        input: { excludes: [], includes: ['src/**'], name: 'Clear retained preset' },
        operation: 'create',
      });
      return {
        models: await window.modelCatalog.read(),
        presets: await window.viewFilterPresets.request({ operation: 'list' }),
      };
    });
    await clearDatabaseRecords(page);
    const assertCleared = async (current: typeof page) => {
      expect(await readNativeResetProbe(current, probe)).toEqual({
        files: 0,
        retainedProbeIds: [],
      });
      const tree = await readHostThreadTree(userData);
      expect(tree.some((thread) => before.some((old) => old.threadId === thread.threadId))).toBe(
        false
      );
      expect(
        await withAppHost(userData, (client) => client.request('mcp/extensions/read', {}))
      ).toEqual({ apps: false, tasks: true });
      expect(
        await current.evaluate(async () => ({
          models: await window.modelCatalog!.read(),
          presets: await window.viewFilterPresets!.request({ operation: 'list' }),
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
