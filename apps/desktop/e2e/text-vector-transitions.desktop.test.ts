/**
 * Desktop E2E (BST-1988): moving between text-only and semantic search.
 *
 * TEXT→VECTOR: a workspace indexed as the TEXT partition (no model) is
 * re-ingested into the vector space the model's config creates; semantic search
 * then works, and text search reads that space only. The TEXT partition's PG
 * sources stay, unreachable, as an outgoing collection's do.
 * VECTOR→TEXT: the saved model and its vector space stay; semantic search turns
 * off and text search reads the TEXT partition again.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IndexerStatus } from '@brainstrike/indexing-contract/indexer-client';
import type { Page } from '@playwright/test';
import type { VisibleEmbeddingHostBridge } from '../src/types/desktop-electron-api';
import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readIndexConfig, updateIndexConfig } from './utils/index-config';
import { seedRoot } from './utils/seed-root';
import { callIndexSearch, nativeStatus } from './utils/text-search-mode';

const MARKER = 'transition-marker-1988';
const MODEL = 'BGE Small';
const MODEL_KEY = 'local::Xenova/bge-small-en-v1.5';

async function openSearchSettings(page: Page) {
  await new HomePage(page).openSettings();
  return await new SettingsPage(page).openCategory(/Search & Indexing/i, 'search-indexing');
}

/** Semantic search with BGE Small on WASM · Q8, saved through Main as Settings saves it. */
async function chooseSemanticSearch(page: Page): Promise<void> {
  await updateIndexConfig(page, {
    mode: 'semantic',
    model: { dimensions: 384, local: { device: 'wasm', dtype: 'q8' }, modelKey: MODEL_KEY },
  });
}

/** The ready index's status; anything else fails with its own reason. */
async function readyStatus(page: Page): Promise<Extract<IndexerStatus, { kind: 'ready' }>> {
  const status = await nativeStatus(page);
  if (status.kind !== 'ready') {
    throw new Error(status.reason);
  }
  return status;
}

/** The one vector space the ready index serves under semantic search. */
async function servedCollection(page: Page): Promise<string> {
  const served = (await readyStatus(page)).authorizedCollectionIds ?? [];
  expect(served).toHaveLength(1);
  const [collectionId] = served;
  if (collectionId === undefined) {
    throw new Error('The ready index serves no vector space');
  }
  return collectionId;
}

/** Ready with every root scanned, in the expected mode; vectors complete when semantic. */
async function waitForIndex(page: Page, mode: 'text-only' | 'vector-configured'): Promise<void> {
  await expect
    .poll(
      async () => {
        const status = await nativeStatus(page);
        if (
          status.kind !== 'ready' ||
          status.embedding.indexMode !== mode ||
          status.rootReadiness.length !== 1 ||
          !status.rootReadiness.every((root) => root.scanComplete)
        ) {
          return false;
        }
        if (mode === 'text-only') {
          return true;
        }
        const observation = await callIndexSearch(page, 'coverageBatch', [
          { rootIds: status.authorizedRootIds },
        ]);
        if (observation.kind === 'blocked') {
          throw new Error(observation.reason);
        }
        const coverage = observation.kind === 'current' ? observation.coverage[0] : undefined;
        return (
          coverage !== undefined &&
          coverage.totals.chunks > 0 &&
          coverage.totals.vectors === coverage.totals.chunks
        );
      },
      { timeout: 180_000 }
    )
    .toBe(true);
}

/** Native text search hits for the marker: each hit's file and the partition it belongs to. */
async function textHits(page: Page): Promise<{ path: string; set: string | null }[]> {
  const result = await callIndexSearch(page, 'grep', {
    caseSensitive: true,
    isRegex: false,
    limit: 20,
    pattern: MARKER,
    rootIds: (await readyStatus(page)).authorizedRootIds,
  });
  return result.hits
    .map((hit) => ({ path: hit.relativePath ?? '', set: hit.embeddingSetId ?? null }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function semanticFinds(page: Page, phrase: string): Promise<boolean> {
  const status = await readyStatus(page);
  if (status.embedding.indexMode !== 'vector-configured' || !status.queryPlan) {
    throw new Error('The selected collection has no ready semantic query plan');
  }
  const { profile } = status.embedding;
  const queryPlan = status.queryPlan;
  const vector = await page.evaluate(
    async (request) => {
      const bridge = (window as Window & { readonly embeddingHost?: VisibleEmbeddingHostBridge })
        .embeddingHost;
      if (!(bridge && 'queryEmbedding' in bridge)) {
        throw new Error('Native query bridge unavailable');
      }
      const response = await bridge.queryEmbedding(request);
      if (!response.ok) {
        throw new Error(JSON.stringify(response.error));
      }
      return response.value;
    },
    {
      dimensions: profile.dimensions,
      modelId: profile.modelId,
      modelKey: queryPlan.modelKey,
      query: phrase,
      ...(queryPlan.inferencePlan ? { inferencePlan: queryPlan.inferencePlan } : {}),
    }
  );
  const result = await callIndexSearch(page, 'search', {
    limit: 5,
    mode: 'vector',
    profile,
    rootIds: status.authorizedRootIds,
    vector,
  });
  return result.hits.some((hit) => hit.content.includes('sourdough starter'));
}

function workspaceFolder(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m6-transition-')));
  writeFileSync(
    path.join(root, 'bread.md'),
    `# Bread\nA sourdough starter needs flour, water and patience. ${MARKER}\n`
  );
  writeFileSync(path.join(root, 'notes.txt'), `unrelated notes ${MARKER}\n`);
  return root;
}

test.describe('Text and semantic search transitions (desktop)', () => {
  test.beforeEach(() => {
    // The semantic step chooses WASM explicitly, as the visible execution control does.
    process.env['BRAINSTRIKE_E2E_ALLOW_GPU'] = '1';
  });
  test.afterEach(() => {
    delete process.env['BRAINSTRIKE_E2E_ALLOW_GPU'];
  });

  test('a text-only workspace moves into the chosen model’s collection', async ({
    electron,
    window: page,
  }) => {
    test.setTimeout(480_000);
    const root = workspaceFolder();
    try {
      await seedRoot(page, root, { reloadReason: 'm6-text-to-vector', rootId: randomUUID() });
      await waitForIndex(page, 'text-only');
      expect(await readIndexConfig(page)).toMatchObject({ mode: 'text', model: null });
      expect(await textHits(page)).toEqual([
        { path: 'bread.md', set: null },
        { path: 'notes.txt', set: null },
      ]);

      await chooseSemanticSearch(page);
      await waitForIndex(page, 'vector-configured');
      const collectionId = await servedCollection(page);
      expect(await semanticFinds(page, 'how to keep a bread starter alive')).toBe(true);

      // Text search returns the collection's rows once each, never a duplicate
      // from the outgoing TEXT partition.
      expect(await textHits(page)).toEqual([
        { path: 'bread.md', set: collectionId },
        { path: 'notes.txt', set: collectionId },
      ]);
    } finally {
      await electron.dispose();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('a text-only workspace moves into a model chosen after semantic search', async ({
    electron,
    window: page,
  }) => {
    test.setTimeout(480_000);
    const root = workspaceFolder();
    try {
      await seedRoot(page, root, { reloadReason: 'm6-text-mode-first', rootId: randomUUID() });
      await waitForIndex(page, 'text-only');
      expect(await textHits(page)).toEqual([
        { path: 'bread.md', set: null },
        { path: 'notes.txt', set: null },
      ]);

      // The order a person picks them on the Settings page: semantic search, then
      // its model, then the model's execution, staged until Apply saves them together.
      const section = await openSearchSettings(page);
      await section
        .getByRole('group', { name: 'Search mode' })
        .getByRole('button', { name: /^Semantic/ })
        .click();
      const pending = section.getByRole('status', { name: 'Pending changes' });
      const apply = pending.getByRole('button', { exact: true, name: 'Apply and re-index' });
      await expect(apply).toBeDisabled();
      await section.getByRole('combobox', { exact: true, name: 'Embedding model' }).click();
      await page.getByRole('option', { name: new RegExp(MODEL) }).click();
      await expect(apply).toBeDisabled();
      await section.getByRole('combobox', { exact: true, name: 'Run it on' }).click();
      await page.getByRole('option', { exact: true, name: 'WASM · Q8' }).click();
      await apply.click();
      await expect(pending).toBeHidden({ timeout: 15_000 });
      expect(await readIndexConfig(page)).toMatchObject({
        mode: 'semantic',
        model: { dimensions: 384, local: { device: 'wasm', dtype: 'q8' }, modelKey: MODEL_KEY },
      });
      await new HomePage(page).leaveSettings();

      await waitForIndex(page, 'vector-configured');
      const collectionId = await servedCollection(page);
      expect(await semanticFinds(page, 'how to keep a bread starter alive')).toBe(true);
      expect(await textHits(page)).toEqual([
        { path: 'bread.md', set: collectionId },
        { path: 'notes.txt', set: collectionId },
      ]);
    } finally {
      await electron.dispose();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('turning semantic search off keeps the model and its vector space, and text search works', async ({
    electron,
    window: page,
  }) => {
    test.setTimeout(480_000);
    const root = workspaceFolder();
    try {
      await seedRoot(page, root, { reloadReason: 'm6-vector-to-text', rootId: randomUUID() });
      await chooseSemanticSearch(page);
      await waitForIndex(page, 'vector-configured');
      const collectionId = await servedCollection(page);

      // Text applies right away from the Search mode group.
      const section = await openSearchSettings(page);
      const text = section
        .getByRole('group', { name: 'Search mode' })
        .getByRole('button', { name: /^Text/ });
      await text.click();
      await expect(text).toHaveAttribute('aria-pressed', 'true');
      await new HomePage(page).leaveSettings();
      await waitForIndex(page, 'text-only');
      expect(await readIndexConfig(page)).toMatchObject({
        mode: 'text',
        model: { modelKey: MODEL_KEY },
      });
      expect(await textHits(page)).toEqual([
        { path: 'bread.md', set: null },
        { path: 'notes.txt', set: null },
      ]);

      // Semantic search says which setting turns it back on.
      await ensureFileExplorerPanelVisible(page);
      await page
        .getByRole('tablist', { name: 'Explorer and search' })
        .getByRole('tab', { name: 'Search' })
        .click();
      const semantic = page
        .getByTestId('explorer-search-panel-search')
        .getByRole('button', { name: 'Semantic' });
      await expect(semantic).toHaveAttribute('aria-disabled', 'true', { timeout: 15_000 });
      await expect(async () => {
        await semantic.hover();
        await expect(page.getByRole('tooltip').first()).toHaveText(
          'Semantic search is off. Choose Semantic in Settings, Search & Indexing.',
          { timeout: 2000 }
        );
      }).toPass({ timeout: 30_000 });

      // Semantic search comes back on the vector space it kept: nothing is re-embedded.
      await updateIndexConfig(page, { mode: 'semantic' });
      await waitForIndex(page, 'vector-configured');
      expect(await servedCollection(page)).toBe(collectionId);
    } finally {
      await electron.dispose();
      rmSync(root, { force: true, recursive: true });
    }
  });
});
