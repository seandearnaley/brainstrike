/**
 * Coverage for the file-system watch IPC domain (fs:watch / fs:unwatch /
 * fs:watch-event). The watcher factory is an injected fake — chokidar wiring
 * lives in `@brainstrike/file-system/electron` and is covered by
 * `packages/file-system/src/__tests__/electron-watchers.test.ts`. Path
 * validation runs against REAL temp dirs (same posture as the notes-vault IPC
 * tests): containment/realpath behavior is filesystem behavior, never mocked.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FileSystemChange } from '@brainstrike/types';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const { registeredHandlers, removeHandler } = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    registeredHandlers: handlers,
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, listener: IpcHandler) => {
      registeredHandlers.set(channel, listener);
    }),
    on: vi.fn(),
    removeHandler,
    removeListener: vi.fn(),
  },
}));

import {
  disposeAllFileSystemWatchers,
  type FileSystemWatchEventPayload,
  liveFileSystemWatcherCountForTest,
  registerFileSystemWatchIpcHandlers,
} from '../../ipc-domains/file-system-watch-ipc';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

const createdDirs: string[] = [];

async function makeDir(prefix = 'brainstrike-fs-watch-ipc-'): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  const real = await fsPromises.realpath(dir);
  createdDirs.push(real);
  return real;
}

function toDirectoryHandle(directoryPath: string) {
  return {
    kind: 'directory' as const,
    name: path.basename(directoryPath),
    path: directoryPath,
    platform: 'electron' as const,
  };
}

/** A minimal WebContents stand-in recording the watch events pushed to it. */
class FakeWebContents {
  readonly id: number;
  readonly watchEvents: FileSystemWatchEventPayload[] = [];
  private destroyed = false;
  private destroyedListeners: (() => void)[] = [];

  constructor(id: number) {
    this.id = id;
  }

  send(channel: string, payload: unknown): void {
    if (channel === DESKTOP_IPC_CHANNELS.files.watchEvent) {
      this.watchEvents.push(payload as FileSystemWatchEventPayload);
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  once(event: string, listener: () => void): void {
    if (event === 'destroyed') {
      this.destroyedListeners.push(listener);
    }
  }

  /** Test helper: simulate the renderer being destroyed. */
  fireDestroyed(): void {
    this.destroyed = true;
    const listeners = this.destroyedListeners;
    this.destroyedListeners = [];
    for (const listener of listeners) {
      listener();
    }
  }
}

function invokeEventFor(owner: FakeWebContents): IpcMainInvokeEvent {
  return { sender: owner as unknown as WebContents } as IpcMainInvokeEvent;
}

interface WatchHarness {
  /** Fire every live fake watcher with the given changes. */
  fireAllChanges: (changes: FileSystemChange[]) => void;
  startedPaths: string[];
  startWatch: (
    directoryPath: string,
    onChanges: (changes: FileSystemChange[]) => void
  ) => () => void;
  stops: ReturnType<typeof vi.fn>[];
}

function createWatchHarness(): WatchHarness {
  const startedPaths: string[] = [];
  const stops: ReturnType<typeof vi.fn>[] = [];
  const liveCallbacks = new Set<(changes: FileSystemChange[]) => void>();
  return {
    fireAllChanges: (changes) => {
      for (const callback of Array.from(liveCallbacks)) {
        callback(changes);
      }
    },
    startedPaths,
    startWatch: (directoryPath, onChanges) => {
      startedPaths.push(directoryPath);
      liveCallbacks.add(onChanges);
      const stop = vi.fn(() => {
        liveCallbacks.delete(onChanges);
      });
      stops.push(stop);
      return stop;
    },
    stops,
  };
}

async function invokeWatch(
  owner: FakeWebContents,
  directoryPath: string
): Promise<{ watchId: string }> {
  const handler = registeredHandlers.get(DESKTOP_IPC_CHANNELS.files.watch);
  if (!handler) {
    throw new Error('fs:watch handler is not registered');
  }
  return (await handler(invokeEventFor(owner), toDirectoryHandle(directoryPath))) as {
    watchId: string;
  };
}

async function invokeUnwatch(owner: FakeWebContents, watchId: string): Promise<void> {
  const handler = registeredHandlers.get(DESKTOP_IPC_CHANNELS.files.unwatch);
  if (!handler) {
    throw new Error('fs:unwatch handler is not registered');
  }
  await handler(invokeEventFor(owner), watchId);
}

const SAMPLE_CHANGES: FileSystemChange[] = [
  { kind: 'file', path: '/tmp/some/file.ts', type: 'added' },
];

describe('file-system watch IPC domain', () => {
  let harness: WatchHarness;
  let unregister: () => void;

  beforeEach(() => {
    registeredHandlers.clear();
    vi.clearAllMocks();
    harness = createWatchHarness();
    unregister = registerFileSystemWatchIpcHandlers({ startWatch: harness.startWatch });
  });

  afterEach(async () => {
    disposeAllFileSystemWatchers();
    unregister();
    await Promise.all(
      createdDirs.splice(0).map((dir) => fsPromises.rm(dir, { force: true, recursive: true }))
    );
  });

  it('starts a watcher for the handle path and returns a unique watchId', async () => {
    const owner = new FakeWebContents(1);
    const dir = await makeDir();

    const first = await invokeWatch(owner, dir);
    const second = await invokeWatch(owner, dir);

    expect(first.watchId).toBeTruthy();
    expect(second.watchId).toBeTruthy();
    expect(first.watchId).not.toBe(second.watchId);
    expect(harness.startedPaths).toEqual([dir, dir]);
    expect(liveFileSystemWatcherCountForTest()).toBe(2);
  });

  it('pushes watcher changes to the owning renderer only, stamped with the watchId', async () => {
    const ownerA = new FakeWebContents(1);
    const ownerB = new FakeWebContents(2);
    const dirA = await makeDir();
    const dirB = await makeDir();

    const { watchId: watchA } = await invokeWatch(ownerA, dirA);
    const { watchId: watchB } = await invokeWatch(ownerB, dirB);

    harness.fireAllChanges(SAMPLE_CHANGES);

    expect(ownerA.watchEvents).toEqual([{ changes: SAMPLE_CHANGES, watchId: watchA }]);
    expect(ownerB.watchEvents).toEqual([{ changes: SAMPLE_CHANGES, watchId: watchB }]);
  });

  it('rejects a non-directory path instead of silently watching nothing', async () => {
    const owner = new FakeWebContents(1);
    const dir = await makeDir();
    const filePath = path.join(dir, 'file.txt');
    await fsPromises.writeFile(filePath, 'x');

    await expect(invokeWatch(owner, filePath)).rejects.toThrow(/not a directory/i);
    expect(harness.startedPaths).toEqual([]);
    expect(liveFileSystemWatcherCountForTest()).toBe(0);
  });

  it('registers a no-op watcher for e2e mock paths (no real fs watcher, still a watchId)', async () => {
    const owner = new FakeWebContents(1);

    const { watchId } = await invokeWatch(owner, '/mock/test/directory');

    expect(watchId).toBeTruthy();
    expect(harness.startedPaths).toEqual([]);
    // The mock watch is tracked so unwatch/reaping stays uniform.
    expect(liveFileSystemWatcherCountForTest()).toBe(1);
    await invokeUnwatch(owner, watchId);
    expect(liveFileSystemWatcherCountForTest()).toBe(0);
  });

  it('fs:unwatch stops the watcher and stops pushing events', async () => {
    const owner = new FakeWebContents(1);
    const dir = await makeDir();

    const { watchId } = await invokeWatch(owner, dir);
    await invokeUnwatch(owner, watchId);

    expect(harness.stops[0]).toHaveBeenCalledOnce();
    expect(liveFileSystemWatcherCountForTest()).toBe(0);

    harness.fireAllChanges(SAMPLE_CHANGES);
    expect(owner.watchEvents).toEqual([]);
  });

  it('fs:unwatch from a non-owner renderer leaves the watcher running', async () => {
    const owner = new FakeWebContents(1);
    const intruder = new FakeWebContents(2);
    const dir = await makeDir();

    const { watchId } = await invokeWatch(owner, dir);
    await invokeUnwatch(intruder, watchId);

    expect(harness.stops[0]).not.toHaveBeenCalled();
    expect(liveFileSystemWatcherCountForTest()).toBe(1);
  });

  it('drops events and reaps every watcher owned by a destroyed renderer', async () => {
    const owner = new FakeWebContents(1);
    const survivorOwner = new FakeWebContents(2);
    const dirA = await makeDir();
    const dirB = await makeDir();
    const dirC = await makeDir();

    await invokeWatch(owner, dirA);
    await invokeWatch(owner, dirB);
    const { watchId: survivorId } = await invokeWatch(survivorOwner, dirC);

    owner.fireDestroyed();

    expect(liveFileSystemWatcherCountForTest()).toBe(1);
    harness.fireAllChanges(SAMPLE_CHANGES);
    expect(owner.watchEvents).toEqual([]);
    expect(survivorOwner.watchEvents).toEqual([{ changes: SAMPLE_CHANGES, watchId: survivorId }]);
  });

  it('the registrar disposer reaps every live watcher and unregisters the channels', async () => {
    const owner = new FakeWebContents(1);
    const dir = await makeDir();
    await invokeWatch(owner, dir);

    unregister();

    expect(harness.stops[0]).toHaveBeenCalledOnce();
    expect(liveFileSystemWatcherCountForTest()).toBe(0);
    expect(removeHandler).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.files.watch);
    expect(removeHandler).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.files.unwatch);
    // Re-register for afterEach symmetry.
    unregister = registerFileSystemWatchIpcHandlers({ startWatch: harness.startWatch });
  });
});
