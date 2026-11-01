// @vitest-environment node
import type {
  CanonicalWorkspaceLease,
  CanonicalWorkspaceRuntimeDependencies,
} from '@brainstrike/canonical-ingestion';
import type { ScopedIndexerPort } from '@brainstrike/indexer';
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import type { NativeIndexSettings } from '../native-index-settings';
import { createNativeRootDataDeletion } from '../native-root-data-deletion';
import { createNativeRootRegistration } from '../native-root-registration';
import { textSettings, unreadableSettings } from './helpers/native-index-settings';
import { restoredRoots } from './helpers/restored-roots';
import {
  fixture,
  mocks,
  requestedScope,
  resetActivationFixture,
  setCatalogRoot,
  storeId,
  unused,
  writer,
} from './native-index-activation-fixture';

beforeEach(resetActivationFixture);

it.each(['acquire', 'acquireRead'] as const)(
  'captures the initial saved-settings read before %s returns',
  async (method) => {
    const f = fixture();
    f.settings.mockResolvedValue(textSettings({ paused: true }));
    const acquired = f.activation[method]();
    onTestFinished(async () => {
      await acquired.catch(() => undefined);
      await f.activation.close();
    });
    expect(f.settings).toHaveBeenCalledOnce();
    await expect(acquired).resolves.toBeDefined();
  }
);

it('concurrent acquire and acquireRead share the first captured startup input', async () => {
  const f = fixture();
  const captured = textSettings({ paused: true });
  const held = Promise.withResolvers<NativeIndexSettings>();
  f.settings.mockReturnValueOnce(held.promise);
  const strict = f.activation.acquire();
  f.settings.mockResolvedValue(textSettings({ paused: true, policy: 'full-root' }));
  const reader = f.activation.acquireRead();
  onTestFinished(async () => {
    held.resolve(captured);
    await Promise.allSettled([strict, reader]);
    await f.activation.close();
  });
  held.resolve(captured);
  await expect(strict).resolves.toBeDefined();
  await expect(reader).resolves.toBeDefined();
  expect(mocks.acquire).toHaveBeenCalledOnce();
  expect(mocks.close).not.toHaveBeenCalled();
});

it('a terminal command supersedes captured startup input before it can open', async () => {
  const f = fixture();
  const captured = textSettings();
  const held = Promise.withResolvers<NativeIndexSettings>();
  f.settings.mockReturnValueOnce(held.promise);
  const initial = f.activation.acquire().catch((error: unknown) => error);
  expect(f.settings).toHaveBeenCalledOnce();
  const closing = f.activation.close();
  onTestFinished(async () => {
    held.resolve(captured);
    await Promise.allSettled([initial, closing]);
  });
  held.resolve(captured);
  expect(await initial).toBeInstanceOf(Error);
  await closing;
  expect(mocks.acquire).not.toHaveBeenCalled();
  await expect(f.activation.acquireRead()).rejects.toBeInstanceOf(Error);
});

it('preserves a synchronously captured settings failure through asynchronous construction', async () => {
  const f = fixture();
  const failure = unreadableSettings();
  f.settings.mockRejectedValue(failure);
  const initial = f.activation.acquire();
  onTestFinished(() => f.activation.close());
  await expect(initial).rejects.toBe(failure);
  expect(mocks.acquire).not.toHaveBeenCalled();
});

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
    roots: restoredRoots({
      borrowSourceRoot: async () => lease,
      restoreRoots: async () => [{ permissionState: 'granted', rootId: 'root' }],
    }),
    watches: { subscribe: unused },
  } as unknown as ApplicationIpcDomain;
  setCatalogRoot();
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
  const f = fixture(application);
  return { ...f, application, attached, close, physicallyClosed };
}

it.each(['reconfigure', 'invalid-settings', 'terminal'] as const)(
  'cancels the held source receipt at graph invalidation before joining %s',
  async (operation) => {
    const f = heldWorkspace();
    f.settings.mockResolvedValue(textSettings({ paused: true }));
    await f.activation.acquire();
    f.settings.mockResolvedValue(textSettings());
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
    const unreadable = unreadableSettings();
    if (operation === 'invalid-settings') {
      f.settings.mockRejectedValue(unreadable);
    }
    if (operation === 'reconfigure') {
      f.settings.mockResolvedValue(textSettings({ policy: 'full-root' }));
    }
    next = Promise.resolve(
      operation === 'terminal' ? f.activation.fenceTerminal() : f.activation.reconfigure()
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(initialSettled).toBe(true));
    if (operation === 'invalid-settings') {
      expect(await initial).toBe(unreadable);
    } else {
      expect(await initial).toMatchObject({ code: 'native-index-transitioning' });
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
  f.settings.mockResolvedValue(textSettings({ paused: true }));
  await f.activation.acquire();
  f.settings.mockResolvedValue(textSettings());
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
  f.settings.mockResolvedValue(textSettings({ policy: 'full-root' }));
  replacing = f.activation.reconfigure().catch((error: unknown) => error);
  await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
  expect(await initial).toMatchObject({ code: 'native-index-transitioning' });
  expect(await replacing).toMatchObject({ errors: [failure] });
  expect(mocks.closeProfile).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
});

it('starts saved Pause cancellation while root registration owns an incomplete first receipt', async () => {
  const f = heldWorkspace();
  f.settings.mockResolvedValue(textSettings({ paused: true }));
  const reader = await f.activation.acquire();
  const captured = f.activation.captureAcknowledgedAuthority();
  const transitions = createNativeRootDataDeletion({
    acquire: unused,
    captureOwner: unused,
    closeOwner: unused,
    deleteRootData: unused,
    resume: unused,
    stopSources: unused,
  });
  const registration = createNativeRootRegistration({
    isShuttingDown: () => false,
    reconfigureRoots: () => f.activation.reconfigureRoots(),
    reportError: vi.fn(),
    transition: transitions.transition,
  });
  f.settings.mockResolvedValue(textSettings());
  const registered = registration.rootsRegistered().catch((error: unknown) => error);
  let paused: Promise<unknown> | undefined;
  onTestFinished(async () => {
    f.physicallyClosed.resolve();
    await f.activation.close();
    await Promise.allSettled([registered, paused]);
  });
  await f.attached.promise;
  f.settings.mockResolvedValue(textSettings({ paused: true }));
  // Main's config owner applies a saved change through this FIFO, so the entire
  // reconfiguration waits behind the registration's first-receipt join.
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
    if (phase === 'settings') {
      f.settings.mockReturnValueOnce(gate.promise.then(() => textSettings()));
    }
    if (phase === 'graph') {
      // The index's sync with the host's folders is held.
      const borrowLive = f.application.roots.borrowLiveRoots.bind(f.application.roots);
      f.application.roots.borrowLiveRoots = async (work) => {
        await gate.promise;
        return borrowLive(work);
      };
    }
    const initial = f.activation.acquire().catch((error: unknown) => error);
    if (phase === 'attachment') {
      await f.attached.promise;
    }
    f.settings.mockResolvedValue(textSettings({ paused: true }));
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
    f.settings.mockResolvedValue(textSettings({ paused: true }));
    await f.activation.acquire();
    f.settings.mockResolvedValue(textSettings());
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
      f.settings.mockRejectedValue(unreadableSettings());
    } else {
      f.settings.mockResolvedValue(textSettings({ paused: true }));
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
      expect(error).toBe(await initial);
      await expect(f.activation.acquireRead()).rejects.toMatchObject({
        cause: error,
        refusal: { kind: 'settings-invalid' },
      });
    } else {
      expect(error).toMatchObject({ errors: [failure] });
      await expect(f.activation.acquireRead()).rejects.toMatchObject({
        cause: error,
        refusal: { kind: 'source-failure' },
      });
    }
  }
);
