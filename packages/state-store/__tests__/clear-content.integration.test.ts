import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { RootLock } from '../src/lock.js';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { TruthIndexer } from './helpers/truth-indexer.js';

afterEach(cleanupDirs);

test('terminal content clear removes canonical content and blobs but preserves configuration across reopen', async () => {
  const root = freshDir('clear-content');
  const indexer = new TruthIndexer(root);
  let store = await StateStore.open(root, { indexer });
  try {
    await store.setSetting('search-mode', 'text');
    await store.setSetting(
      'mcp.extensionPreferences',
      JSON.stringify({ v1: { apps: false, tasks: true } })
    );
    await store.promptCatalog({
      input: { content: 'Recorded prompt body', id: 'prompt', title: 'Prompt' },
      operation: 'create',
    });
    await store.threadGroups({
      group: {
        color: null,
        icon: null,
        id: 'group',
        name: 'Clear group',
        rank: 'a0',
        resourceId: 'workspace',
      },
      operation: 'create',
    });
    await store.modelChoices({ enabled: true, operation: 'provider', providerId: 'openrouter' });
    await store.modelChoices({
      models: [{ enabled: true, modelId: 'test', providerId: 'openrouter' }],
      operation: 'models',
    });
    await store.viewFilterPresets({
      input: { excludes: [], includes: ['src/**'], name: 'User preset', useRegex: false },
      operation: 'create',
    });
    const presets = await store.viewFilterPresets({ operation: 'list' });
    const choices = await store.modelChoices({ operation: 'snapshot' });
    await store.workspaceRoots({
      operation: 'register',
      root: { displayName: 'Clear', path: '/disposable/clear', preferredId: 'root' },
    });
    const content = 'Actual canonical source bytes';
    const contentHash = createHash('sha256').update(content).digest('hex');
    await store.sourceCatalog({
      embeddingSetId: null,
      files: [
        {
          content,
          contentHash,
          fileName: 'file.txt',
          path: 'file.txt',
          stat: { mtimeMs: 1, size: Buffer.byteLength(content) },
        },
      ],
      operation: 'prepare',
      rootId: 'root',
    });
    await store.append([
      {
        event: { content: 'Fresh current-format content', type: 'user.message' },
        threadId: 'thread',
      },
    ]);
    expect(existsSync(join(root, 'blobs', contentHash))).toBe(true);
    expect(await store.clearContent()).toEqual({ deletedChunks: null, deletedFiles: 1 });
    await expect(
      store.append([{ event: { content: 'late', type: 'user.message' }, threadId: 'late' }])
    ).rejects.toThrow();
    expect(existsSync(join(root, 'state.db'))).toBe(true);
    expect(existsSync(join(root, 'blobs', contentHash))).toBe(false);
    store = await StateStore.open(root);
    expect(await store.viewFilterPresets({ operation: 'list' })).toEqual(presets);
    expect(await store.modelChoices({ operation: 'snapshot' })).toEqual(choices);
    expect(await store.getSetting('search-mode')).toBe('text');
    expect(await store.getSetting('mcp.extensionPreferences')).toBe(
      JSON.stringify({ v1: { apps: false, tasks: true } })
    );
    expect(
      (await store.promptCatalog({ filter: { includeArchived: true }, operation: 'list' })).items
    ).toEqual([]);
    expect(await store.threadGroups({ operation: 'list', resourceId: 'workspace' })).toEqual({
      groups: [],
      placements: [],
    });
    const reader = new DatabaseSync(join(root, 'state.db'), { readOnly: true });
    try {
      const retainedTables = new Set([
        'settings',
        'model_choices',
        'provider_choices',
        'view_filter_presets',
      ]);
      const tables = reader
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all();
      for (const table of tables) {
        const name = String(table['name']);
        if (retainedTables.has(name)) {
          continue;
        }
        expect(reader.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get()?.['count'], name).toBe(
          0
        );
      }
    } finally {
      reader.close();
    }
    expect(await store.workspaceRoots({ operation: 'list' })).toEqual({ roots: [] });
    expect(
      (await store.sourceCatalog({ embeddingSetId: null, operation: 'inventory' })).files
    ).toEqual([]);
    expect(await store.read('thread')).toEqual([]);
  } finally {
    await store.close();
    indexer.close();
  }
});

test('physical index retirement blocks clear and later writes until the existing reader joins', async () => {
  const root = freshDir('clear-content-held');
  const indexer = new TruthIndexer(root);
  const release = Promise.withResolvers<void>();
  const reset = indexer.reset.bind(indexer);
  indexer.reset = async () => {
    await release.promise;
    await reset();
  };
  const store = await StateStore.open(root, { indexer });
  await store.append([
    { event: { content: 'retained', type: 'user.message' }, threadId: 'thread' },
  ]);
  const clearing = store.clearContent();
  try {
    await expect(
      store.append([{ event: { content: 'late', type: 'user.message' }, threadId: 'late' }])
    ).rejects.toThrow();
    expect(RootLock.inspect(root)?.owner.released).not.toBe(true);
    expect(await store.read('thread')).toHaveLength(1);
  } finally {
    release.resolve();
    await clearing;
    await store.close();
    indexer.close();
  }
});
