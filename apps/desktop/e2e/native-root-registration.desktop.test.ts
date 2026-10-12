import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import {
  configureNativeCollectionSearch,
  createNativeImportedSearchFixture,
  pauseNativeCollectionSources,
  resumeNativeCollectionSources,
  waitForNativeCollectionCoverage,
} from './embedding-worker-renderer.native-search';
import {
  ensureFileExplorerPanelVisible,
  expect,
  openWorkspaceSearchPanel,
  runWorkspaceSemanticSearch,
  selectWorkspaceSearchCollection,
  test,
  waitForWorkspaceSemanticSearchResults,
} from './embedding-worker-renderer.shared';

test('indexes and searches a real folder registered while native ingestion is paused', async ({
  electron,
  electronApp,
  window,
}) => {
  test.setTimeout(180_000);
  const rootPath = await realpath(
    await mkdtemp(join(tmpdir(), 'brainstrike-native-registration-'))
  );
  try {
    await writeFile(
      join(rootPath, 'proof.ts'),
      'export const evidence = "A real native root authority proof";\n'
    );
    const collectionName = `Root registration ${Date.now()}`;
    const fixture = await createNativeImportedSearchFixture(window, collectionName);
    await configureNativeCollectionSearch(window, collectionName);
    await waitForNativeCollectionCoverage(window, fixture.embeddingSetId, fixture.fileCount);
    await pauseNativeCollectionSources(window);
    await electronApp.app.evaluate((_electron, folder) => {
      process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = folder;
    }, rootPath);
    await ensureFileExplorerPanelVisible(window);
    await window.getByTestId('select-root-button').click();
    await expect(
      window.getByRole('treegrid', { name: 'File tree' }).getByText('proof.ts')
    ).toBeVisible();
    await resumeNativeCollectionSources(window);
    const observation = await waitForNativeCollectionCoverage(
      window,
      fixture.embeddingSetId,
      fixture.fileCount + 1
    );
    expect(observation.status.authorizedRootIds).toHaveLength(1);
    await expect
      .poll(
        async () =>
          await window.evaluate(async () => {
            const capability = (
              globalThis.window as Window & { indexSearch?: IndexSearchCapability }
            ).indexSearch;
            if (!capability) {
              throw new Error('Native index capability unavailable');
            }
            return await capability.status();
          })
      )
      .toMatchObject({ rootReadiness: [{ scanComplete: true }] });
    const panel = await openWorkspaceSearchPanel(window);
    await selectWorkspaceSearchCollection(panel, collectionName);
    await runWorkspaceSemanticSearch(panel, 'real native root authority proof');
    const results = await waitForWorkspaceSemanticSearchResults(panel);
    expect(results.resultFileCount).toBeGreaterThan(0);
    await expect(panel.getByRole('row').filter({ hasText: 'proof.ts' })).toBeVisible();
  } finally {
    await electron.closeForStateSeeding();
    await rm(rootPath, { force: true, recursive: true });
  }
});
