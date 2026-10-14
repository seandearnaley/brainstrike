import { rmSync } from 'node:fs';
import { DEFAULT_VIEW_FILTER_PRESETS } from '@brainstrike/types';
import { afterEach, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(cleanupDirs);

test('preset writer preserves defaults and user identity across reopen, then profile deletion resets both', async () => {
  const root = freshDir('view-presets');
  let store = await StateStore.open(root);
  try {
    const initial = await store.viewFilterPresets({ operation: 'list' });
    expect(initial.presets.map((preset) => preset.name)).toEqual([
      'TypeScript/JavaScript',
      'All Code',
      'Documentation',
      'Config Files',
      'Styles',
      'Tests',
      'All Files',
    ]);
    expect(
      initial.presets.map(
        ({ id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...preset }) => preset
      )
    ).toEqual(DEFAULT_VIEW_FILTER_PRESETS);
    expect(initial.presets.every((preset) => preset.isDefault)).toBe(true);
    const defaultPreset = initial.presets[0];
    if (!defaultPreset) {
      throw new Error('Default preset missing');
    }
    expect(
      await store.viewFilterPresets({ id: defaultPreset.id, operation: 'delete' })
    ).toMatchObject({ deleted: false });
    const created = await store.viewFilterPresets({
      input: {
        excludes: ['src/generated/**'],
        includes: ['src/**'],
        name: 'Project sources',
        useRegex: false,
      },
      operation: 'create',
    });
    const preset = created.presets[0];
    if (!preset) {
      throw new Error('Created preset missing');
    }
    expect(preset).toMatchObject({ icon: 'file', isDefault: false, sortOrder: 8 });
    await store.viewFilterPresets({
      id: preset.id,
      input: { includes: ['lib/**'], name: 'My sources' },
      operation: 'update',
    });
    const before = await store.viewFilterPresets({ operation: 'list' });
    await store.close();
    store = await StateStore.open(root);
    expect(await store.viewFilterPresets({ operation: 'list' })).toEqual(before);
    expect(await store.viewFilterPresets({ id: preset.id, operation: 'delete' })).toMatchObject({
      deleted: true,
    });
    expect(
      await store.viewFilterPresets({ id: preset.id, input: { name: 'gone' }, operation: 'update' })
    ).toEqual({ presets: [] });
    await store.close();
    rmSync(root, { recursive: true });
    store = await StateStore.open(root);
    const reset = await store.viewFilterPresets({ operation: 'list' });
    expect(reset.presets.map((entry) => entry.name)).toEqual(
      initial.presets.map((entry) => entry.name)
    );
    expect(reset.presets.some((entry) => before.presets.some((old) => old.id === entry.id))).toBe(
      false
    );
  } finally {
    await store.close();
  }
});

test('preset mutations serialize next sort order and failed updates preserve committed records', async () => {
  const store = await StateStore.open(freshDir('view-preset-atomic'));
  try {
    const entries = await Promise.all(
      ['a', 'b'].map((name) =>
        store.viewFilterPresets({
          input: { excludes: [], includes: [], name },
          operation: 'create',
        })
      )
    );
    expect(entries.map((entry) => entry.presets[0]?.sortOrder)).toEqual([8, 9]);
    const before = await store.viewFilterPresets({ operation: 'list' });
    await expect(
      store.viewFilterPresets({
        id: entries[0]?.presets[0]?.id ?? '',
        input: { sortOrder: Number.NaN },
        operation: 'update',
      })
    ).rejects.toThrow();
    expect(await store.viewFilterPresets({ operation: 'list' })).toEqual(before);
  } finally {
    await store.close();
  }
});
