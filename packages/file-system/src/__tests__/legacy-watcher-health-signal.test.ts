// BST-568 slice 3 (review follow-up): the LEGACY engines must derive the
// shared FileSystemWatchSignal channel (#1764) from their coarse health
// transitions, exactly like the parcel engine does. The legacy seam originally
// wired its emitter to the RAW `options.onHealth`, bypassing the wrapper that
// performs the translation — so a main-process caller that passed only
// `onSignal` never learned that a legacy watch had died.
//
// Platform-adaptive by design: darwin takes the native fs.watch branch and
// everything else takes the chokidar branch, but BOTH terminate at
// `legacyHealth.fail(...)`, so the assertion is identical. This keeps the
// regression pinned on macOS dev machines AND on Linux CI rather than being
// skipped on one of them.
//
// Removed together with the legacy engines in slice 4.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectoryHandle, FileSystemWatchSignal } from '../types';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
}));

const SETUP_FAILURE = 'legacy engine refused to start';

const { handleWatcherSetupErrorMock, startChokidarWatchMock, startFsWatchMock } = vi.hoisted(
  () => ({
    handleWatcherSetupErrorMock: vi.fn(() => {
      // The fs.watch fallback also fails — this is what drives the adapter into
      // legacyHealth.fail() on the non-darwin branch.
      throw new Error(SETUP_FAILURE);
    }),
    startChokidarWatchMock: vi.fn(() => Promise.reject(new Error(SETUP_FAILURE))),
    startFsWatchMock: vi.fn(() => {
      throw new Error(SETUP_FAILURE);
    }),
  })
);

vi.mock('../adapters/electron-watchers', () => ({
  createFileSystemChangeBatcher: vi.fn(),
  handleWatcherSetupError: handleWatcherSetupErrorMock,
  startChokidarWatch: startChokidarWatchMock,
  startFsWatch: startFsWatchMock,
}));

import { ElectronFileSystemAdapter } from '../adapters/electron-adapter';

describe('legacy watcher health -> FileSystemWatchSignal derivation', () => {
  let tempDir = '';
  const originalEnv = process.env['BRAINSTRIKE_WATCHER_BACKEND'];

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-health-')));
    // Legacy is the default, but be explicit so the test does not silently
    // start passing for the wrong reason if the default ever flips.
    process.env['BRAINSTRIKE_WATCHER_BACKEND'] = 'legacy';
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      Reflect.deleteProperty(process.env, 'BRAINSTRIKE_WATCHER_BACKEND');
    } else {
      process.env['BRAINSTRIKE_WATCHER_BACKEND'] = originalEnv;
    }
    fs.rmSync(tempDir, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  function makeHandle(): DirectoryHandle {
    return {
      kind: 'directory',
      name: path.basename(tempDir),
      path: tempDir,
      platform: 'electron',
    };
  }

  it('emits an errored signal when a legacy watch fails to start', async () => {
    const adapter = new ElectronFileSystemAdapter();
    const signals: FileSystemWatchSignal[] = [];

    // onSignal ONLY — no options.onHealth. This is the case the raw wiring
    // dropped on the floor.
    if (process.platform === 'darwin') {
      expect(() =>
        adapter.watchDirectory(makeHandle(), vi.fn(), (signal) => signals.push(signal))
      ).toThrow(SETUP_FAILURE);
    } else {
      adapter.watchDirectory(makeHandle(), vi.fn(), (signal) => signals.push(signal));
      // The chokidar branch resolves its failure asynchronously.
      await vi.waitFor(() => expect(signals.length).toBeGreaterThan(0));
    }

    expect(signals).toEqual([{ message: SETUP_FAILURE, type: 'errored' }]);
  });

  it('still forwards the richer onHealth transitions alongside the signal', async () => {
    const adapter = new ElectronFileSystemAdapter();
    const signals: FileSystemWatchSignal[] = [];
    const health: string[] = [];

    const start = (): void => {
      adapter.watchDirectory(makeHandle(), vi.fn(), (signal) => signals.push(signal), {
        onHealth: (event) => health.push(event.state),
      });
    };

    if (process.platform === 'darwin') {
      expect(start).toThrow(SETUP_FAILURE);
    } else {
      start();
      await vi.waitFor(() => expect(signals.length).toBeGreaterThan(0));
    }

    // No double-dispatch: the wrapper calls options.onHealth exactly once per
    // transition, and derives the signal from the same transition.
    expect(health).toEqual(['starting', 'failed']);
    expect(signals).toEqual([{ message: SETUP_FAILURE, type: 'errored' }]);
  });
});
