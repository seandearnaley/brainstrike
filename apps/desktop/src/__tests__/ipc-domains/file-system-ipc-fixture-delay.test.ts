import type { DirectoryHandle } from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrustedInvokeEvent } from '../helpers/desktop-ipc-sender-test-helpers';

vi.mock('electron', async () => (await import('./file-system-ipc-test-harness')).electronMock);

import { registerFileSystemIpcHandlers } from '../../ipc-domains/file-system-ipc';
import {
  clearE2eFileSystemFixture,
  createFileSystem,
  createStorage,
  getRootsCatalog,
  handlers,
  removeHandler,
  resetRootsCatalog,
  setE2eFileSystemFixture,
} from './file-system-ipc-test-harness';

const ROOT_HANDLE = {
  id: 'fixture-root',
  kind: 'directory',
  name: 'fixture',
  path: '/fixture',
  type: 'directory',
} as DirectoryHandle & { id: string; type: 'directory' };

function registerFixture(overrides: Record<string, unknown> = {}): void {
  setE2eFileSystemFixture({
    directoriesByPath: { '/fixture': [] },
    fileContentsByPath: {},
    readDirectoryCalls: [],
    readFileByPathCalls: [],
    readFileCalls: [],
    requestDirectoryAccessCount: 0,
    rootHandle: ROOT_HANDLE,
    ...overrides,
  });
}

function readFixtureDirectory(): Promise<unknown> {
  return handlers.get('fs:readDirectory')?.(
    createTrustedInvokeEvent(),
    ROOT_HANDLE
  ) as Promise<unknown>;
}

/**
 * The E2E fixture's opt-in `directoryReadDelayMs`. It exists so cancellable
 * traversals (expand-all) stay cancellable long enough for a Playwright
 * round-trip to land — a memory-served fixture otherwise answers reads in
 * microseconds. See installWideExpandAllFixture in
 * apps/desktop/e2e/file-explorer-selection.shared.ts.
 */
describe('fs:readDirectory fixture read delay', () => {
  let fileSystem: ElectronFileSystemAdapter;
  let storage: ElectronStorageAdapter;

  beforeEach(() => {
    resetRootsCatalog();
    handlers.clear();
    removeHandler.mockClear();
    clearE2eFileSystemFixture();
    fileSystem = createFileSystem();
    storage = createStorage();
    registerFileSystemIpcHandlers({ fileSystem, getRootsCatalog, storage });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearE2eFileSystemFixture();
  });

  it('holds the read for the opted-in delay before serving fixture entries', async () => {
    registerFixture({ directoryReadDelayMs: 250 });
    vi.useFakeTimers();

    let resolved = false;
    const pending = readFixtureDirectory().then((entries) => {
      resolved = true;
      return entries;
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual([]);
  });

  it('serves reads immediately when no delay is opted in', async () => {
    registerFixture();
    // Fake timers with no advance: a resolved read here proves nothing waited on
    // a timer, so every other fixture in the suite stays as fast as it was.
    vi.useFakeTimers();

    await expect(readFixtureDirectory()).resolves.toEqual([]);
  });

  it('rejects the read when the opted-in delay is malformed', async () => {
    // No silent fallback: a coerced value would hand the E2E test back the
    // microsecond-wide cancel window this delay exists to widen, and it would
    // stay green locally until a loaded CI runner lost the race.
    for (const malformedDelay of ['250', -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      registerFixture({ directoryReadDelayMs: malformedDelay });

      await expect(readFixtureDirectory()).rejects.toThrow(
        'Invalid E2E fixture directoryReadDelayMs'
      );
    }

    expect(fileSystem.readDirectory).not.toHaveBeenCalled();
  });
});
