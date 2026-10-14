// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RootLock } from '@brainstrike/state-store';

const { StateStore } = await import(
  /* @vite-ignore */ pathToFileURL(
    createRequire(import.meta.url).resolve('@brainstrike/state-store')
  ).href
);

import { expect, test } from 'vitest';
import { createDesktopProfileResetOwner } from '../desktop-profile-reset-owner';

test('reset joins the existing SQLite writer before clearing, keeps its lock, and creates no PG data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bs-current-profile-reset-'));
  const store = await StateStore.open(root, { home: root });
  const sentinel = path.join(root, 'owned-data');
  await writeFile(sentinel, 'current');
  const held = Promise.withResolvers<void>();
  const reset = createDesktopProfileResetOwner({
    profilePath: () => root,
    retireProfile: async () => {
      await held.promise;
      await store.close();
    },
  });
  const pending = reset.prepare();
  expect(await readFile(sentinel, 'utf8')).toBe('current');
  expect(store.lock.isReleased).toBe(false);
  held.resolve();
  const lease = await pending;
  try {
    await reset.clear(lease);
    await expect(readFile(sentinel)).rejects.toThrow();
    await expect(readFile(path.join(root, 'pgdata', 'PG_VERSION'))).rejects.toThrow();
    expect(RootLock.inspect(root)?.owner).toBeDefined();
    expect(RootLock.inspect(root)?.owner.released).not.toBe(true);
    expect(lease.isReleased).toBe(false);
    await expect(reset.clear()).rejects.toThrow('active owned lease');
  } finally {
    lease.release();
    await rm(root, { force: true, recursive: true });
  }
});
test('failed writer retirement refuses deletion and is retried through the same owner', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bs-current-profile-reset-failed-'));
  await writeFile(path.join(root, 'owned-data'), 'retained');
  let calls = 0;
  const reset = createDesktopProfileResetOwner({
    profilePath: () => root,
    retireProfile: async () => {
      calls += 1;
      throw new Error('writer close failed');
    },
  });
  try {
    await expect(reset.prepare()).rejects.toThrow('writer close failed');
    await expect(reset.prepare()).rejects.toThrow('writer close failed');
    expect(calls).toBe(2);
    expect(await readFile(path.join(root, 'owned-data'), 'utf8')).toBe('retained');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
