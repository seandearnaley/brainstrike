import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { RootLock } from '../src/lock.js';
import { BLOB_MIN_BYTES, StateStore, sha256Hex } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { appendInputs, prose, rng } from './helpers/testkit.js';
import { TruthIndexer } from './helpers/truth-indexer.js';

afterEach(cleanupDirs);

test('terminal content clear removes content and blobs but preserves configuration across reopen', async () => {
  const root = freshDir('clear-content');
  const indexer = new TruthIndexer(root);
  let store = await StateStore.open(root, { indexer });
  try {
    await store.setSetting('search-mode', 'text');
    await store.setSetting(
      'mcp.extensionPreferences',
      JSON.stringify({ v1: { apps: false, tasks: true } })
    );
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
    const { roots: registered } = await store.workspaceRoots({
      operation: 'register',
      root: {
        canonicalPath: '/disposable/clear',
        displayName: 'Clear',
        path: '/disposable/clear',
        preferredId: 'root',
      },
    });
    // A project's name (ADR-0034) goes with its project.
    await store.workspaceRoots({
      name: 'Named project',
      operation: 'rename-project',
      projectId: registered[0]?.projectId ?? '',
    });
    // A thread's scratch folder (ADR-0034) goes with the roots and threads.
    await store.workspaceRoots({
      operation: 'register-scratch',
      root: {
        canonicalPath: '/disposable/scratch/quiet-otter',
        displayName: 'quiet-otter',
        path: '/disposable/scratch/quiet-otter',
        preferredId: 'scratch-root',
      },
      threadId: 'thread',
    });
    const content = prose(rng(1), BLOB_MIN_BYTES);
    const contentHash = sha256Hex(content);
    await appendInputs(store, 'thread', [{ output: content, type: 'tool-result' }]);
    await store.append([
      {
        event: { content: 'Fresh current-format content', type: 'user.message' },
        threadId: 'thread',
      },
    ]);
    expect(existsSync(join(root, 'blobs', contentHash))).toBe(true);
    await store.clearContent();
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
    expect(await store.threadGroups({ operation: 'list', resourceId: 'workspace' })).toEqual({
      groups: [],
      pins: [],
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
