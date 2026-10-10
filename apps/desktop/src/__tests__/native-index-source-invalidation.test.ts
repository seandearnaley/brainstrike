// @vitest-environment node
import type {
  CanonicalWorkspaceLease,
  CanonicalWorkspaceRuntimeDependencies,
} from '@brainstrike/canonical-ingestion';
import type { ScopedIndexerPort } from '@brainstrike/indexer';
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import type { CanonicalCollectionDependencies } from '../canonical-utility-parent';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import {
  emptyCollection,
  fixture,
  mocks,
  requestedScope,
  resetActivationFixture,
  storeId,
  unused,
  writer,
} from './native-index-activation-fixture';

beforeEach(resetActivationFixture);

function heldWorkspace() {
  const attached = Promise.withResolvers<void>();
  const physicallyClosed = Promise.withResolvers<void>();
  const close = vi.fn(async () => physicallyClosed.promise);
  const lease: CanonicalWorkspaceLease = {
    canonicalPath: '/actual/root',
    generation: 'owned-generation',
    listDir: unused,
    readFile: unused,
    retire: vi.fn(async () => {}),
    rootId: 'root',
    signal: new AbortController().signal,
    subscribe: unused,
  };
  const application = {
    roots: {
      borrowSourceRoot: async () => lease,
      restoreRoots: async () => [{ permissionState: 'granted', rootId: 'root' }],
    },
    watches: { subscribe: unused },
  } as unknown as ApplicationIpcDomain;
  mocks.database.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('FROM roots')
      ? [{ id: 'root', kind: 'path' }]
      : sql.includes('FROM embedding_sets')
        ? [{ id: 'selected' }]
        : [],
  }));
  mocks.readyPort.mockReturnValue({
    ...writer(),
    verifyScopedManifest: async (
      request: Parameters<ScopedIndexerPort['verifyScopedManifest']>[0]
    ) => ({
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      changed: [],
      complete: true,
      missing: [],
      scope: requestedScope(request),
      storeId,
      unexpected: [],
    }),
  });
  let attachments = 0;
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalWorkspaceRuntimeDependencies) => {
      attachments += 1;
      if (attachments === 1) {
        attached.resolve();
        // The real owner waits for its initial source receipt; graph invalidation
        // must cancel that wait even before physical retirement can be entered.
        return { close, trigger: unused };
      }
      const scope = { kind: 'workspace', rootId: 'root' } as const;
      const ticket = await dependencies.publication.beginScan({ requestId: 'next', scope });
      dependencies.onReceipt(
        await dependencies.publication.finishScan({
          aborted: false,
          errors: [],
          files: [],
          full: true,
          ticket,
          truncatedDirectories: [],
        })
      );
      return { close: async () => {}, trigger: unused };
    }
  );
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const f = fixture(application);
  return { ...f, attached, close, physicallyClosed };
}

it.each(['reconfigure', 'invalid-settings', 'terminal'] as const)(
  'cancels the held source receipt at graph invalidation before joining %s',
  async (operation) => {
    const f = heldWorkspace();
    const settings = JSON.parse(await f.storage.getItem()) as { state: { paused: boolean } };
    settings.state.paused = true;
    f.storage.getItem.mockResolvedValue(JSON.stringify(settings));
    await f.activation.acquire();
    settings.state.paused = false;
    f.storage.getItem.mockResolvedValue(JSON.stringify(settings));
    let initialSettled = false;
    const initial = f.activation.reconfigure().catch((error: unknown) => {
      initialSettled = true;
      return error;
    });
    let next: Promise<unknown> | undefined;
    onTestFinished(async () => {
      f.physicallyClosed.resolve();
      await f.activation.close();
      await Promise.allSettled([initial, next]);
    });
    await f.attached.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(initialSettled).toBe(false);
    if (operation === 'invalid-settings') {
      f.storage.getItem.mockResolvedValue('{}');
    }
    next = Promise.resolve(
      operation === 'terminal' ? f.activation.fenceTerminal() : f.activation.reconfigure()
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(initialSettled).toBe(true));
    if (operation === 'invalid-settings') {
      expect(await initial).toEqual(new Error('Native index preferences have no state.'));
    } else {
      expect(await initial).toMatchObject({ code: 'native-authority-transition' });
    }
    expect(mocks.closeProfile).not.toHaveBeenCalled();
    if (operation !== 'terminal') {
      await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
      expect(mocks.close).not.toHaveBeenCalled();
    }
    f.physicallyClosed.resolve();
    const result = await next;
    if (operation === 'invalid-settings') {
      expect(result).toBeInstanceOf(Error);
    } else {
      expect(result).toBeUndefined();
    }
  }
);

it('retains an independent physical source-close failure after graph invalidation', async () => {
  const f = heldWorkspace();
  const failure = new Error('Owned source failed to close');
  const settings = JSON.parse(await f.storage.getItem()) as { state: { paused: boolean } };
  settings.state.paused = true;
  f.storage.getItem.mockResolvedValue(JSON.stringify(settings));
  await f.activation.acquire();
  settings.state.paused = false;
  f.storage.getItem.mockResolvedValue(JSON.stringify(settings));
  const initial = f.activation.reconfigure().catch((error: unknown) => error);
  let replacing: Promise<unknown> | undefined;
  onTestFinished(async () => {
    f.physicallyClosed.resolve();
    f.close.mockReset().mockResolvedValue(undefined);
    await f.activation.close();
    await Promise.allSettled([initial, replacing]);
  });
  await f.attached.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.close.mockRejectedValueOnce(failure);
  replacing = f.activation.reconfigure().catch((error: unknown) => error);
  await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
  expect(await initial).toMatchObject({ code: 'native-authority-transition' });
  expect(await replacing).toMatchObject({ errors: [failure] });
  expect(mocks.closeProfile).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
});
