// BST-568 slice 4: the parcel engine IS the watcher service. Default is
// parcel on every platform; the legacy engines (chokidar / recursive
// fs.watch) are removed, and `BRAINSTRIKE_WATCHER_BACKEND=legacy` fails
// loudly instead of silently resurrecting them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectoryHandle } from '../types';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
}));

const { startParcelWatchMock } = vi.hoisted(() => ({
  startParcelWatchMock: vi.fn((...args: unknown[]): Promise<() => void> => {
    void args;
    return Promise.resolve(() => undefined);
  }),
}));
vi.mock('../adapters/parcel-watchers', () => ({
  startParcelWatch: startParcelWatchMock,
}));

import { ElectronFileSystemAdapter, resolveWatcherBackend } from '../adapters/electron-adapter';

describe('resolveWatcherBackend', () => {
  it('defaults to parcel when unset or empty', () => {
    expect(resolveWatcherBackend({})).toBe('parcel');
    expect(resolveWatcherBackend({ BRAINSTRIKE_WATCHER_BACKEND: '' })).toBe('parcel');
  });

  it('honors the explicit parcel value', () => {
    expect(resolveWatcherBackend({ BRAINSTRIKE_WATCHER_BACKEND: 'parcel' })).toBe('parcel');
  });

  it('rejects legacy loudly now that the legacy engines are removed', () => {
    expect(() => resolveWatcherBackend({ BRAINSTRIKE_WATCHER_BACKEND: 'legacy' })).toThrow(
      /legacy.*removed|removed.*legacy/i
    );
  });

  it('throws on any other value instead of coercing', () => {
    expect(() => resolveWatcherBackend({ BRAINSTRIKE_WATCHER_BACKEND: 'chokidar' })).toThrow(
      /BRAINSTRIKE_WATCHER_BACKEND/
    );
  });
});

describe('watchDirectory backend routing', () => {
  let tempDir = '';
  const originalEnv = process.env['BRAINSTRIKE_WATCHER_BACKEND'];

  beforeEach(() => {
    startParcelWatchMock.mockClear();
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'routing-')));
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      // NOT `= undefined`: Node coerces that to the string "undefined".
      Reflect.deleteProperty(process.env, 'BRAINSTRIKE_WATCHER_BACKEND');
    } else {
      process.env['BRAINSTRIKE_WATCHER_BACKEND'] = originalEnv;
    }
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  function makeHandle(): DirectoryHandle {
    return {
      kind: 'directory',
      name: 'root',
      path: tempDir,
    } as DirectoryHandle;
  }

  it('routes to the parcel engine by default (no env var)', async () => {
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_WATCHER_BACKEND');
    const adapter = new ElectronFileSystemAdapter();
    const stop = adapter.watchDirectory(makeHandle(), vi.fn());
    await vi.waitFor(() => {
      expect(startParcelWatchMock).toHaveBeenCalledTimes(1);
    });
    stop();
  });

  it('forwards health to options.onHealth and derives shared signals for onSignal', async () => {
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_WATCHER_BACKEND');
    const adapter = new ElectronFileSystemAdapter();
    const onHealth = vi.fn();
    const onSignal = vi.fn();
    const stop = adapter.watchDirectory(makeHandle(), vi.fn(), onSignal, { onHealth });
    await vi.waitFor(() => {
      expect(startParcelWatchMock).toHaveBeenCalledTimes(1);
    });
    const options = startParcelWatchMock.mock.calls[0]?.[2] as
      | { onHealth?: (event: unknown) => void }
      | undefined;
    expect(typeof options?.onHealth).toBe('function');

    // The adapter's wrapped sink forwards transitions AND translates them
    // into the shared FileSystemWatchSignal channel (#1764).
    options?.onHealth?.({ backend: 'fs-events', state: 'degraded', timestamp: 1 });
    expect(onHealth).toHaveBeenCalledWith(expect.objectContaining({ state: 'degraded' }));
    expect(onSignal).toHaveBeenCalledWith({ type: 'overflow' });

    options?.onHealth?.({
      backend: 'fs-events',
      failure: { code: 'x', message: 'boom', retryable: true, terminal: false },
      state: 'failed',
      timestamp: 2,
    });
    expect(onSignal).toHaveBeenCalledWith({ message: 'boom', type: 'errored' });
    stop();
  });

  it('dispose before async engine start still stops the engine on arrival', async () => {
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_WATCHER_BACKEND');
    const engineStop = vi.fn();
    const engine: { resolve: ((stop: () => void) => void) | null } = {
      resolve: null,
    };
    startParcelWatchMock.mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          engine.resolve = resolve;
        })
    );
    const adapter = new ElectronFileSystemAdapter();
    const stop = adapter.watchDirectory(makeHandle(), vi.fn());
    stop();
    engine.resolve?.(engineStop);
    await vi.waitFor(() => {
      expect(engineStop).toHaveBeenCalledTimes(1);
    });
  });

  it('throws synchronously on a malformed backend value', () => {
    process.env['BRAINSTRIKE_WATCHER_BACKEND'] = 'garbage';
    const adapter = new ElectronFileSystemAdapter();
    expect(() => adapter.watchDirectory(makeHandle(), vi.fn())).toThrow(
      /BRAINSTRIKE_WATCHER_BACKEND/
    );
  });
});
