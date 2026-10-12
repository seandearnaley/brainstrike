import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { Page } from 'playwright';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';

const BACKGROUND_INDEXING_PREFERENCES_KEY = 'background-indexing-preferences.v1' as const;

interface PersistedBackgroundIndexingPreferences {
  enabled: boolean;
  indexingPolicyPreset: 'balanced' | 'full-root';
  managedCollectionId: string | null;
  mode: 'root-folder-cache';
}

interface ElectronHarnessLike {
  getUserDataDir: () => string;
}

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

async function seedBackgroundIndexingPreferences(args: {
  electronHarness: ElectronHarnessLike;
  preferences: PersistedBackgroundIndexingPreferences;
}): Promise<void> {
  const userDataDir = args.electronHarness.getUserDataDir();
  await mkdir(userDataDir, { recursive: true });

  const storagePath = path.join(userDataDir, 'electron-storage.json');
  let existingStorage: Record<string, string> = {};
  try {
    existingStorage = JSON.parse(await readFile(storagePath, 'utf8')) as Record<string, string>;
  } catch {
    existingStorage = {};
  }

  const nextStorage = {
    ...existingStorage,
    [BACKGROUND_INDEXING_PREFERENCES_KEY]: JSON.stringify({
      state: args.preferences,
      version: 2,
    }),
  };

  await writeFile(storagePath, JSON.stringify(nextStorage, null, 2), 'utf8');
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

async function seedStaleSelection(electron: ElectronHarnessLike): Promise<void> {
  await seedBackgroundIndexingPreferences({
    electronHarness: electron,
    preferences: {
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'set-stale-after-db-wipe',
      mode: 'root-folder-cache',
    },
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
        'Selected collection',
      ]
    );
    return id;
  });
}

test.describe('Workspace Index settings (desktop)', () => {
  test('clears a missing legacy collection and awaits explicit native choices', async ({
    electron,
  }, testInfo) => {
    await seedStaleSelection(electron);

    const { window } = await electron.ensureContext();
    const homePage = new HomePage(window);
    await openSearchIndexingSettings({ homePage, page: window });

    const managedCollectionTrigger = window.locator('#managed-cache-collection');
    await expect(window.getByRole('switch', { name: 'Workspace Index' })).toBeChecked({
      timeout: 15_000,
    });
    await expect(managedCollectionTrigger).toContainText('No managed collection', {
      timeout: 15_000,
    });
    await expect(window.getByRole('combobox', { name: 'Search mode' })).toContainText(
      'Choose a search mode',
      {
        timeout: 15_000,
      }
    );

    await expect
      .poll(
        async () =>
          await window
            .getByText('Managed collection metadata is invalid.', { exact: true })
            .count(),
        {
          message: 'Stale managed collection ids should not surface the invalid-metadata error.',
          timeout: 15_000,
        }
      )
      .toBe(0);

    await expect
      .poll(() => readSavedPreferences(window), { timeout: 15_000 })
      .toMatchObject({
        enabled: true,
        managedCollectionId: null,
        nativeIndexMode: null,
        nativeLocalSelection: null,
      });
    const collections = await readCollectionRows(window);
    expect(collections).toEqual([]);
    const status = await readNativeStatus(window);
    expect(status).toMatchObject({
      kind: 'unavailable',
    });
    await testInfo.attach('legacy-selection-cleared', {
      body: JSON.stringify(
        { collections, preferences: await readSavedPreferences(window), status },
        null,
        2
      ),
      contentType: 'application/json',
    });
  });

  test('uses and preserves the explicitly selected TEXT collection after a stale legacy selection', async ({
    electron,
  }, testInfo) => {
    await seedStaleSelection(electron);
    const { window } = await electron.ensureContext();
    const collectionId = await createCatalogCollection(window);
    await openSearchIndexingSettings({ homePage: new HomePage(window), page: window });
    const managedCollection = window.getByRole('combobox', { name: 'Managed collection' });
    await expect(managedCollection).toContainText('No managed collection', { timeout: 15_000 });
    await managedCollection.click();
    await window.getByRole('option', { exact: true, name: 'Selected collection' }).click();
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
        embedding: { indexMode: 'text-only' },
        kind: 'ready',
      });
    const beforeRestart = await readCollectionRows(window);
    expect(beforeRestart).toEqual([
      expect.objectContaining({ id: collectionId, name: 'Selected collection', system_role: null }),
    ]);
    await testInfo.attach('explicit-selection-before-restart', {
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
    ).toContainText('Selected collection', { timeout: 15_000 });
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
        embedding: { indexMode: 'text-only' },
        kind: 'ready',
      });
    expect(await readCollectionRows(restarted.window)).toEqual(beforeRestart);
    await testInfo.attach('explicit-selection-after-restart', {
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
