import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { Page } from 'playwright';
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
        'local::Xenova/all-MiniLM-L6-v2',
        'Xenova/all-MiniLM-L6-v2',
        384,
        'cosine',
        'Fresh collection',
      ]
    );
    return id;
  });
}

test.describe('Workspace Index first run (desktop)', () => {
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
