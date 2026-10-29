import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { Page } from 'playwright';
import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { readIndexConfig, updateIndexConfig } from './utils/index-config';
import { HOSTED_INDEX_MODEL, vectorSearch } from './utils/native-index-build';

async function openSearchIndexingSettings(args: { homePage: HomePage; page: Page }): Promise<void> {
  await args.homePage.openSettings();
  await args.page.getByRole('button', { name: 'Search & Indexing' }).click();
  await expect(args.page.getByTestId('settings-category-search-indexing')).toBeVisible({
    timeout: 15_000,
  });
}

async function readNativeStatus(
  page: Page
): Promise<Awaited<ReturnType<IndexSearchCapability['status']>>> {
  return await page.evaluate(async () => {
    const capability = (
      window as Window & {
        readonly __brainstrikeTestHooks__?: { readonly indexSearch?: IndexSearchCapability };
      }
    ).__brainstrikeTestHooks__?.indexSearch;
    if (!capability) {
      throw new Error('Native indexing capability is unavailable.');
    }
    return await capability.status();
  });
}

test.describe('Workspace Index first run (desktop)', () => {
  test('starts native semantic indexing using visible setup controls', async ({
    electron,
    modelProvider,
  }, testInfo) => {
    test.setTimeout(300_000);
    modelProvider.serveEmbeddings(HOSTED_INDEX_MODEL.dimensions);
    const folder = await mkdtemp(join(tmpdir(), 'brainstrike-index-setup-'));
    await writeFile(
      join(folder, 'setup-proof.md'),
      '# Workspace indexing setup\nThe smoke test creates this document through the filesystem and indexes it through the real desktop UI.\n'
    );
    try {
      const { app, window } = await electron.ensureContext();
      await app.evaluate((_electron, path) => {
        process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = path;
      }, folder);
      await ensureFileExplorerPanelVisible(window);
      await window.getByTestId('select-root-button').click();
      await expect(
        window.getByRole('treegrid', { name: 'File tree' }).getByText('setup-proof.md')
      ).toBeVisible({ timeout: 15_000 });
      await window.getByTestId('indexing-status-trigger').click();
      await window.getByRole('button', { name: 'Open indexing settings' }).click();
      await expect(window.getByTestId('settings-category-search-indexing')).toBeVisible({
        timeout: 15_000,
      });
      const section = window.getByTestId('settings-category-search-indexing');
      await section
        .getByRole('group', { name: 'Search mode' })
        .getByRole('button', { name: /^Semantic/u })
        .click();
      await section.getByRole('combobox', { exact: true, name: 'Embedding model' }).click();
      // The Settings model picker's name for HOSTED_INDEX_MODEL.
      await window.getByRole('option', { name: /Text Embedding 3 Small/u }).click();
      const pending = section.getByRole('status', { name: 'Pending changes' });
      await pending.getByRole('button', { exact: true, name: 'Apply and re-index' }).click();
      await expect(pending).toBeHidden({ timeout: 15_000 });
      await expect
        .poll(
          async () =>
            await window.evaluate(async () => {
              const capability = (
                globalThis as typeof globalThis & {
                  readonly __brainstrikeTestHooks__?: {
                    readonly indexSearch?: IndexSearchCapability;
                  };
                }
              ).__brainstrikeTestHooks__?.indexSearch;
              if (!capability) {
                throw new Error('Native capability missing');
              }
              const status = await capability.status();
              if (status.kind !== 'ready') {
                return false;
              }
              const observation = await capability.coverageBatch([
                { rootIds: status.authorizedRootIds },
              ]);
              if (observation.kind === 'invalidated') {
                return false;
              }
              if (observation.kind === 'blocked') {
                throw new Error(observation.reason);
              }
              const snapshot = observation.status;
              const coverage = observation.coverage[0];
              if (!coverage) {
                throw new Error('Native coverage batch omitted the requested scope');
              }
              return (
                snapshot.rootReadiness.length > 0 &&
                snapshot.rootReadiness.every((root) => root.scanComplete) &&
                coverage.totals.indexedFiles === 1 &&
                coverage.totals.chunks > 0 &&
                coverage.totals.vectors === coverage.totals.chunks &&
                coverage.totals.missingVectors === 0
              );
            }),
          { timeout: 180_000 }
        )
        .toBe(true);
      const semanticResult = await vectorSearch(window, 'document created by the smoke test', 5);
      expect(semanticResult.modelKey).toBe(HOSTED_INDEX_MODEL.modelKey);
      expect(semanticResult.dimensions).toBe(HOSTED_INDEX_MODEL.dimensions);
      expect(semanticResult.hits.some((hit) => hit.content.includes('smoke test creates'))).toBe(
        true
      );
      await testInfo.attach('ui-created-index', {
        body: JSON.stringify(
          {
            config: await readIndexConfig(window),
            status: await readNativeStatus(window),
          },
          null,
          2
        ),
        contentType: 'application/json',
      });
    } finally {
      await electron.dispose();
      await rm(folder, { force: true, recursive: true });
    }
  });

  test(
    'completes paused semantic setup after choosing a hosted embedding model',
    { tag: '@smoke' },
    async ({ homePage, window }, testInfo) => {
      await openSearchIndexingSettings({ homePage, page: window });
      const section = window.getByTestId('settings-category-search-indexing');
      await expect
        .poll(() => readNativeStatus(window), { timeout: 15_000 })
        .toMatchObject({ embedding: { indexMode: 'text-only' }, kind: 'ready' });
      await section.getByRole('button', { exact: true, name: 'Pause indexing' }).click();
      await expect(
        section.getByRole('button', { exact: true, name: 'Resume indexing' })
      ).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => readIndexConfig(window), { timeout: 15_000 })
        .toMatchObject({ paused: true });

      await updateIndexConfig(window, { mode: 'semantic', model: HOSTED_INDEX_MODEL });
      expect(await readIndexConfig(window)).toMatchObject({
        mode: 'semantic',
        model: HOSTED_INDEX_MODEL,
        paused: true,
      });
      // Paused read authority needs a real native writer, but no document embedding.
      // Do not resume ingestion to make this assertion pass.
      await expect
        .poll(() => readNativeStatus(window), { timeout: 15_000 })
        .toMatchObject({
          authorizedCollectionIds: [expect.any(String)],
          embedding: {
            indexMode: 'vector-configured',
            profile: { dimensions: 1536, modelId: 'text-embedding-3-small' },
          },
          kind: 'ready',
          queryPlan: { modelKey: HOSTED_INDEX_MODEL.modelKey },
        });
      await expect(
        section
          .getByRole('group', { name: 'Search mode' })
          .getByRole('button', { name: /^Semantic/u })
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        section.getByRole('button', { exact: true, name: 'Resume indexing' })
      ).toBeVisible();
      await testInfo.attach('paused-semantic-setup', {
        body: JSON.stringify({
          config: await readIndexConfig(window),
          status: await readNativeStatus(window),
        }),
        contentType: 'application/json',
      });
    }
  );

  test('a fresh profile starts in Text search and invents no collection', async ({
    electron,
  }, testInfo) => {
    const { window } = await electron.ensureContext();
    await openSearchIndexingSettings({ homePage: new HomePage(window), page: window });
    await expect(
      window
        .getByTestId('settings-category-search-indexing')
        .getByRole('group', { name: 'Search mode' })
        .getByRole('button', { name: /^Text/u })
    ).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    expect(await readIndexConfig(window)).toEqual({
      chunking: { _tag: 'Auto' },
      mode: 'text',
      model: null,
      paused: false,
      policy: 'balanced',
      worktrees: {},
    });
    await expect
      .poll(() => readNativeStatus(window), { timeout: 15_000 })
      .toMatchObject({ embedding: { indexMode: 'text-only' }, kind: 'ready' });
    await testInfo.attach('fresh-profile-text-search', {
      body: JSON.stringify({ status: await readNativeStatus(window) }, null, 2),
      contentType: 'application/json',
    });
  });
});
