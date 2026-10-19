// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { IndexerUtilityExitedError } from '../indexer-utility-exit';

const manager = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  exited: false,
  start: vi.fn(async () => ({})),
}));
vi.mock('../indexer-host-manager', () => ({
  IndexerHostManager: { create: vi.fn(async () => manager) },
}));

import { acquireIndexerHost, closeIndexerRuntime, getReadyIndexerHost } from '../indexer-runtime';

// BST-2135: a signal to Main's process group ends the utility before shutdown retires it.
it('refuses an exited host with its typed exit, so retirement can settle that outcome', async () => {
  await acquireIndexerHost(
    { dbPath: '/owned/profile/index.sqlite', embedding: { indexMode: 'text-only' }, rootIds: [] },
    { closeMs: 1000, exitMs: 1000, requestMs: 5000, startupMs: 60_000 }
  );
  expect(getReadyIndexerHost()).toBe(manager);
  manager.exited = true;
  expect(getReadyIndexerHost).toThrow(IndexerUtilityExitedError);
  await closeIndexerRuntime(async () => {});
  expect(manager.close).toHaveBeenCalledOnce();
  expect(getReadyIndexerHost).toThrow(/owned host is not ready/);
});
