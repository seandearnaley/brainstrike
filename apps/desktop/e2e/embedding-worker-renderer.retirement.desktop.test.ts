import { rm } from 'node:fs/promises';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  configureNativeCollectionSearch,
  createNativeImportedSearchFixture,
  createNativeImportRoot,
  observeNativeCollectionWork,
  waitForNativeCollectionCoverage,
} from './embedding-worker-renderer.native-search';
import {
  captureNativeShutdown,
  prepareActiveNativeIngestion,
} from './embedding-worker-renderer.retirement';
import {
  getEmbeddingHostStatus,
  openWorkspaceSearchPanel,
  runWorkspaceSemanticSearch,
  selectWorkspaceSearchCollection,
  showDatabaseDemoPanel,
  waitForWorkspaceSemanticSearchResults,
} from './embedding-worker-renderer.shared';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { loadElectronHelpers } from './utils/load-electron-helpers';

// Large enough that the workspace is still embedding when reset or quit lands.
const ACTIVE_ROOT_FILE_COUNT = 1002;
const ACTIVE_ROOT_SENTENCES_PER_FILE = 24;
// The shutdown receipt and both reset milestones are info lines; Main prints WARN by default.
test.use({ electronEnv: { LOG_LEVEL: 'info' } });

async function search(page: Page, name: string): Promise<void> {
  const panel = await openWorkspaceSearchPanel(page);
  await selectWorkspaceSearchCollection(panel, name);
  await runWorkspaceSemanticSearch(panel, 'desktop import backfill regression');
  const result = await waitForWorkspaceSemanticSearchResults(panel);
  expect(result.resultFileCount).toBeGreaterThan(0);
  expect(result.emptyState).toBe(false);
}

test.describe('@destructive native retirement', () => {
  async function requestReset(page: Page): Promise<void> {
    await new HomePage(page).openSettings();
    await new SettingsPage(page).openCategory(/Factory Reset/i, 'factory-reset');
    await page.evaluate(() => {
      const original = window.confirm;
      window.confirm = () => {
        window.confirm = original;
        return true;
      };
    });
    await page.getByTestId('factory-reset-button').click();
  }

  function observeReset(app: ElectronApplication, milestone: string) {
    const reached = Promise.withResolvers<void>();
    let output = '';
    app.process().stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes('Failed to reset desktop application data')) {
        reached.reject(new Error('Factory reset failed before native retirement joined.'));
        return;
      }
      if (output.includes(milestone)) {
        reached.resolve();
      }
    });
    // The click can still be awaiting its acknowledgement when Main reports failure.
    reached.promise.catch(() => undefined);
    return { output: () => output, reached: reached.promise };
  }

  async function assertFreshDefaults(page: Page): Promise<void> {
    const { waitForAppReady } = await loadElectronHelpers();
    await waitForAppReady(page);
    await new HomePage(page).openSettings();
    await new SettingsPage(page).openCategory(/Permissions/i, 'permissions');
    await expect(page.getByTestId('permission-policy-edit')).toHaveValue('ask');
    await new SettingsPage(page).openCategory(/Search & Indexing/i, 'search-indexing');
    await expect(page.getByRole('combobox', { name: 'Search mode' })).toHaveText(
      'Choose a search mode'
    );
    await new HomePage(page).leaveSettings();
  }

  for (const mode of ['quit-and-relaunch', 'reset-and-reuse', 'quit-during-reset'] as const) {
    test(`@desktop-embedding-retirement ${mode} joins active native inference`, async ({
      electron,
      electronApp,
      window,
    }) => {
      test.skip(
        process.platform === 'win32' && mode !== 'quit-and-relaunch',
        'Windows Factory Reset is disabled for M3 by owner decision.'
      );
      test.setTimeout(540_000);
      const root = await createNativeImportRoot(
        ACTIVE_ROOT_FILE_COUNT,
        ACTIVE_ROOT_SENTENCES_PER_FILE
      );
      let current = electronApp;
      let assertCleanShutdown = captureNativeShutdown(current.app);
      try {
        const scenario = await prepareActiveNativeIngestion(current.app, window, root);
        const page = scenario.activeWindow;
        await expect
          .poll(() => observeNativeCollectionWork(page, scenario.searchableEmbeddingSetId), {
            timeout: 120_000,
          })
          .toMatchObject({ hostActive: true, incomplete: true });
        const previous = await getEmbeddingHostStatus(page);
        expect(previous.runtimeId).not.toBe('');
        console.log('NATIVE-ACTIVE-RETIREMENT', {
          mode,
          work: await observeNativeCollectionWork(page, scenario.searchableEmbeddingSetId),
        });
        if (mode === 'quit-and-relaunch') {
          // No Pause or Stop pre-cleanup: Main must retire the active physical owner itself.
          await electron.closeForStateSeeding();
          assertCleanShutdown();
          current = await electron.ensureContext();
          assertCleanShutdown = captureNativeShutdown(current.app);
          const reopened = await electron.ensureWindow({ preserveState: true });
          await search(reopened, scenario.searchableCollectionName);
          expect((await getEmbeddingHostStatus(reopened)).runtimeId).not.toBe(previous.runtimeId);
        } else if (mode === 'reset-and-reuse') {
          const reset = observeReset(current.app, 'Desktop factory reset completed');
          await requestReset(page);
          await reset.reached;
          const fresh = await showDatabaseDemoPanel(page);
          const name = 'Post-reset native generation';
          const fixture = await createNativeImportedSearchFixture(fresh, name);
          await assertFreshDefaults(page);
          await configureNativeCollectionSearch(fresh, name);
          await waitForNativeCollectionCoverage(fresh, fixture.embeddingSetId, fixture.fileCount);
          await search(fresh, name);
          expect((await getEmbeddingHostStatus(fresh)).runtimeId).not.toBe(previous.runtimeId);
        } else {
          // This existing runtime event occurs after reset's parallel Stop joins and before purge.
          const reset = observeReset(
            current.app,
            'Desktop browser sessions cleared (factory reset)'
          );
          await requestReset(page);
          await reset.reached;
          await electron.closeForStateSeeding();
          assertCleanShutdown();
          expect(reset.output()).toContain('Desktop factory reset completed');
          expect(reset.output()).not.toContain('Failed to reset desktop application data');
          current = await electron.ensureContext();
          assertCleanShutdown = captureNativeShutdown(current.app);
          await assertFreshDefaults(await electron.ensureWindow({ preserveState: true }));
        }
      } finally {
        await electron.closeForStateSeeding();
        assertCleanShutdown();
        await rm(root, { force: true, recursive: true });
      }
    });
  }
});
