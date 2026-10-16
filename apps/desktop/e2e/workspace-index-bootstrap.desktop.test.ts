import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { ElectronApplication, Page } from 'playwright';
import { APP_RENDERER_ORIGIN } from '../src/desktop-renderer-origin';
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

const ORT_WASM_REQUESTS_KEY = '__brainstrikeE2eOrtWasmRequests' as const;

/**
 * The app's own bundled renderer directory, as a `file://` prefix.
 *
 * `renderer-protocol.ts` fulfils every `brainstrike-app://bundle/...` GET with
 * `net.fetch(pathToFileURL(resource))`, AFTER proving with `realpath` that the
 * resource is confined to this directory. `net.fetch` runs on the session the
 * hook below watches, so the app serving its OWN bundle appears there as a
 * `file://` request to a path inside this directory — which is precisely what
 * BST-2003 requires, not a violation of it. `realpathSync` because the handler
 * resolves the served path the same way.
 *
 * Resolved per call, NOT at module scope: `dist/` is gitignored and absent on a
 * clean checkout, and `playwright test --list` collects specs without running
 * them or the build setup, so a top-level `realpathSync` would fail discovery
 * with ENOENT before any test could be reported. Resolving here still fails by
 * name if the bundle is missing when the hook actually runs.
 */
function appBundleFileUrlPrefix(): string {
  return `${pathToFileURL(realpathSync(resolve(import.meta.dirname, '../dist/renderer'))).href}/`;
}

/**
 * Records every ONNX Runtime WASM request that does NOT come from the app's own
 * bundle, through the session's request hook in Main (BST-2003). The app installs no
 * onBeforeRequest listener of its own, so this observes without replacing one.
 *
 * Two shapes are the app serving itself and are not recorded: the renderer origin,
 * and a `file://` read inside {@link appBundleFileUrlPrefix} (how the renderer
 * protocol fulfils that origin). A CDN fetch, or a `file://` read from outside the
 * bundle, still is.
 */
async function recordOrtWasmRequests(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    ({ session }, { appOrigin, bundlePrefix, key }) => {
      const seen: string[] = [];
      Reflect.set(globalThis, key, seen);
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const url = new URL(details.url);
        const fromAppBundle =
          details.url.startsWith(`${appOrigin}/`) || details.url.startsWith(bundlePrefix);
        if (!fromAppBundle && /ort-wasm/u.test(url.pathname)) {
          seen.push(details.url);
        }
        callback({});
      });
    },
    {
      appOrigin: APP_RENDERER_ORIGIN,
      bundlePrefix: appBundleFileUrlPrefix(),
      key: ORT_WASM_REQUESTS_KEY,
    }
  );
}

async function readOrtWasmRequests(app: ElectronApplication): Promise<string[]> {
  return await app.evaluate(
    (_electron, key) => [...(Reflect.get(globalThis, key) as string[])],
    ORT_WASM_REQUESTS_KEY
  );
}

async function readCollectionRows(page: Page): Promise<CollectionRow[]> {
  return await page.evaluate(async () => {
    if (!window.collectionCatalog) {
      throw new Error('Desktop collection catalog is unavailable');
    }
    return (
      await window.collectionCatalog.list().then((result) => {
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        return result.value;
      })
    ).map((row) => ({
      dimensions: row.dimensions,
      id: row.id,
      model_id: row.modelId,
      model_key: row.modelKey,
      name: row.name ?? '',
      system_role: row.systemRole ?? null,
    }));
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

async function createCatalogCollection(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    if (!window.collectionCatalog) {
      throw new Error('Desktop collection catalog is unavailable');
    }
    const collection = await window.collectionCatalog
      .create({
        dimensions: 384,
        distance: 'cosine',
        metadata: { name: 'Fresh collection' },
        modelId: 'Xenova/bge-small-en-v1.5',
        modelKey: 'local::Xenova/bge-small-en-v1.5',
      })
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        return result.value;
      });
    return collection.id;
  });
}

test.describe('Workspace Index first run (desktop)', () => {
  // Granite is the recommended model; WASM · Q8 is its catalog execution without WebGPU (BST-1993).
  for (const setup of [
    { execution: 'WASM · Q8', model: 'BGE Small', modelId: 'Xenova/bge-small-en-v1.5' },
    {
      execution: 'WASM · Q8',
      model: 'Granite Embedding Small R2',
      modelId: 'onnx-community/granite-embedding-small-english-r2-ONNX',
    },
  ]) {
    test(`starts native semantic indexing using visible setup controls: ${setup.model} ${setup.execution}`, async ({
      electron,
    }, testInfo) => {
      test.setTimeout(300_000);
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
        await recordOrtWasmRequests(app);
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
            // Includes the model's first download into the fresh profile.
            { timeout: 180_000 }
          )
          .toBe(true);
        const semanticResult = await window.evaluate(async () => {
          const bridges = globalThis as typeof globalThis & {
            readonly __brainstrikeTestHooks__?: { readonly indexSearch?: IndexSearchCapability };
            readonly embeddingHost?: VisibleEmbeddingHostBridge;
          };
          const capability = bridges.__brainstrikeTestHooks__?.indexSearch;
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
          const response = await bridge.queryEmbedding({
            dimensions: status.embedding.profile.dimensions,
            modelId: status.embedding.profile.modelId,
            modelKey: status.queryPlan.modelKey,
            query: 'document created by the smoke test',
            ...(status.queryPlan.inferencePlan
              ? { inferencePlan: status.queryPlan.inferencePlan }
              : {}),
          });
          if (!response.ok) {
            throw new Error(JSON.stringify(response.error));
          }
          const vector = response.value;
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
        expect(semanticResult.modelKey).toBe(`local::${setup.modelId}`);
        expect(semanticResult.dimensions).toBe(384);
        expect(semanticResult.hits.some((hit) => hit.content.includes('smoke test creates'))).toBe(
          true
        );
        // BST-2003: ONNX Runtime's WASM comes from the app's own files, never a CDN.
        // The semantic hits above prove ONNX Runtime ran; the session hook records every
        // ORT WASM request that did not come from the app's own bundle, so any request it
        // saw is a failure.
        expect(await readOrtWasmRequests(app)).toEqual([]);
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

  test(
    'completes paused semantic setup after choosing a local execution',
    { tag: '@smoke' },
    async ({ homePage, window }, testInfo) => {
      await openSearchIndexingSettings({ homePage, page: window });
      await window.getByRole('combobox', { exact: true, name: 'Embedding model' }).click();
      await window.getByRole('option', { name: /BGE Small/ }).click();
      await window.getByRole('button', { exact: true, name: 'Use embedding model' }).click();
      await expect(window.getByRole('combobox', { name: 'Managed collection' })).toContainText(
        'Workspace Index (BGE Small)',
        { timeout: 15_000 }
      );
      await window.getByRole('combobox', { name: 'Search mode' }).click();
      await window.getByRole('option', { exact: true, name: 'Text search' }).click();
      await expect
        .poll(() => readNativeStatus(window), { timeout: 15_000 })
        .toMatchObject({ embedding: { indexMode: 'text-only' }, kind: 'ready' });
      const initial = await readSavedPreferences(window);
      expect(initial.managedCollectionId).not.toBeNull();
      await window.getByRole('button', { name: 'Pause workspace index' }).click();
      await expect
        .poll(() => readSavedPreferences(window), { timeout: 15_000 })
        .toMatchObject({ paused: true });

      // Mode is saved before execution: this is a real failed open with no writer,
      // not a source pause on an already configured semantic host.
      await window.getByRole('combobox', { name: 'Search mode' }).click();
      await window.getByRole('option', { exact: true, name: 'Text and semantic search' }).click();
      await expect
        .poll(() => readNativeStatus(window), { timeout: 15_000 })
        .toMatchObject({ cause: { kind: 'setup-required' }, kind: 'unavailable' });
      const incomplete = await readNativeStatus(window);
      await window.getByRole('combobox', { exact: true, name: 'Embedding model' }).click();
      await window.getByRole('option', { name: /BGE Small/ }).click();
      await window.getByRole('button', { exact: true, name: 'Use embedding model' }).click();
      await window.getByRole('combobox', { name: 'Local model execution' }).click();
      await window.getByRole('option', { exact: true, name: 'WASM · Q8' }).click();
      await expect
        .poll(() => readSavedPreferences(window), { timeout: 15_000 })
        .toMatchObject({
          managedCollectionId: initial.managedCollectionId,
          nativeIndexMode: 'VECTOR',
          nativeLocalSelection: {
            device: 'wasm',
            dtype: 'q8',
            modelId: 'Xenova/bge-small-en-v1.5',
          },
          paused: true,
        });
      // Paused read authority needs a real native writer, but no document inference
      // or model download. Do not resume ingestion to make this assertion pass.
      await expect
        .poll(() => readNativeStatus(window), { timeout: 15_000 })
        .toMatchObject({
          authorizedCollectionIds: [initial.managedCollectionId],
          embedding: {
            indexMode: 'vector-configured',
            profile: { dtype: 'q8', modelId: 'Xenova/bge-small-en-v1.5' },
          },
          kind: 'ready',
          queryPlan: { inferencePlan: { device: 'wasm', dtype: 'q8' } },
        });
      await expect(window.getByRole('button', { name: 'Resume workspace index' })).toBeVisible();
      await testInfo.attach('paused-semantic-setup', {
        body: JSON.stringify({
          incomplete,
          preferences: await readSavedPreferences(window),
          status: await readNativeStatus(window),
        }),
        contentType: 'application/json',
      });
    }
  );

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
