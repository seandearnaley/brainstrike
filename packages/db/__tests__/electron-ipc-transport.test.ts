// @vitest-environment node
/**
 * Desktop-transport reset contract, exercised through the REAL
 * `createElectronIpcTransport` rather than a fake (BST-1653).
 *
 * `database-runtime.test.ts` pins the runtime's orderings with fake
 * transports; nothing there proves the electron transport actually SATISFIES
 * the `DatabaseTransport` contract those orderings assume. The gap that
 * mattered: on desktop the main process owns the database, so the runtime's
 * local drain → purge → close leg can never reset it. Any path that lets
 * `factoryReset()` reach that leg with the electron transport selected
 * produces a reset that resolves having destroyed NOTHING — the caller then
 * reloads straight back into the same profile. `factory-reset.test.tsx`
 * already pins the sibling rule for a `resetLocal` that reports failure
 * ("surfaces desktop hard reset failure instead of falling back to direct
 * PGlite"); these cover the capability-probe half of it.
 *
 * The `node` pragma is load-bearing: `installBridge` stubs the WHOLE `window`, which
 * would strip the DOM under a jsdom default. Stating it here keeps the file's
 * assumption local rather than inherited from project config a future edit could change.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseRuntime, DatabaseTransport } from '../src/database-runtime';
import { createDatabaseRuntime } from '../src/database-runtime';
import { createElectronIpcTransport } from '../src/electron-ipc-transport';

/** The minimum bridge surface `open()` needs to publish a connection. */
function createBridge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exec: vi.fn(() => Promise.resolve(undefined)),
    query: vi.fn(() => Promise.resolve({ rows: [{ extname: 'vector' }] })),
    ...overrides,
  };
}

function installBridge(bridge: Record<string, unknown>): void {
  vi.stubGlobal('window', { electronAPI: { db: bridge } });
}

/**
 * A stand-in for `pglite-direct`: the terminal transport, always available, whose OWN
 * reset IS the runtime's local leg — hence `hardReset()` returning `false` here is
 * legitimate where it would be a lie for the desktop bridge.
 */
function createTerminalTransport(): DatabaseTransport & { readonly purged: () => number } {
  let purges = 0;
  return {
    cleanupAfterReset: () => Promise.resolve(),
    clearAllData: () => Promise.resolve({ cleared: true }) as never,
    clearQueuesAndEmbeddingSets: () => Promise.resolve(),
    detachConnection: () => null,
    hardReset: () => Promise.resolve(false),
    hasOpenConnection: () => true,
    isAvailable: () => true,
    kind: 'pglite-direct',
    open: () => Promise.resolve(null),
    purgeAndClose: () => {
      purges += 1;
      return Promise.resolve();
    },
    purged: () => purges,
  };
}

let activeRuntime: DatabaseRuntime | null = null;

function trackRuntime(runtime: DatabaseRuntime): DatabaseRuntime {
  activeRuntime = runtime;
  return runtime;
}

afterEach(async () => {
  // Runtimes install watchdog and drain machinery; leaving one running leaks it into
  // the next test — and test 1 leaves its runtime having just failed a reset with the
  // capability disabled, so any background probe of it fails too.
  await activeRuntime?.dispose();
  activeRuntime = null;
  vi.unstubAllGlobals();
});

describe('createElectronIpcTransport', () => {
  it('fails a reset LOUDLY when the capability disappears after transport selection', async () => {
    // The regression this guards: `hardReset()` used to `return false` when its
    // capability probe failed, which tells the runtime "run your own local
    // drain → purge → close instead". For a main-process-owned database that
    // sequence has nothing to purge, so `factoryReset()` resolved as a SUCCESS
    // that destroyed nothing. A capability that passed selection and then
    // vanished is a broken bridge, not a routing choice.
    const resetLocal = vi.fn(() => Promise.resolve({ success: true }));
    installBridge(createBridge({ resetLocal }));
    let enabled = true;
    const runtime = trackRuntime(
      createDatabaseRuntime({
        transports: [createElectronIpcTransport({ isEnabled: () => enabled })],
      })
    );
    runtime.start();
    await runtime.initialize();
    expect(runtime.getState().initializationStatus).toBe('ready');

    enabled = false;

    await expect(runtime.factoryReset()).rejects.toThrow(/became unavailable/);
    expect(resetLocal).not.toHaveBeenCalled();
  });

  it('fails a reset LOUDLY when the bridge exposes no resetLocal', async () => {
    installBridge(createBridge());
    const runtime = trackRuntime(
      createDatabaseRuntime({
        transports: [createElectronIpcTransport({ isEnabled: () => true })],
      })
    );
    runtime.start();
    await runtime.initialize();
    // Without this the rejection below could come from an uninitialized runtime rather
    // than from the missing-`resetLocal` branch the test names.
    expect(runtime.getState().initializationStatus).toBe('ready');

    await expect(runtime.factoryReset()).rejects.toThrow(/reset bridge is unavailable/);
  });

  it('hard-resets through the bridge and never runs the local purge leg', async () => {
    // The happy half. Every other case here is a failure, so an over-eager tightening
    // of the probe could make EVERY desktop reset throw and this file would stay green.
    const resetLocal = vi.fn(() => Promise.resolve({ success: true }));
    installBridge(createBridge({ resetLocal }));
    const runtime = trackRuntime(
      createDatabaseRuntime({
        transports: [createElectronIpcTransport({ isEnabled: () => true })],
      })
    );
    runtime.start();
    await runtime.initialize();
    expect(runtime.getState().initializationStatus).toBe('ready');

    await expect(runtime.factoryReset()).resolves.toBeUndefined();
    expect(resetLocal).toHaveBeenCalledTimes(1);
  });

  it('leaves a web reset to the terminal transport instead of throwing on a disabled bridge', async () => {
    // The one way this change could regress a shipping surface. `hardReset()` now
    // THROWS where it used to return false, and the safety argument for that is that
    // it is only ever called on the ALREADY-SELECTED transport. If the runtime instead
    // iterated the configured transports, every web factory reset — where the electron
    // entry is legitimately unavailable — would throw rather than fall through.
    installBridge(createBridge());
    const terminal = createTerminalTransport();
    const runtime = trackRuntime(
      createDatabaseRuntime({
        transports: [createElectronIpcTransport({ isEnabled: () => false }), terminal],
      })
    );
    runtime.start();
    await runtime.initialize();

    await expect(runtime.factoryReset()).resolves.toBeUndefined();
    expect(terminal.purged()).toBe(1);
  });

  it('tells the user an integrity error kept the database from opening and that nothing was replaced', async () => {
    // The host records the failure and stays alive, so diagnostics carry the real category
    // instead of the "pgvector extension is required" text a fresh, failure-free host produced.
    const message = 'index "idx_chunks_bm25" contains unexpected zero page at block 4';
    installBridge(
      createBridge({
        diagnostics: vi.fn(() =>
          Promise.resolve({
            lastInitializationFailure: {
              category: 'corruption',
              message,
              stage: 'open-database',
              timestamp: '2026-09-29T00:00:00.000Z',
            },
          })
        ),
        query: vi.fn(() => Promise.reject(new Error('Desktop database failed to initialize'))),
      })
    );
    const transport = createElectronIpcTransport({ isEnabled: () => true });

    await expect(transport.open()).rejects.toMatchObject({
      message: `Desktop database reported an integrity error and could not be opened. BrainStrike did not delete or replace it. Last failure: ${message}`,
    });
  });

  describe('when main stopped retrying after repeated init timeouts', () => {
    const initStop = {
      budgetMs: 372_000,
      consecutiveTimeouts: 2,
      hostPid: 4242,
      lastTimeoutAt: '2026-09-29T18:00:00.000Z',
      phaseKey: 'index-rebuild:public.idx_file_chunks_content_bm25',
      report: {
        index: {
          accessMethod: 'bm25',
          heapBytes: 137_363_456,
          index: 'idx_file_chunks_content_bm25',
          indexBytes: 33_685_504,
          schema: 'public',
          table: 'file_chunks',
          toastBytes: 221_249_536,
        },
        phase: 'index-rebuild',
      },
      version: 1,
    };
    const openWith = (diagnostics: Record<string, unknown>) => {
      installBridge(
        createBridge({
          diagnostics: vi.fn(() => Promise.resolve(diagnostics)),
          query: vi.fn(() => Promise.reject(new Error('Desktop database failed to initialize'))),
        })
      );
      return createElectronIpcTransport({ isEnabled: () => true }).open();
    };

    it('says so, and that nothing was deleted, instead of blaming the pgvector extension', async () => {
      // Main answers diagnostics from its own record and forks no host, so the snapshot carries
      // no failure: the stop must be read first or the person is told the wrong thing.
      await expect(openWith({ initStop, lastInitializationFailure: null })).rejects.toMatchObject({
        message:
          'BrainStrike stopped retrying the database start: rebuilding the search index timed out twice (last budget 372 s). Nothing was deleted or replaced.',
      });
    });

    it('reads the stop before any recorded failure', async () => {
      await expect(
        openWith({
          initStop,
          lastInitializationFailure: {
            category: 'corruption',
            message: 'boom',
            stage: 'open-database',
          },
        })
      ).rejects.toMatchObject({ message: expect.stringContaining('stopped retrying') });
    });

    it('names a timeout before the first phase report by what was starting', async () => {
      await expect(
        openWith({
          initStop: { ...initStop, budgetMs: 90_000, phaseKey: 'init:first-report', report: null },
        })
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          'starting the database process timed out twice (last budget 90 s)'
        ),
      });
    });

    it('names a phase this renderer does not know generically, never as "undefined"', async () => {
      // Main and renderer can be out of sync, and the IPC payload is not validated.
      const unknownPhase = { ...initStop, report: { phase: 'defragment' } };

      const error = await openWith({ initStop: unknownPhase }).then(
        () => null,
        (rejection: unknown) => rejection as Error
      );

      expect(error?.message).not.toContain('undefined');
      expect(error?.message).toContain(
        'a step of starting the database timed out twice (last budget 372 s)'
      );
    });

    it('leaves the other messages alone when there is no stop', async () => {
      await expect(
        openWith({ initStop: null, lastInitializationFailure: null })
      ).rejects.toMatchObject({
        message: expect.stringContaining('pgvector extension is required for desktop'),
      });
    });
  });

  it('rejects purgeAndClose rather than reporting a purge the renderer cannot perform', async () => {
    // Unreachable through the runtime now that `hardReset()` throws instead of
    // returning false — kept as the assertion that keeps it unreachable.
    installBridge(createBridge());
    const transport = createElectronIpcTransport({ isEnabled: () => true });

    await expect(transport.purgeAndClose()).rejects.toThrow(/main process owns it/);
  });
});
