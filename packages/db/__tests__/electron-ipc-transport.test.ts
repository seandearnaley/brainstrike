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
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
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
    const runtime = createDatabaseRuntime({
      transports: [createElectronIpcTransport({ isEnabled: () => enabled })],
    });
    runtime.start();
    await runtime.initialize();
    expect(runtime.getState().initializationStatus).toBe('ready');

    enabled = false;

    await expect(runtime.factoryReset()).rejects.toThrow(/became unavailable/);
    expect(resetLocal).not.toHaveBeenCalled();
  });

  it('fails a reset LOUDLY when the bridge exposes no resetLocal', async () => {
    installBridge(createBridge());
    const runtime = createDatabaseRuntime({
      transports: [createElectronIpcTransport({ isEnabled: () => true })],
    });
    runtime.start();
    await runtime.initialize();

    await expect(runtime.factoryReset()).rejects.toThrow(
      'Electron database reset bridge is unavailable.'
    );
  });

  it('rejects purgeAndClose rather than reporting a purge the renderer cannot perform', async () => {
    // Unreachable through the runtime now that `hardReset()` throws instead of
    // returning false — kept as the assertion that keeps it unreachable.
    installBridge(createBridge());
    const transport = createElectronIpcTransport({ isEnabled: () => true });

    await expect(transport.purgeAndClose()).rejects.toThrow(/main process owns it/);
  });
});
