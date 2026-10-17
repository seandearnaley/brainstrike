/**
 * Runtime-level lifecycle invariants for the renderer database (BST-1653).
 *
 * These are the invariants `db-provider-lifecycle.test.tsx` and
 * `factory-reset.test.tsx` could only reach through React mount/unmount:
 * BST-1329's drain-before-close ordering (idle join FIRST, then seal, then
 * unsubscribe), the abort path that must leave live handles alive, the
 * unmount-mid-initialization window, and BST-1330's desktop hard reset that
 * skips the local drain entirely. They run with NO React and NO PGlite — fake
 * transports only — so a wedge is reproducible in milliseconds instead of
 * behind a jsdom render.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createDatabaseRuntime,
  type DatabaseTransport,
  type DatabaseTransportClearContext,
  type DatabaseTransportKind,
  type DatabaseTransportOpenContext,
  type DbConnectionSnapshot,
} from '../src/database-runtime';
import {
  createDatabaseWorkScheduler,
  type DatabaseWorkScheduler,
} from '../src/database-work-scheduler';
import {
  createLiveQueryDrainRegistry,
  createResetBarrierDatabaseWork,
  type LiveQueryDrainRegistry,
  type ResetBarrierDatabaseWork,
} from '../src/db-reset-drain';

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** `vectorEnabled` is the observable marker that a snapshot was published. */
const CONNECTED_SNAPSHOT: DbConnectionSnapshot = {
  chunkRepository: null,
  drizzleDb: null,
  embeddingSetsRepository: null,
  exposedDb: null,
  fileRecordRepository: null,
  vectorEnabled: true,
  viewFilterPresetsRepository: null,
};

interface FakeTransportOptions {
  readonly available?: boolean;
  readonly clearAllData?: (context: DatabaseTransportClearContext) => Promise<{
    deletedChunks: number;
    deletedFiles: number;
  }>;
  readonly hardReset?: () => Promise<boolean>;
  readonly kind?: DatabaseTransportKind;
  /**
   * `markConnected` models the point the real direct transport registers its
   * connection — BEFORE `migrate()` runs. Calling it splits the two BST-1329
   * dispose windows apart: called ⇒ the runtime owns the close, not called ⇒
   * the transport must close what it built once it sees `isDisposed()`.
   */
  readonly open?: (
    context: DatabaseTransportOpenContext,
    markConnected: () => void
  ) => Promise<DbConnectionSnapshot | null>;
  /** `false` models a transport that owns no closable local connection (IPC). */
  readonly ownsConnection?: boolean;
  readonly purgeAndClose?: () => Promise<void>;
}

interface FakeTransport extends DatabaseTransport {
  readonly calls: string[];
  readonly closeConnection: ReturnType<typeof vi.fn>;
}

function createFakeTransport(calls: string[], options: FakeTransportOptions = {}): FakeTransport {
  const kind = options.kind ?? 'pglite-direct';
  const ownsConnection = options.ownsConnection ?? kind === 'pglite-direct';
  let connected = false;
  const closeConnection = vi.fn(async () => {
    calls.push(`${kind}:close`);
  });

  return {
    calls,
    cleanupAfterReset: async () => {
      calls.push(`${kind}:cleanupAfterReset`);
    },
    clearAllData: async (context) => {
      calls.push(`${kind}:clearAllData`);
      if (options.clearAllData) {
        return await options.clearAllData(context);
      }
      return { deletedChunks: 0, deletedFiles: 0 };
    },
    clearQueuesAndEmbeddingSets: async () => {
      calls.push(`${kind}:clearQueuesAndEmbeddingSets`);
    },
    closeConnection,
    detachConnection: () => {
      calls.push(`${kind}:detach`);
      if (!(connected && ownsConnection)) {
        return null;
      }
      connected = false;
      return closeConnection;
    },
    hardReset: async () => {
      calls.push(`${kind}:hardReset`);
      return options.hardReset ? await options.hardReset() : false;
    },
    hasOpenConnection: () => connected,
    isAvailable: () => options.available ?? true,
    kind,
    open: async (context) => {
      calls.push(`${kind}:open`);
      const markConnected = () => {
        connected = true;
      };
      if (!options.open) {
        markConnected();
        return await Promise.resolve(CONNECTED_SNAPSHOT);
      }
      const snapshot = await options.open(context, markConnected);
      if (!snapshot) {
        connected = false;
      }
      return snapshot;
    },
    purgeAndClose: async () => {
      calls.push(`${kind}:purgeAndClose`);
      if (options.purgeAndClose) {
        await options.purgeAndClose();
      }
      connected = false;
    },
  };
}

/** Wraps a real registry so seal/unseal/unsubscribeAll land in the order log. */
function createRecordingRegistry(calls: string[]): LiveQueryDrainRegistry {
  const inner = createLiveQueryDrainRegistry();
  return {
    register: (unsubscribe) => inner.register(unsubscribe),
    seal: () => {
      calls.push('registry:seal');
      inner.seal();
    },
    size: () => inner.size(),
    unseal: () => {
      calls.push('registry:unseal');
      inner.unseal();
    },
    unsubscribeAll: async () => {
      calls.push('registry:unsubscribeAll');
      await inner.unsubscribeAll();
    },
  };
}

function createHarness(
  options: {
    readonly registry?: LiveQueryDrainRegistry;
    readonly transports?: readonly DatabaseTransport[];
  } & FakeTransportOptions = {}
): {
  readonly calls: string[];
  readonly databaseWork: ResetBarrierDatabaseWork;
  readonly registry: LiveQueryDrainRegistry;
  readonly runtime: ReturnType<typeof createDatabaseRuntime>;
  readonly scheduler: DatabaseWorkScheduler;
  readonly transport: FakeTransport;
} {
  const calls: string[] = [];
  const transport = createFakeTransport(calls, options);
  const databaseWork = createResetBarrierDatabaseWork(createDatabaseWorkScheduler());
  const registry = options.registry ?? createRecordingRegistry(calls);
  const runtime = createDatabaseRuntime({
    databaseWork,
    liveQueryDrainRegistry: registry,
    transports: options.transports ?? [transport],
  });
  return {
    calls,
    databaseWork,
    registry,
    runtime,
    scheduler: databaseWork.scheduler,
    transport,
  };
}

describe('createDatabaseRuntime', () => {
  describe('state store', () => {
    it('hands useSyncExternalStore a CACHED snapshot that only changes on dispatch', async () => {
      const { runtime } = createHarness();

      const first = runtime.getState();
      expect(runtime.getState()).toBe(first);
      expect(first.initializationStatus).toBe('idle');
      expect(first.ready).toBe(false);

      const listener = vi.fn();
      const unsubscribe = runtime.subscribe(listener);
      runtime.start();

      expect(listener).toHaveBeenCalled();
      const afterStart = runtime.getState();
      expect(afterStart).not.toBe(first);
      expect(afterStart.ready).toBe(true);
      expect(runtime.getState()).toBe(afterStart);

      unsubscribe();
      await runtime.initialize();
      // Unsubscribed listeners stop receiving notifications.
      const callsAfterUnsubscribe = listener.mock.calls.length;
      await runtime.dispose();
      expect(listener.mock.calls.length).toBe(callsAfterUnsubscribe);
    });
  });

  describe('transport selection', () => {
    it('picks the first AVAILABLE transport (capability probe, never a platform check)', async () => {
      const calls: string[] = [];
      const electron = createFakeTransport(calls, {
        available: false,
        kind: 'electron-ipc',
        ownsConnection: false,
      });
      const direct = createFakeTransport(calls, { kind: 'pglite-direct' });
      const runtime = createDatabaseRuntime({ transports: [electron, direct] });

      await runtime.initialize();

      expect(calls).toContain('pglite-direct:open');
      expect(calls).not.toContain('electron-ipc:open');
    });

    it('throws instead of degrading when NO transport is available', async () => {
      const calls: string[] = [];
      const unavailable = createFakeTransport(calls, { available: false });
      const runtime = createDatabaseRuntime({ transports: [unavailable] });

      await runtime.initialize();

      expect(runtime.getState().initializationStatus).toBe('error');
      expect(runtime.getState().error?.message).toMatch(/no database transport/iu);
    });
  });

  describe('initialize', () => {
    it('moves idle -> initializing -> ready and publishes the connection snapshot', async () => {
      const opened = createDeferred();
      const { runtime } = createHarness({
        open: async () => {
          await opened.promise;
          return CONNECTED_SNAPSHOT;
        },
      });

      const initializing = runtime.initialize();
      expect(runtime.getState().initializationStatus).toBe('initializing');
      expect(runtime.getState().initializing).toBe(true);
      expect(runtime.getState().vectorEnabled).toBe(false);

      opened.resolve();
      await initializing;

      const state = runtime.getState();
      expect(state.initializationStatus).toBe('ready');
      expect(state.initializing).toBe(false);
      expect(state.lazyInitialized).toBe(true);
      expect(state.vectorEnabled).toBe(true);
      expect(state.ready).toBe(true);
    });

    it('shares ONE open across concurrent callers and does not reopen once ready', async () => {
      const { calls, runtime } = createHarness();

      await Promise.all([runtime.initialize(), runtime.initialize(), runtime.initialize()]);
      await runtime.initialize();

      expect(calls.filter((call) => call === 'pglite-direct:open')).toHaveLength(1);
    });

    it('surfaces an open failure into state instead of rejecting or degrading', async () => {
      const failure = new Error('pgvector extension failed to initialize.');
      const { runtime } = createHarness({
        open: async () => {
          await Promise.resolve();
          throw failure;
        },
      });

      await expect(runtime.initialize()).resolves.toBeUndefined();

      const state = runtime.getState();
      expect(state.initializationStatus).toBe('error');
      expect(state.error).toBe(failure);
      expect(state.lazyInitialized).toBe(false);
      expect(state.fileRecordRepository).toBeNull();
      expect(state.initializing).toBe(false);
    });
  });

  describe('factoryReset', () => {
    it('BST-1329: drains idle -> seal -> unsubscribe BEFORE purging and closing', async () => {
      const { calls, registry, runtime } = createHarness();
      await runtime.initialize();
      registry.register(async () => {
        calls.push('live:unsubscribe');
        await Promise.resolve();
      });
      calls.length = 0;

      await runtime.factoryReset();

      expect(calls).toEqual([
        'pglite-direct:hardReset',
        'registry:seal',
        'registry:unsubscribeAll',
        'live:unsubscribe',
        'pglite-direct:purgeAndClose',
        'pglite-direct:cleanupAfterReset',
      ]);
      expect(runtime.getState().initializationStatus).toBe('idle');
      expect(runtime.getState().vectorEnabled).toBe(false);
    });

    it('BST-1329: in-flight scheduled work holds the purge/close until it settles', async () => {
      const { calls, databaseWork, runtime } = createHarness();
      await runtime.initialize();
      calls.length = 0;

      const pending = createDeferred();
      const inFlight = databaseWork.scheduler.run(async () => await pending.promise, {
        label: 'pending work',
        priority: 'foreground',
      });

      let settled = false;
      const reset = runtime.factoryReset().finally(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
      expect(settled).toBe(false);
      expect(calls).not.toContain('pglite-direct:purgeAndClose');
      expect(calls).not.toContain('registry:seal');

      pending.resolve();
      await inFlight;
      await reset;
      expect(calls).toContain('pglite-direct:purgeAndClose');
    });

    it('BST-1329: an idle-join timeout ABORTS the reset, unseals, and closes nothing', async () => {
      vi.useFakeTimers();
      try {
        const { calls, databaseWork, registry, runtime } = createHarness();
        await runtime.initialize();
        registry.register(async () => {
          calls.push('live:unsubscribe');
          await Promise.resolve();
        });
        calls.length = 0;

        // Never settles: the scheduler can never reach idle.
        void databaseWork.scheduler.run(async () => await new Promise<void>(() => undefined), {
          label: 'never settles',
          priority: 'foreground',
        });

        let resetError: unknown;
        const reset = runtime.factoryReset().catch((error: unknown) => {
          resetError = error;
        });
        await vi.advanceTimersByTimeAsync(6000);
        await reset;

        expect(resetError).toBeInstanceOf(Error);
        expect((resetError as Error).message).toMatch(/did not become idle/u);
        expect(calls).toEqual(['pglite-direct:hardReset', 'registry:unseal']);
        expect(runtime.getState().vectorEnabled).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('BST-1330: a transport-owned hard reset skips the local drain, purge and close', async () => {
      const calls: string[] = [];
      const electron = createFakeTransport(calls, {
        hardReset: async () => await Promise.resolve(true),
        kind: 'electron-ipc',
        ownsConnection: false,
      });
      const runtime = createDatabaseRuntime({ transports: [electron] });
      await runtime.initialize();
      calls.length = 0;

      await runtime.factoryReset();

      expect(calls).toEqual(['electron-ipc:hardReset']);
    });

    it('propagates a hard-reset failure instead of falling through to the local purge', async () => {
      const calls: string[] = [];
      const electron = createFakeTransport(calls, {
        hardReset: async () => {
          await Promise.resolve();
          throw new Error('disk reset failed');
        },
        kind: 'electron-ipc',
        ownsConnection: false,
      });
      const runtime = createDatabaseRuntime({ transports: [electron] });
      await runtime.initialize();
      calls.length = 0;

      await expect(runtime.factoryReset()).rejects.toThrow('disk reset failed');
      expect(calls).toEqual(['electron-ipc:hardReset']);
    });

    it('skips the purge when no connection is open but still resets state', async () => {
      const { calls, runtime } = createHarness();
      calls.length = 0;

      await runtime.factoryReset();

      expect(calls).not.toContain('pglite-direct:purgeAndClose');
      expect(calls).toContain('pglite-direct:cleanupAfterReset');
    });

    it('propagates a purge failure and leaves the runtime retryable', async () => {
      const { runtime } = createHarness({
        purgeAndClose: async () => {
          await Promise.resolve();
          throw new Error('prompt reset storage failure');
        },
      });
      await runtime.initialize();

      await expect(runtime.factoryReset()).rejects.toThrow('prompt reset storage failure');
      // A second attempt must still be admitted (the barrier released).
      await expect(runtime.factoryReset()).rejects.toThrow('prompt reset storage failure');
    });
  });

  describe('dispose', () => {
    it('BST-1329: joins the in-flight initialize, drains, THEN closes', async () => {
      const opened = createDeferred();
      const { calls, runtime } = createHarness({
        open: async (_context, markConnected) => {
          // The real direct transport registers its connection BEFORE
          // `migrate()` runs; this is that window.
          markConnected();
          await opened.promise;
          return CONNECTED_SNAPSHOT;
        },
      });

      const initializing = runtime.initialize();
      calls.length = 0;
      const disposed = runtime.dispose();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
      expect(calls).not.toContain('pglite-direct:close');

      opened.resolve();
      await initializing;
      await disposed;

      expect(calls).toEqual([
        'pglite-direct:detach',
        'registry:seal',
        'registry:unsubscribeAll',
        'pglite-direct:close',
      ]);
    });

    it('BST-1329: tells an open() still in flight that the runtime is disposed', async () => {
      const opened = createDeferred();
      let disposedDuringOpen: boolean | null = null;
      const { runtime } = createHarness({
        open: async (context) => {
          await opened.promise;
          disposedDuringOpen = context.isDisposed();
          return null;
        },
      });

      const initializing = runtime.initialize();
      const disposed = runtime.dispose();
      opened.resolve();
      await initializing;
      await disposed;

      expect(disposedDuringOpen).toBe(true);
      expect(runtime.getState().initializationStatus).toBe('error');
    });

    it('a remount before the deferred teardown keeps the runtime, so the database still opens', async () => {
      // React StrictMode (every dev mount) cleans the provider's effect up and
      // sets it up again on the same runtime before anything else runs.
      const { calls, runtime } = createHarness({
        // Like the direct transport: a client built for a disposed runtime is
        // closed rather than installed.
        open: async (context, markConnected) => {
          if (context.isDisposed()) {
            return await Promise.resolve(null);
          }
          markConnected();
          return CONNECTED_SNAPSHOT;
        },
      });
      runtime.start();
      const disposed = runtime.dispose();
      runtime.start();
      await disposed;
      await runtime.initialize();

      expect(runtime.getState()).toMatchObject({
        initializationStatus: 'ready',
        vectorEnabled: true,
      });
      expect(calls).toEqual(['pglite-direct:open']);
    });

    it('a remount during an open keeps the client that open builds', async () => {
      const opened = createDeferred();
      let disposedDuringOpen: boolean | null = null;
      const { calls, runtime } = createHarness({
        open: async (context, markConnected) => {
          await opened.promise;
          disposedDuringOpen = context.isDisposed();
          markConnected();
          return CONNECTED_SNAPSHOT;
        },
      });

      const initializing = runtime.initialize();
      void runtime.dispose();
      runtime.start();
      opened.resolve();
      await initializing;

      expect(disposedDuringOpen).toBe(false);
      expect(runtime.getState()).toMatchObject({
        initializationStatus: 'ready',
        vectorEnabled: true,
      });
      expect(calls).toEqual(['pglite-direct:open']);
    });

    it('reports a runtime whose teardown ran instead of opening or claiming ready', async () => {
      const { calls, runtime } = createHarness();
      await runtime.dispose();
      runtime.start();
      await runtime.initialize();

      expect(runtime.getState().initializationStatus).toBe('error');
      expect(runtime.getState().error?.message).toMatch(/disposed/);
      expect(calls).not.toContain('pglite-direct:open');
    });

    it('skips the close when the drain never reaches idle', async () => {
      vi.useFakeTimers();
      try {
        const { calls, databaseWork, runtime } = createHarness();
        await runtime.initialize();
        calls.length = 0;
        void databaseWork.scheduler.run(async () => await new Promise<void>(() => undefined), {
          label: 'never settles',
          priority: 'foreground',
        });

        const disposed = runtime.dispose();
        await vi.advanceTimersByTimeAsync(6000);
        await disposed;

        expect(calls).toEqual(['pglite-direct:detach']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('detaches without closing when the transport owns no local connection', async () => {
      const calls: string[] = [];
      const electron = createFakeTransport(calls, {
        kind: 'electron-ipc',
        ownsConnection: false,
      });
      const runtime = createDatabaseRuntime({ transports: [electron] });
      await runtime.initialize();
      calls.length = 0;

      await runtime.dispose();

      expect(calls).toEqual(['electron-ipc:detach']);
    });

    it('is idempotent', async () => {
      const { calls, runtime } = createHarness();
      await runtime.initialize();
      calls.length = 0;

      await runtime.dispose();
      await runtime.dispose();

      expect(calls.filter((call) => call === 'pglite-direct:close')).toHaveLength(1);
    });
  });

  describe('clear paths', () => {
    it('initializes on demand and routes the clear to the active transport', async () => {
      const { calls, runtime } = createHarness();

      const result = await runtime.clearAllData();

      expect(result).toEqual({ deletedChunks: 0, deletedFiles: 0 });
      expect(calls).toEqual(['pglite-direct:open', 'pglite-direct:clearAllData']);
    });

    it('routes queue/embedding-set purges to the active transport', async () => {
      const { calls, runtime } = createHarness();
      await runtime.initialize();
      calls.length = 0;

      await runtime.clearQueuesAndEmbeddingSets();

      expect(calls).toEqual(['pglite-direct:clearQueuesAndEmbeddingSets']);
    });
  });
});
