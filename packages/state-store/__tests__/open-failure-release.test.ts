// ADR-0031: a failed open is reported at once. Its cleanup goes on as the store's one owner and
// holds the Root lock until it ends, so no second opener enters beside the writer.
import { afterEach, expect, test } from 'vitest';
import { RootLockedError } from '../src/lock.js';
import { startupRelease } from '../src/startup-release.js';
import { StateStore, StateStoreStartupError } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(() => {
  cleanupDirs();
});

const failingStartup = (close: () => Promise<void>) => ({
  acquire: async (): Promise<undefined> => {
    throw new Error('platform failed to start');
  },
  close,
});

test('a failed open rejects while its cleanup still runs, and holds the Root until it ends', async () => {
  const root = freshDir('open-release');
  const cleanup = Promise.withResolvers<void>();
  let closing = false;
  const error = await StateStore.open(root, {
    startup: failingStartup(() => {
      closing = true;
      return cleanup.promise;
    }),
  }).catch((cause: unknown) => cause);

  expect(error).toMatchObject({ message: 'platform failed to start' });
  expect(closing).toBe(true);
  await expect(StateStore.open(root)).rejects.toBeInstanceOf(RootLockedError);

  cleanup.resolve();
  await startupRelease(error);
  const reopened = await StateStore.open(root);
  await reopened.close();
});

test('a failed open whose cleanup fails keeps the Root, and its release says so', async () => {
  const root = freshDir('open-retained');
  const error = await StateStore.open(root, {
    startup: failingStartup(() => Promise.reject(new Error('platform cleanup failed'))),
  }).catch((cause: unknown) => cause);

  expect(error).toMatchObject({ message: 'platform failed to start' });
  const released = await startupRelease(error).catch((cause: unknown) => cause);
  expect(released).toBeInstanceOf(StateStoreStartupError);
  await expect(StateStore.open(root)).rejects.toBeInstanceOf(RootLockedError);
  if (released instanceof StateStoreStartupError) {
    await released.store.close();
  }
});
