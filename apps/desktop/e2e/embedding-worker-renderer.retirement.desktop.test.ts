import { rm } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import {
  addWorkspaceFolder,
  createNativeImportRoot,
  observeNativeIngestion,
} from './embedding-worker-renderer.native-search';
import {
  captureNativeShutdown,
  createSearchableRoot,
  prepareSearchableFolder,
  SEARCHABLE_FILE,
  SEARCHABLE_QUERY,
} from './embedding-worker-renderer.retirement';
import {
  getEmbeddingHostStatus,
  openWorkspaceSearchPanel,
  runWorkspaceSemanticSearch,
  waitForWorkspaceSemanticSearchResults,
} from './embedding-worker-renderer.shared';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { factoryResetAndRelaunch } from './utils/factory-reset';
import { loadElectronHelpers } from './utils/load-electron-helpers';

// Large enough that the workspace is still embedding when reset or quit lands.
const ACTIVE_ROOT_FILE_COUNT = 1002;
const ACTIVE_ROOT_SENTENCES_PER_FILE = 24;
// The shutdown receipt is an info line; Main prints WARN by default.
test.use({ electronEnv: { LOG_LEVEL: 'info' } });

async function search(page: Page): Promise<void> {
  const panel = await openWorkspaceSearchPanel(page);
  await runWorkspaceSemanticSearch(panel, SEARCHABLE_QUERY);
  const result = await waitForWorkspaceSemanticSearchResults(panel);
  expect(result.emptyState).toBe(false);
  await expect(panel.getByRole('row').filter({ hasText: SEARCHABLE_FILE })).toBeVisible();
}

test.describe('@destructive native retirement', () => {
  async function assertFreshDefaults(page: Page): Promise<void> {
    const { waitForAppReady } = await loadElectronHelpers();
    await waitForAppReady(page);
    await new HomePage(page).openSettings();
    await new SettingsPage(page).openCategory(/Permissions/i, 'permissions');
    await expect(page.getByTestId('permission-policy-edit')).toHaveValue('ask');
    const searchIndexing = await new SettingsPage(page).openCategory(
      /Search & Indexing/i,
      'search-indexing'
    );
    await expect(
      searchIndexing
        .getByRole('group', { name: 'Search mode' })
        .getByRole('button', { name: /^Text/ })
    ).toHaveAttribute('aria-pressed', 'true');
    await new HomePage(page).leaveSettings();
  }

  for (const mode of ['quit-and-relaunch', 'reset-and-reuse', 'quit-during-reset'] as const) {
    test(`@desktop-embedding-retirement ${mode} joins active native inference`, async ({
      electron,
      electronApp,
      window: page,
    }) => {
      test.setTimeout(540_000);
      const root = await createNativeImportRoot(
        ACTIVE_ROOT_FILE_COUNT,
        ACTIVE_ROOT_SENTENCES_PER_FILE
      );
      const searchable = await createSearchableRoot();
      let current = electronApp;
      let assertCleanShutdown = captureNativeShutdown(current.app);
      try {
        // A fully embedded folder to search afterwards, then a large one the index is still embedding.
        await prepareSearchableFolder(current.app, page, searchable);
        await addWorkspaceFolder(current.app, page, root, 'stress-file-0000.ts');
        await expect
          .poll(() => observeNativeIngestion(page), { timeout: 120_000 })
          .toMatchObject({ hostActive: true, incomplete: true });
        const previous = await getEmbeddingHostStatus(page);
        expect(previous.runtimeId).not.toBe('');
        console.log('NATIVE-ACTIVE-RETIREMENT', { mode, work: await observeNativeIngestion(page) });
        if (mode === 'quit-and-relaunch') {
          // No Pause or Stop pre-cleanup: Main must retire the active physical owner itself.
          await electron.closeForStateSeeding();
          assertCleanShutdown();
          current = await electron.ensureContext();
          assertCleanShutdown = captureNativeShutdown(current.app);
          const reopened = await electron.ensureWindow({ preserveState: true });
          await search(reopened);
          expect((await getEmbeddingHostStatus(reopened)).runtimeId).not.toBe(previous.runtimeId);
        } else {
          // Factory Reset quits through the same retirement, and the next start wipes the data
          // before it opens anything.
          current = await factoryResetAndRelaunch(electron, page);
          assertCleanShutdown();
          assertCleanShutdown = captureNativeShutdown(current.app);
          let fresh = current.window;
          if (mode === 'quit-during-reset') {
            // Quit again as soon as the wiped app is up: the reset is finished, not resumed.
            const { waitForAppReady } = await loadElectronHelpers();
            await waitForAppReady(fresh);
            await electron.closeForStateSeeding();
            assertCleanShutdown();
            current = await electron.ensureContext();
            assertCleanShutdown = captureNativeShutdown(current.app);
            fresh = await electron.ensureWindow({ preserveState: true });
          }
          await assertFreshDefaults(fresh);
          // The embedding worker is usable on the wiped profile.
          await prepareSearchableFolder(current.app, fresh, searchable);
          await search(fresh);
          expect((await getEmbeddingHostStatus(fresh)).runtimeId).not.toBe(previous.runtimeId);
        }
      } finally {
        await electron.closeForStateSeeding();
        assertCleanShutdown();
        await rm(root, { force: true, recursive: true });
        await rm(searchable, { force: true, recursive: true });
      }
    });
  }
});
