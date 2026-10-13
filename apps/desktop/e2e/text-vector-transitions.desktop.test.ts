/**
 * Desktop E2E (BST-1988): moving between text-only and semantic search.
 *
 * TEXT→VECTOR: a workspace indexed as the TEXT partition (no model) is
 * re-ingested into the collection a model creates; semantic search then works,
 * and text search reads that collection only. The TEXT partition's PG sources
 * stay, unreachable, as an outgoing collection's do.
 * VECTOR→TEXT: the saved collection stays; semantic search turns off and text
 * search keeps reading the same collection.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { Page } from '@playwright/test';
import type { VisibleEmbeddingHostBridge } from '../src/types/desktop-electron-api';
import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { seedRoot } from './utils/seed-root';

const MARKER = 'transition-marker-1988';
const PREFERENCES_KEY = 'background-indexing-preferences.v1';
const MODEL = 'BGE Small';

async function openSearchSettings(page: Page) {
  await new HomePage(page).openSettings();
  return await new SettingsPage(page).openCategory(/Search & Indexing/i, 'search-indexing');
}

async function chooseSearchMode(page: Page, mode: 'Text search' | 'Text and semantic search') {
  const section = await openSearchSettings(page);
  await section.getByRole('combobox', { name: 'Search mode' }).click();
  await page.getByRole('option', { exact: true, name: mode }).click();
  if (mode === 'Text and semantic search') {
    await section.getByRole('combobox', { name: 'Local model execution' }).click();
    await page.getByRole('option', { exact: true, name: 'WASM · Q8' }).click();
  }
  await new HomePage(page).leaveSettings();
}

/** The visible model choice, which creates (or selects) that model's collection. */
async function chooseModel(page: Page): Promise<void> {
  const section = await openSearchSettings(page);
  await section.getByRole('combobox', { exact: true, name: 'Embedding model' }).click();
  await page.getByRole('option', { name: new RegExp(MODEL) }).click();
  await section.getByRole('button', { exact: true, name: 'Use embedding model' }).click();
  await expect(section.getByRole('combobox', { name: 'Managed collection' })).toContainText(
    `Workspace Index (${MODEL})`,
    { timeout: 15_000 }
  );
  await new HomePage(page).leaveSettings();
}

/** Ready with every root scanned, in the expected mode; vectors complete when semantic. */
async function waitForIndex(page: Page, mode: 'text-only' | 'vector-configured'): Promise<void> {
  await expect
    .poll(
      async () =>
        await page.evaluate(async (expected) => {
          const capability = (window as Window & { readonly indexSearch?: IndexSearchCapability })
            .indexSearch;
          if (!capability) {
            throw new Error('The native index capability is unavailable');
          }
          const status = await capability.status();
          if (
            status.kind !== 'ready' ||
            status.embedding.indexMode !== expected ||
            status.rootReadiness.length !== 1 ||
            !status.rootReadiness.every((root) => root.scanComplete)
          ) {
            return false;
          }
          if (expected === 'text-only') {
            return true;
          }
          const observation = await capability.coverageBatch([
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
        }, mode),
      { timeout: 180_000 }
    )
    .toBe(true);
}

/** Native text search hits for the marker: each hit's file and the partition it belongs to. */
async function textHits(page: Page): Promise<{ path: string; set: string | null }[]> {
  return await page.evaluate(async (needle) => {
    const capability = (window as Window & { readonly indexSearch?: IndexSearchCapability })
      .indexSearch;
    if (!capability) {
      throw new Error('The native index capability is unavailable');
    }
    const status = await capability.status();
    if (status.kind !== 'ready') {
      throw new Error(status.reason);
    }
    const result = await capability.grep({
      caseSensitive: true,
      isRegex: false,
      limit: 20,
      pattern: needle,
      rootIds: status.authorizedRootIds,
    });
    return result.hits
      .map((hit) => ({ path: hit.relativePath ?? '', set: hit.embeddingSetId ?? null }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }, MARKER);
}

async function semanticFinds(page: Page, phrase: string): Promise<boolean> {
  return await page.evaluate(async (query) => {
    const bridges = window as Window & {
      readonly embeddingHost?: VisibleEmbeddingHostBridge;
      readonly indexSearch?: IndexSearchCapability;
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
      throw new Error('The selected collection has no ready semantic query plan');
    }
    const vector = await bridge.queryEmbedding({
      dimensions: status.embedding.profile.dimensions,
      modelId: status.embedding.profile.modelId,
      modelKey: status.queryPlan.modelKey,
      query,
      ...(status.queryPlan.inferencePlan ? { inferencePlan: status.queryPlan.inferencePlan } : {}),
    });
    const result = await capability.search({
      limit: 5,
      mode: 'vector',
      profile: status.embedding.profile,
      rootIds: status.authorizedRootIds,
      vector,
    });
    return result.hits.some((hit) => hit.content.includes('sourdough starter'));
  }, phrase);
}

async function savedCollection(page: Page): Promise<string | null> {
  return await page.evaluate(async (key) => {
    const saved = await window.electronAPI?.storage.getItem(key);
    if (!saved) {
      throw new Error('Search & Indexing choices were not saved');
    }
    return (JSON.parse(saved) as { state: { managedCollectionId: string | null } }).state
      .managedCollectionId;
  }, PREFERENCES_KEY);
}

/** Canonical workspace source records in the TEXT partition. */
async function textPartitionRows(page: Page): Promise<number> {
  return await page.evaluate(async () => {
    if (!window.sourceFiles) {
      throw new Error('Desktop source catalog is unavailable');
    }
    return (await window.sourceFiles.list()).filter(
      (file) => file.embeddingSetId === null && file.rootId !== null
    ).length;
  });
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
    // The semantic step selects WASM through the visible execution control.
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
      await chooseSearchMode(page, 'Text search');
      await waitForIndex(page, 'text-only');
      expect(await savedCollection(page)).toBeNull();
      expect(await textHits(page)).toEqual([
        { path: 'bread.md', set: null },
        { path: 'notes.txt', set: null },
      ]);

      await chooseModel(page);
      await chooseSearchMode(page, 'Text and semantic search');
      await waitForIndex(page, 'vector-configured');
      const collectionId = await savedCollection(page);
      expect(collectionId).not.toBeNull();
      expect(await semanticFinds(page, 'how to keep a bread starter alive')).toBe(true);

      // The outgoing TEXT partition's PG sources stay, as an outgoing
      // collection's do, but no reader reaches them: text search returns the
      // collection's rows once each, never a duplicate from the NULL partition.
      expect(await textPartitionRows(page)).toBe(2);
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
      await chooseSearchMode(page, 'Text search');
      await waitForIndex(page, 'text-only');
      expect(await textHits(page)).toEqual([
        { path: 'bread.md', set: null },
        { path: 'notes.txt', set: null },
      ]);

      // The order a person picks them: semantic search, then its model, then
      // the model's execution. Each choice is saved before the next exists.
      const section = await openSearchSettings(page);
      await section.getByRole('combobox', { name: 'Search mode' }).click();
      await page.getByRole('option', { exact: true, name: 'Text and semantic search' }).click();
      await section.getByRole('combobox', { exact: true, name: 'Embedding model' }).click();
      await page.getByRole('option', { name: new RegExp(MODEL) }).click();
      await section.getByRole('button', { exact: true, name: 'Use embedding model' }).click();
      await expect(section.getByRole('combobox', { name: 'Managed collection' })).toContainText(
        `Workspace Index (${MODEL})`,
        { timeout: 15_000 }
      );
      await section.getByRole('combobox', { name: 'Local model execution' }).click();
      await page.getByRole('option', { exact: true, name: 'WASM · Q8' }).click();
      await new HomePage(page).leaveSettings();

      await waitForIndex(page, 'vector-configured');
      const collectionId = await savedCollection(page);
      expect(collectionId).not.toBeNull();
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

  test('turning semantic search off keeps the collection and its text search', async ({
    electron,
    window: page,
  }) => {
    test.setTimeout(480_000);
    const root = workspaceFolder();
    try {
      await seedRoot(page, root, { reloadReason: 'm6-vector-to-text', rootId: randomUUID() });
      await chooseModel(page);
      await chooseSearchMode(page, 'Text and semantic search');
      await waitForIndex(page, 'vector-configured');
      const collectionId = await savedCollection(page);
      expect(collectionId).not.toBeNull();

      await chooseSearchMode(page, 'Text search');
      await waitForIndex(page, 'text-only');
      expect(await savedCollection(page)).toBe(collectionId);
      expect(await textPartitionRows(page)).toBe(0);
      expect(await textHits(page)).toEqual([
        { path: 'bread.md', set: collectionId },
        { path: 'notes.txt', set: collectionId },
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
          'Semantic search is off. Choose “Text and semantic search” in Search & Indexing settings.',
          { timeout: 2000 }
        );
      }).toPass({ timeout: 30_000 });
    } finally {
      await electron.dispose();
      rmSync(root, { force: true, recursive: true });
    }
  });
});
