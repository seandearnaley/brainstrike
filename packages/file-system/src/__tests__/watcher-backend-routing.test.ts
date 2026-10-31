// The electron adapter's watchDirectory routes every watch through the one
// root watch engine (./root-watchers.ts) and derives the shared signals.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DirectoryHandle } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronFileSystemAdapter } from '../adapters/electron-adapter.js';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
}));

const { startRootWatchMock } = vi.hoisted(() => ({
  startRootWatchMock: vi.fn((...args: unknown[]): Promise<() => void> => {
    void args;
    return Promise.resolve(() => undefined);
  }),
}));
vi.mock('../adapters/root-watchers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/root-watchers.js')>();
  return {
    ...actual,
    startRootWatch: startRootWatchMock,
  };
});

describe('watchDirectory backend routing', () => {
  let tempDir = '';

  beforeEach(() => {
    startRootWatchMock.mockClear();
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'routing-')));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  function makeHandle(): DirectoryHandle {
    return {
      kind: 'directory',
      name: 'root',
      path: tempDir,
    } as DirectoryHandle;
  }

  it('routes every watch to the root watch engine', async () => {
    const adapter = new ElectronFileSystemAdapter();
    const stop = adapter.watchDirectory(makeHandle(), vi.fn());
    await vi.waitFor(() => {
      expect(startRootWatchMock).toHaveBeenCalledTimes(1);
    });
    stop();
  });

  it('forwards health to options.onHealth and derives shared signals for onSignal', async () => {
    const adapter = new ElectronFileSystemAdapter();
    const onHealth = vi.fn();
    const onSignal = vi.fn();
    const stop = adapter.watchDirectory(makeHandle(), vi.fn(), onSignal, { onHealth });
    await vi.waitFor(() => {
      expect(startRootWatchMock).toHaveBeenCalledTimes(1);
    });
    const options = startRootWatchMock.mock.calls[0]?.[2] as
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

  it('forwards the concrete filtered-change reporting option to the root watch engine', async () => {
    const adapter = new ElectronFileSystemAdapter();
    const stop = adapter.watchDirectory(makeHandle(), vi.fn(), undefined, {
      reportDefaultFilteredChanges: true,
    });
    await vi.waitFor(() => {
      expect(startRootWatchMock).toHaveBeenCalledTimes(1);
    });
    expect(startRootWatchMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ reportDefaultFilteredChanges: true })
    );
    stop();
  });

  it('keeps explicit git-metadata ignores marker-free by default', async () => {
    const adapter = new ElectronFileSystemAdapter();
    const stop = adapter.watchDirectory(makeHandle(), vi.fn(), undefined, { ignorePatterns: [] });
    await vi.waitFor(() => {
      expect(startRootWatchMock).toHaveBeenCalledTimes(1);
    });
    expect(startRootWatchMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        ignorePatterns: [],
        reportDefaultFilteredChanges: false,
      })
    );
    stop();
  });

  it('rejects an ambiguous filtered-reporting override before starting the engine', () => {
    const adapter = new ElectronFileSystemAdapter();

    expect(() =>
      adapter.watchDirectory(makeHandle(), vi.fn(), undefined, {
        ignorePatterns: [],
        reportDefaultFilteredChanges: true,
      })
    ).toThrow(
      /reportDefaultFilteredChanges.*ignorePatterns|ignorePatterns.*reportDefaultFilteredChanges/u
    );
    expect(startRootWatchMock).not.toHaveBeenCalled();
  });

  it('dispose before async engine start still stops the engine on arrival', async () => {
    const engineStop = vi.fn();
    const engine: { resolve: ((stop: () => void) => void) | null } = {
      resolve: null,
    };
    startRootWatchMock.mockImplementationOnce(
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
});
