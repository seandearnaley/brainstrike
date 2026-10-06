import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { Page } from 'playwright';
import type { VisibleEmbeddingHostBridge } from '../src/types/desktop-electron-api';
import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';

const BACKGROUND_INDEXING_PREFERENCES_KEY = 'background-indexing-preferences.v1' as const;

interface CollectionRow {
  readonly dimensions: number;
  readonly id: string;
  readonly model_id: string;
  readonly model_key: string;
  readonly name: string;
  readonly system_role: string | null;
}

interface SavedPreferences {
  readonly enabled: boolean;
  readonly managedCollectionId: string | null;
  readonly nativeIndexMode: 'TEXT' | 'VECTOR' | null;
  readonly nativeLocalSelection: unknown;
  readonly paused: boolean;
}

async function openSearchIndexingSettings(args: { homePage: HomePage; page: Page }): Promise<void> {
  await args.homePage.openSettings();
  await args.page.getByRole('button', { name: 'Search & Indexing' }).click();
  await expect(args.page.getByTestId('settings-category-search-indexing')).toBeVisible({
    timeout: 15_000,
  });
}

async function readCollectionRows(page: Page): Promise<CollectionRow[]> {
  return await page.evaluate(async () => {
    const api = window.electronAPI;
    if (!api?.db.query) {
      throw new Error('Desktop DB query bridge is unavailable.');
    }

    const result = await api.db.query<CollectionRow>(
      `SELECT id, name, model_id, model_key, dimensions, system_role
       FROM embedding_sets
       ORDER BY created_at ASC`
    );
    return result.rows;
  });
}

async function readSavedPreferences(page: Page): Promise<SavedPreferences> {
  return await page.evaluate(async (key) => {
    const saved = await window.electronAPI?.storage.getItem(key);
    if (!saved) {
      throw new Error('Background indexing preferences were not persisted.');
    }
    const envelope = JSON.parse(saved) as { state: SavedPreferences };
    return envelope.state;
  }, BACKGROUND_INDEXING_PREFERENCES_KEY);
}

async function readNativeStatus(
  page: Page
): Promise<Awaited<ReturnType<IndexSearchCapability['status']>>> {
  return await page.evaluate(async () => {
    const capability = (window as Window & { readonly indexSearch?: IndexSearchCapability })
      .indexSearch;
    if (!capability) {
      throw new Error('Native indexing capability is unavailable.');
    }
    return await capability.status();
  });
}

async function createCatalogCollection(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    const query = window.electronAPI?.db.query;
    if (!query) {
      throw new Error('Desktop DB query bridge is unavailable.');
    }
    const id = crypto.randomUUID();
    // Same migrated PG catalog input as the native qualification fixture; no native readiness is seeded.
    await query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        'local::Xenova/bge-small-en-v1.5',
        'Xenova/bge-small-en-v1.5',
        384,
        'cosine',
        'Fresh collection',
      ]
    );
    return id;
  });
}

test.describe('Workspace Index first run (desktop)', () => {
  for (const setup of [{ execution: 'WASM · Q8', model: 'BGE Small' }]) {
    test(`starts native semantic indexing using visible setup controls: ${setup.execution}`, async ({
      electron,
    }, testInfo) => {
      // Keep normal device discovery; this case explicitly selects WASM through the UI.
      const previousAllowGpu = process.env['BRAINSTRIKE_E2E_ALLOW_GPU'];
      process.env['BRAINSTRIKE_E2E_ALLOW_GPU'] = '1';
      const folder = await mkdtemp(join(tmpdir(), 'brainstrike-index-setup-'));
      await writeFile(
        join(folder, 'setup-proof.md'),
        '# Workspace indexing setup\nThe smoke test creates this document through the filesystem and indexes it through the real desktop UI.\n'
      );
      try {
        const { app, window } = await electron.ensureContext();
        expect(await readCollectionRows(window)).toEqual([]);
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
        await window.getByRole('combobox', { exact: true, name: 'Embedding model' }).click();
        await window.getByRole('option', { name: new RegExp(setup.model) }).click();
        await window.getByRole('button', { exact: true, name: 'Use embedding model' }).click();
        await expect(window.getByRole('combobox', { name: 'Managed collection' })).toContainText(
          `Workspace Index (${setup.model})`,
          { timeout: 15_000 }
        );
        await window.getByRole('combobox', { name: 'Search mode' }).click();
        await window.getByRole('option', { exact: true, name: 'Text and semantic search' }).click();
        await window.getByRole('combobox', { name: 'Local model execution' }).click();
        await window.getByRole('option', { exact: true, name: setup.execution }).click();
        await expect
          .poll(
            async () =>
              await window.evaluate(async () => {
                const capability = (
                  globalThis as typeof globalThis & {
                    readonly indexSearch?: IndexSearchCapability;
                  }
                ).indexSearch;
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
            { timeout: 60_000 }
          )
          .toBe(true);
        const semanticResult = await window.evaluate(async () => {
          const bridges = globalThis as typeof globalThis & {
            readonly indexSearch?: IndexSearchCapability;
            readonly embeddingHost?: VisibleEmbeddingHostBridge;
          };
          const capability = bridges.indexSearch;
          const bridge = bridges.embeddingHost;
          if (!(capability && bridge && 'queryEmbedding' in bridge)) {
            throw new Error('Native search/query bridge unavailable');
          }
          const status = await capability.status();
          if (
            status.kind !== 'ready' ||
            status.embedding.indexMode !== 'vector-configured' ||
            !status.queryPlan
          ) {
            throw new Error('Selected collection has no ready semantic query plan');
          }
          const vector = await bridge.queryEmbedding({
            dimensions: status.embedding.profile.dimensions,
            modelId: status.embedding.profile.modelId,
            modelKey: status.queryPlan.modelKey,
            query: 'document created by the smoke test',
            ...(status.queryPlan.inferencePlan
              ? { inferencePlan: status.queryPlan.inferencePlan }
              : {}),
          });
          const result = await capability.search({
            limit: 5,
            mode: 'vector',
            profile: status.embedding.profile,
            rootIds: status.authorizedRootIds,
            vector,
          });
          return {
            dimensions: vector.length,
            hits: result.hits,
            modelKey: status.queryPlan.modelKey,
          };
        });
        expect(semanticResult.modelKey).toBe('local::Xenova/bge-small-en-v1.5');
        expect(semanticResult.dimensions).toBe(384);
        expect(semanticResult.hits.some((hit) => hit.content.includes('smoke test creates'))).toBe(
          true
        );
        await testInfo.attach('ui-created-index', {
          body: JSON.stringify(
            {
              choices: await readSavedPreferences(window),
              collections: await readCollectionRows(window),
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
        if (previousAllowGpu === undefined) {
          delete process.env['BRAINSTRIKE_E2E_ALLOW_GPU'];
        } else {
          process.env['BRAINSTRIKE_E2E_ALLOW_GPU'] = previousAllowGpu;
        }
      }
    });
  }

  test('does not invent a collection or native search mode for a fresh profile', async ({
    electron,
  }, testInfo) => {
    const { window } = await electron.ensureContext();
    await openSearchIndexingSettings({ homePage: new HomePage(window), page: window });
    const managedCollection = window.getByRole('combobox', { name: 'Managed collection' });
    await expect(managedCollection).toContainText('No managed collection', { timeout: 15_000 });
    await expect(window.getByRole('switch', { name: 'Workspace Index' })).toBeChecked({
      timeout: 15_000,
    });
    await expect(window.getByRole('combobox', { name: 'Search mode' })).toContainText(
      'Choose a search mode',
      { timeout: 15_000 }
    );
    const initialCollections = await readCollectionRows(window);
    expect(initialCollections).toEqual([]);
    const initialStatus = await readNativeStatus(window);
    expect(initialStatus).toMatchObject({ kind: 'unavailable' });
    await testInfo.attach('fresh-profile-unconfigured', {
      body: JSON.stringify({ collections: initialCollections, status: initialStatus }, null, 2),
      contentType: 'application/json',
    });
  });

  test('awaits explicit native choices and preserves the selected TEXT collection across restart', async ({
    electron,
  }, testInfo) => {
    const { window } = await electron.ensureContext();
    expect(await readCollectionRows(window)).toEqual([]);
    const collectionId = await createCatalogCollection(window);
    await openSearchIndexingSettings({ homePage: new HomePage(window), page: window });
    const managedCollection = window.getByRole('combobox', { name: 'Managed collection' });
    await expect(managedCollection).toContainText('No managed collection', { timeout: 15_000 });
    await expect(window.getByRole('combobox', { name: 'Search mode' })).toContainText(
      'Choose a search mode',
      { timeout: 15_000 }
    );
    await managedCollection.click();
    await window.getByRole('option', { exact: true, name: 'Fresh collection' }).click();
    await window.getByRole('combobox', { name: 'Search mode' }).click();
    await window.getByRole('option', { exact: true, name: 'Text search' }).click();
    const expectedChoices = {
      enabled: true,
      managedCollectionId: collectionId,
      nativeIndexMode: 'TEXT',
      nativeLocalSelection: null,
      paused: false,
    };
    await expect
      .poll(() => readSavedPreferences(window), { timeout: 15_000 })
      .toMatchObject(expectedChoices);
    await expect
      .poll(() => readNativeStatus(window), { timeout: 15_000 })
      .toMatchObject({
        authorizedCollectionIds: [collectionId],
        collectionReadiness: [
          expect.objectContaining({ embeddingSetId: collectionId, scanComplete: true }),
        ],
        embedding: { indexMode: 'text-only' },
        kind: 'ready',
      });
    const statusBeforeRestart = await readNativeStatus(window);
    const beforeRestart = await readCollectionRows(window);
    expect(beforeRestart).toEqual([
      expect.objectContaining({ id: collectionId, name: 'Fresh collection', system_role: null }),
    ]);
    await testInfo.attach('fresh-explicit-selection-before-restart', {
      body: JSON.stringify(
        {
          collections: beforeRestart,
          preferences: await readSavedPreferences(window),
          status: await readNativeStatus(window),
        },
        null,
        2
      ),
      contentType: 'application/json',
    });
    const restarted = await electron.restart();
    await openSearchIndexingSettings({
      homePage: new HomePage(restarted.window),
      page: restarted.window,
    });
    await expect(
      restarted.window.getByRole('combobox', { name: 'Managed collection' })
    ).toContainText('Fresh collection', { timeout: 15_000 });
    await expect(restarted.window.getByRole('combobox', { name: 'Search mode' })).toContainText(
      'Text search',
      { timeout: 15_000 }
    );
    await expect
      .poll(() => readSavedPreferences(restarted.window), { timeout: 15_000 })
      .toMatchObject(expectedChoices);
    await expect
      .poll(() => readNativeStatus(restarted.window), { timeout: 15_000 })
      .toMatchObject({
        authorizedCollectionIds: [collectionId],
        collectionReadiness: [
          expect.objectContaining({ embeddingSetId: collectionId, scanComplete: true }),
        ],
        embedding: { indexMode: 'text-only' },
        kind: 'ready',
      });
    expect(await readCollectionRows(restarted.window)).toEqual(beforeRestart);
    const statusAfterRestart = await readNativeStatus(restarted.window);
    if (statusBeforeRestart.kind !== 'ready' || statusAfterRestart.kind !== 'ready') {
      throw new Error('Native indexing lost readiness around restart.');
    }
    expect(statusAfterRestart.storeId).toBe(statusBeforeRestart.storeId);
    await testInfo.attach('fresh-explicit-selection-after-restart', {
      body: JSON.stringify(
        {
          collections: await readCollectionRows(restarted.window),
          preferences: await readSavedPreferences(restarted.window),
          status: await readNativeStatus(restarted.window),
        },
        null,
        2
      ),
      contentType: 'application/json',
    });
  });
});
