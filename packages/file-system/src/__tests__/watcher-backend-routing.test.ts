// BST-568 slice 2: explicit watcher-backend routing. Default stays legacy
// (chokidar / macOS native fs.watch); `BRAINSTRIKE_WATCHER_BACKEND=parcel`
// opts into the parcel engine; anything else throws — no silent coercion.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectoryHandle } from '../types';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
}));

const { startParcelWatchMock } = vi.hoisted(() => ({
  startParcelWatchMock: vi.fn((...args: unknown[]) => {
    void args;
    return Promise.resolve(() => undefined);
  }),
}));
vi.mock('../adapters/parcel-watchers', () => ({
  startParcelWatch: startParcelWatchMock,
}));

import { ElectronFileSystemAdapter, resolveWatcherBackend } from '../adapters/electron-adapter';

describe('resolveWatcherBackend', () => {
  it('defaults to legacy when unset or empty', () => {
    expect(resolveWatcherBackend({})).toBe('legacy');
    expect(resolveWatcherBackend({ BRAINSTRIKE_WATCHER_BACKEND: '' })).toBe('legacy');
  });

  it('honors explicit parcel and legacy values', () => {
    expect(resolveWatcherBackend({ BRAINSTRIKE_WATCHER_BACKEND: 'parcel' })).toBe('parcel');
    expect(resolveWatcherBackend({ BRAINSTRIKE_WATCHER_BACKEND: 'legacy' })).toBe('legacy');
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

  it('routes to the parcel engine when explicitly opted in', async () => {
    process.env['BRAINSTRIKE_WATCHER_BACKEND'] = 'parcel';
    const adapter = new ElectronFileSystemAdapter();
    const stop = adapter.watchDirectory(makeHandle(), vi.fn());
    await vi.waitFor(() => {
      expect(startParcelWatchMock).toHaveBeenCalledTimes(1);
    });
    stop();
  });

  it('does not touch the parcel engine on the default legacy path', () => {
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_WATCHER_BACKEND');
    const adapter = new ElectronFileSystemAdapter();
    const stop = adapter.watchDirectory(makeHandle(), vi.fn());
    expect(startParcelWatchMock).not.toHaveBeenCalled();
    stop();
  });

  it('forwards health to options.onHealth and derives shared signals for onSignal', async () => {
    process.env['BRAINSTRIKE_WATCHER_BACKEND'] = 'parcel';
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

  const itOnDarwin = process.platform === 'darwin' ? it : it.skip;
  itOnDarwin('synthesizes coarse legacy health on the darwin native path', () => {
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_WATCHER_BACKEND');
    const adapter = new ElectronFileSystemAdapter();
    const health: Array<{ backend: string; state: string }> = [];
    const stop = adapter.watchDirectory(makeHandle(), vi.fn(), undefined, {
      onHealth: (event) => health.push(event),
    });
    expect(health.map((event) => event.state)).toEqual(['starting', 'healthy']);
    expect(health[0]?.backend).toBe('legacy-fs-watch');
    stop();
    expect(health.map((event) => event.state)).toEqual(['starting', 'healthy', 'stopped']);
    stop();
    expect(health).toHaveLength(3);
  });

  it('throws synchronously on a malformed backend value', () => {
    process.env['BRAINSTRIKE_WATCHER_BACKEND'] = 'garbage';
    const adapter = new ElectronFileSystemAdapter();
    expect(() => adapter.watchDirectory(makeHandle(), vi.fn())).toThrow(
      /BRAINSTRIKE_WATCHER_BACKEND/
    );
  });
});
