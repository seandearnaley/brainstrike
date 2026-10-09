import { afterEach, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(() => cleanupDirs());

test('a setting reads back across a reopen until it is deleted', async () => {
  const root = freshDir('settings');
  let store = await StateStore.open(root);
  try {
    expect(await store.getSetting('hooks.trust/r1')).toBeUndefined();
    await store.setSetting('hooks.trust/r1', 'v1');
    await store.setSetting('hooks.trust/r2', 'v2');
    await store.close();
    store = await StateStore.open(root);
    expect(await store.getSetting('hooks.trust/r1')).toBe('v1');

    expect(await store.deleteSetting('hooks.trust/r1')).toBe(true);
    expect(await store.deleteSetting('hooks.trust/r1')).toBe(false);
    expect(await store.getSetting('hooks.trust/r1')).toBeUndefined();
    expect(await store.getSetting('hooks.trust/r2')).toBe('v2');
  } finally {
    await store.close();
  }
});

test('factory reset removes every setting', async () => {
  const root = freshDir('settings-reset');
  const store = await StateStore.open(root);
  await store.setSetting('hooks.trust/r1', 'v1');

  await store.reset();

  const reopened = await StateStore.open(root);
  try {
    expect(await reopened.getSetting('hooks.trust/r1')).toBeUndefined();
  } finally {
    await reopened.close();
  }
});
