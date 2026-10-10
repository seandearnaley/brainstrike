// @vitest-environment node
import type {
  CanonicalWorkspaceLease,
  CanonicalWorkspaceRuntimeDependencies,
} from '@brainstrike/canonical-ingestion';
import type { ScopedIndexerPort } from '@brainstrike/indexer';
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import type { CanonicalCollectionDependencies } from '../canonical-utility-parent';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import { createNativeRootDataDeletion } from '../native-root-data-deletion';
import { createNativeRootRegistration } from '../native-root-registration';
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

function heldWorkspace(beforeAttach?: () => Promise<void>) {
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
        await beforeAttach?.();
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
  return { ...f, application, attached, close, physicallyClosed };
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

it('starts saved Pause cancellation while root registration owns an incomplete first receipt', async () => {
  const f = heldWorkspace();
  const settings = JSON.parse(await f.storage.getItem()) as { state: { paused: boolean } };
  settings.state.paused = true;
  f.storage.getItem.mockResolvedValue(JSON.stringify(settings));
  const reader = await f.activation.acquire();
  const captured = f.activation.captureAcknowledgedAuthority();
  const transitions = createNativeRootDataDeletion({
    acquire: unused,
    captureOwner: unused,
    closeOwner: unused,
    deleteCanonicalRoot: unused,
    reserveRoot: () => {
      throw new Error('This registration fixture does not delete roots.');
    },
    resume: unused,
    stopSources: unused,
  });
  const registration = createNativeRootRegistration({
    isShuttingDown: () => false,
    reconfigure: () => f.activation.reconfigure(),
    reportError: vi.fn(),
    transition: transitions.transition,
  });
  settings.state.paused = false;
  f.storage.getItem.mockResolvedValue(JSON.stringify(settings));
  const registered = registration.rootsRegistered().catch((error: unknown) => error);
  let paused: Promise<unknown> | undefined;
  onTestFinished(async () => {
    f.physicallyClosed.resolve();
    await f.activation.close();
    await Promise.allSettled([registered, paused]);
  });
  await f.attached.promise;
  settings.state.paused = true;
  f.storage.getItem.mockResolvedValue(JSON.stringify(settings));
  // Main's current onStorageChanged callback places the entire reconfiguration
  // behind the registration's first-receipt join in this existing FIFO.
  paused = transitions
    .prepareTransition(
      () => f.activation.prepareSavedPause(),
      (prepared) => (prepared ? prepared.complete() : f.activation.reconfigure())
    )
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
  f.physicallyClosed.resolve();
  await expect(paused).resolves.toBeUndefined();
  expect(await f.activation.acquireRead()).toBe(reader);
  expect(f.activation.captureAcknowledgedAuthority().readAuthority()).toEqual(
    captured.readAuthority()
  );
  expect(mocks.closeProfile).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
});

it.each(['settings', 'graph', 'attachment'] as const)(
  'retains %s startup until read readiness, then prepares Pause without joining its physical source',
  async (phase) => {
    const gate = Promise.withResolvers<void>();
    const f = heldWorkspace(phase === 'attachment' ? () => gate.promise : undefined);
    const saved = await f.storage.getItem();
    const settings = JSON.parse(saved) as { state: { paused: boolean } };
    if (phase === 'settings') {
      f.storage.getItem.mockReturnValueOnce(gate.promise.then(() => saved));
    }
    if (phase === 'graph') {
      const restore = f.application.roots.restoreRoots;
      f.application.roots.restoreRoots = async () => {
        await gate.promise;
        return restore();
      };
    }
    const initial = f.activation.acquire().catch((error: unknown) => error);
    if (phase === 'attachment') {
      await f.attached.promise;
    }
    settings.state.paused = true;
    f.storage.getItem.mockResolvedValue(JSON.stringify(settings));
    let prepared = false;
    const preparation = f.activation.prepareSavedPause().then((value) => {
      prepared = true;
      return value;
    });
    onTestFinished(async () => {
      gate.resolve();
      f.physicallyClosed.resolve();
      await f.activation.close();
      await Promise.allSettled([initial, preparation]);
    });
    if (phase !== 'attachment') {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(prepared).toBe(false);
      expect(mocks.manager.retireCanonicalSources).not.toHaveBeenCalled();
      gate.resolve();
    }
    const pause = await preparation;
    expect(pause).not.toBeNull();
    if (!pause) {
      throw new Error('Saved Pause did not retain its source retirement');
    }
    expect(mocks.manager.retireCanonicalSources).toHaveBeenCalledOnce();
    let physical = false;
    void pause.physical.then(() => {
      physical = true;
    });
    if (phase === 'attachment') {
      expect(physical).toBe(false);
      gate.resolve();
      await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    }
    f.physicallyClosed.resolve();
    await pause.complete();
    await expect(f.activation.acquireRead()).resolves.toBeDefined();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.closeProfile).not.toHaveBeenCalled();
  }
);

it.each(['invalid-settings', 'physical-failure'] as const)(
  'retains prepared %s admission closure and its actual failure through later reads',
  async (kind) => {
    const f = heldWorkspace();
    const settings = JSON.parse(await f.storage.getItem()) as { state: { paused: boolean } };
    settings.state.paused = true;
    f.storage.getItem.mockResolvedValue(JSON.stringify(settings));
    await f.activation.acquire();
    settings.state.paused = false;
    f.storage.getItem.mockResolvedValue(JSON.stringify(settings));
    const initial = f.activation.reconfigure().catch((error: unknown) => error);
    onTestFinished(async () => {
      f.close.mockResolvedValue(undefined);
      f.physicallyClosed.resolve();
      await f.activation.close();
      await initial;
    });
    await f.attached.promise;
    const failure = new Error('Independent prepared physical retirement failure');
    if (kind === 'invalid-settings') {
      f.storage.getItem.mockResolvedValue('{}');
    } else {
      settings.state.paused = true;
      f.storage.getItem.mockResolvedValue(JSON.stringify(settings));
      f.close.mockRejectedValueOnce(failure);
    }
    const prepared = await f.activation.prepareSavedPause();
    if (!prepared) {
      throw new Error('Preparation lost its failure/retirement owner');
    }
    const outcome = prepared.complete().catch((error: unknown) => error);
    f.physicallyClosed.resolve();
    const error = await outcome;
    if (kind === 'invalid-settings') {
      expect(error).toMatchObject({
        errors: [await initial, new Error('Native index preferences have no state.')],
      });
      await expect(f.activation.acquireRead()).rejects.toThrow('closed');
    } else {
      expect(error).toMatchObject({ errors: [failure] });
      await expect(f.activation.acquireRead()).rejects.toBe(error);
    }
  }
);
