// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { IndexerUtilityExitedError } from '../indexer-utility-exit';

const manager = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  exited: false,
  joinExit: vi.fn(async () => {}),
  start: vi.fn(async () => ({})),
}));
const create = vi.hoisted(() => vi.fn(async () => manager));
vi.mock('../indexer-host-manager', () => ({ IndexerHostManager: { create } }));

import { acquireIndexerHost, closeIndexerRuntime, getReadyIndexerHost } from '../indexer-runtime';

// BST-2135: a signal to Main's process group ends the utility before shutdown retires it.
it('refuses an exited host with its typed exit, so retirement can settle that outcome', async () => {
  await acquireIndexerHost(
    { dbPath: '/owned/profile/index.sqlite', embedding: { indexMode: 'text-only' }, rootIds: [] },
    { closeMs: 1000 }
  );
  expect(getReadyIndexerHost()).toBe(manager);
  manager.exited = true;
  expect(getReadyIndexerHost).toThrow(IndexerUtilityExitedError);
  await closeIndexerRuntime(async () => {});
  expect(manager.close).toHaveBeenCalledOnce();
  expect(getReadyIndexerHost).toThrow(/owned host is not ready/);
});

const options = {
  dbPath: '/owned/profile/index.sqlite',
  embedding: { indexMode: 'text-only' },
  rootIds: [],
};

// ADR-0031: a close joins no process; only the replacement that opens the same files joins it.
it('closes without the utility exit, and starts a replacement only after that exit', async () => {
  manager.exited = false;
  await acquireIndexerHost(options, { closeMs: 1000 });
  const exit = Promise.withResolvers<void>();
  manager.joinExit.mockReturnValueOnce(exit.promise);
  create.mockClear();

  await closeIndexerRuntime(async () => {});
  const replacement = acquireIndexerHost(options, { closeMs: 1000 });
  await vi.waitFor(() => expect(manager.joinExit).toHaveBeenCalled());
  expect(create).not.toHaveBeenCalled();

  exit.resolve();
  await expect(replacement).resolves.toBe(manager);
  expect(create).toHaveBeenCalledOnce();
  await closeIndexerRuntime(async () => {});
});
