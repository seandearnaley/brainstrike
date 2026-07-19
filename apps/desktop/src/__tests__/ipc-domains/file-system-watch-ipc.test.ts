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
import type {
  FileSystemChange,
  WatcherHealthEvent,
  WatcherHealthTransition,
} from '@brainstrike/types';
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
  type FileSystemWatchRetryResult,
  liveFileSystemWatcherCountForTest,
  MAX_FS_WATCHERS_PER_OWNER,
  registerFileSystemWatchIpcHandlers,
  type StartFileSystemWatch,
  WATCH_RETRY_BACKOFF_MS,
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

interface FakeListenerEntry {
  listener: () => void;
  once: boolean;
}

/**
 * A minimal WebContents stand-in modelling on/once/removeListener with real
 * add/remove semantics so listener-accumulation leaks are observable via
 * `listenerCount`. Records the watch events pushed to it.
 */
class FakeWebContents {
  readonly id: number;
  readonly watchEvents: FileSystemWatchEventPayload[] = [];
  readonly healthEvents: WatcherHealthEvent[] = [];
  private destroyed = false;
  private readonly listeners = new Map<string, FakeListenerEntry[]>();

  constructor(id: number) {
    this.id = id;
  }

  send(channel: string, payload: unknown): void {
    if (channel === DESKTOP_IPC_CHANNELS.files.watchEvent) {
      this.watchEvents.push(payload as FileSystemWatchEventPayload);
    }
    if (channel === DESKTOP_IPC_CHANNELS.files.watchHealth) {
      this.healthEvents.push(payload as WatcherHealthEvent);
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  on(event: string, listener: () => void): void {
    this.addListener(event, listener, false);
  }

  once(event: string, listener: () => void): void {
    this.addListener(event, listener, true);
  }

  removeListener(event: string, listener: () => void): void {
    const entries = this.listeners.get(event);
    if (!entries) {
      return;
    }
    const next = entries.filter((entry) => entry.listener !== listener);
    if (next.length === 0) {
      this.listeners.delete(event);
    } else {
      this.listeners.set(event, next);
    }
  }

  /** Test helper: live listener count for an event (leak detection). */
  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  private addListener(event: string, listener: () => void, once: boolean): void {
    const entries = this.listeners.get(event) ?? [];
    entries.push({ listener, once });
    this.listeners.set(event, entries);
  }

  private fire(event: string): void {
    // Snapshot before firing — a reap listener may mutate the map mid-iteration.
    const entries = [...(this.listeners.get(event) ?? [])];
    for (const entry of entries) {
      if (entry.once) {
        this.removeListener(event, entry.listener);
      }
      entry.listener();
    }
  }

  /** Test helper: simulate the renderer being destroyed. */
  fireDestroyed(): void {
    this.destroyed = true;
    this.fire('destroyed');
  }

  /** Test helper: simulate a renderer crash (WebContents survives). */
  fireRenderProcessGone(): void {
    this.fire('render-process-gone');
  }

  /** Test helper: simulate a main-frame navigation/reload. */
  fireDidNavigate(): void {
    this.fire('did-navigate');
  }
}

const TEARDOWN_EVENTS = ['destroyed', 'render-process-gone', 'did-navigate'] as const;

function totalTeardownListeners(owner: FakeWebContents): number {
  return TEARDOWN_EVENTS.reduce((sum, event) => sum + owner.listenerCount(event), 0);
}

function invokeEventFor(owner: FakeWebContents): IpcMainInvokeEvent {
  return { sender: owner as unknown as WebContents } as IpcMainInvokeEvent;
}

interface WatchHarness {
  /** Fire every live fake watcher with the given changes. */
  fireAllChanges: (changes: FileSystemChange[]) => void;
  /** Fire a health transition on the most recent watcher's health callback. */
  fireLatestHealth: (transition: WatcherHealthTransition) => void;
  startedPaths: string[];
  startWatch: StartFileSystemWatch;
  stops: ReturnType<typeof vi.fn>[];
}

function makeTransition(
  state: WatcherHealthTransition['state'],
  failure?: WatcherHealthTransition['failure']
): WatcherHealthTransition {
  return {
    backend: 'fs-events',
    ...(failure ? { failure } : {}),
    state,
    timestamp: Date.now(),
  };
}

const FAILED_TRANSITION_FAILURE = {
  code: 'subscribe-failed',
  message: 'boom',
  retryable: true,
  terminal: false,
};

function createWatchHarness(): WatchHarness {
  const startedPaths: string[] = [];
  const stops: ReturnType<typeof vi.fn>[] = [];
  const liveCallbacks = new Set<(changes: FileSystemChange[]) => void>();
  const healthCallbacks: Array<(transition: WatcherHealthTransition) => void> = [];
  return {
    fireAllChanges: (changes) => {
      for (const callback of Array.from(liveCallbacks)) {
        callback(changes);
      }
    },
    fireLatestHealth: (transition) => {
      const latest = healthCallbacks.at(-1);
      if (!latest) {
        throw new Error('no health callback captured');
      }
      latest(transition);
    },
    startedPaths,
    startWatch: (directoryPath, onChanges, onHealth) => {
      startedPaths.push(directoryPath);
      liveCallbacks.add(onChanges);
      healthCallbacks.push(onHealth);
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

async function invokeRetry(
  owner: FakeWebContents,
  watchId: string
): Promise<FileSystemWatchRetryResult> {
  const handler = registeredHandlers.get(DESKTOP_IPC_CHANNELS.files.watchRetry);
  if (!handler) {
    throw new Error('fs:watch-retry handler is not registered');
  }
  return (await handler(invokeEventFor(owner), watchId)) as FileSystemWatchRetryResult;
}

async function invokeTelemetry(owner: FakeWebContents): Promise<unknown> {
  const handler = registeredHandlers.get(DESKTOP_IPC_CHANNELS.files.watchTelemetry);
  if (!handler) {
    throw new Error('fs:watch-telemetry handler is not registered');
  }
  return await handler(invokeEventFor(owner));
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

  it('rejects a watch from an already-destroyed renderer without leaking a watcher', async () => {
    const owner = new FakeWebContents(1);
    const dir = await makeDir();
    owner.fireDestroyed();

    await expect(invokeWatch(owner, dir)).rejects.toThrow(/destroyed/i);
    expect(liveFileSystemWatcherCountForTest()).toBe(0);
    for (const stop of harness.stops) {
      expect(stop).toHaveBeenCalled();
    }
  });

  it('reaps watchers when the renderer process crashes (WebContents survives)', async () => {
    const owner = new FakeWebContents(1);
    const dir = await makeDir();
    await invokeWatch(owner, dir);

    owner.fireRenderProcessGone();

    expect(harness.stops[0]).toHaveBeenCalledOnce();
    expect(liveFileSystemWatcherCountForTest()).toBe(0);
  });

  it('reaps watchers when the renderer navigates/reloads', async () => {
    const owner = new FakeWebContents(1);
    const dir = await makeDir();
    await invokeWatch(owner, dir);

    owner.fireDidNavigate();

    expect(harness.stops[0]).toHaveBeenCalledOnce();
    expect(liveFileSystemWatcherCountForTest()).toBe(0);

    // A reloaded renderer can start fresh watches (reaper re-attaches).
    const { watchId } = await invokeWatch(owner, dir);
    expect(watchId).toBeTruthy();
    expect(liveFileSystemWatcherCountForTest()).toBe(1);
  });

  it('does not accumulate teardown listeners across repeated reloads', async () => {
    const owner = new FakeWebContents(1);
    const dir = await makeDir();

    // Simulate several reload cycles: watch, navigate (reap), re-watch.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await invokeWatch(owner, dir);
      owner.fireDidNavigate();
    }
    // After a reload with no live watch, at most one reaper is attached per
    // teardown event — the sibling listeners of a fired reap must be removed,
    // not left dangling to pile up on the surviving WebContents.
    await invokeWatch(owner, dir);
    for (const event of TEARDOWN_EVENTS) {
      expect(owner.listenerCount(event)).toBeLessThanOrEqual(1);
    }
    expect(totalTeardownListeners(owner)).toBeLessThanOrEqual(TEARDOWN_EVENTS.length);

    // The still-attached reaper must remain functional after all those cycles.
    owner.fireDestroyed();
    expect(liveFileSystemWatcherCountForTest()).toBe(0);
    expect(totalTeardownListeners(owner)).toBe(0);
  });

  it('caps the number of live watchers per renderer', async () => {
    const owner = new FakeWebContents(1);
    const other = new FakeWebContents(2);
    const dir = await makeDir();

    for (let index = 0; index < MAX_FS_WATCHERS_PER_OWNER; index += 1) {
      await invokeWatch(owner, dir);
    }
    await expect(invokeWatch(owner, dir)).rejects.toThrow(/limit/i);
    // The cap is per-owner: another renderer can still watch.
    await expect(invokeWatch(other, dir)).resolves.toBeTruthy();
  });

  it('enforces the per-owner cap under concurrent watch requests (no TOCTOU bypass)', async () => {
    const owner = new FakeWebContents(1);
    const dir = await makeDir();

    // Fire MAX + 5 watches concurrently: they all pass the initial (pre-await)
    // count check unless a slot is reserved BEFORE the stat await. Exactly MAX
    // must survive.
    const attempts = MAX_FS_WATCHERS_PER_OWNER + 5;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () => invokeWatch(owner, dir))
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter(
      (r) => r.status === 'rejected' && /limit/i.test(String(r.reason))
    ).length;

    expect(fulfilled).toBe(MAX_FS_WATCHERS_PER_OWNER);
    expect(rejected).toBe(5);
    expect(liveFileSystemWatcherCountForTest()).toBe(MAX_FS_WATCHERS_PER_OWNER);
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

  describe('watch health protocol (BST-568 slice 3)', () => {
    it('pushes health events to the owning renderer with the watchId attached', async () => {
      const owner = new FakeWebContents(1);
      const other = new FakeWebContents(2);
      const dir = await makeDir();
      const { watchId } = await invokeWatch(owner, dir);

      harness.fireLatestHealth(makeTransition('healthy'));

      expect(owner.healthEvents).toHaveLength(1);
      expect(owner.healthEvents[0]).toMatchObject({ state: 'healthy', watchId });
      // Health events never carry the root path across the wire.
      expect(JSON.stringify(owner.healthEvents[0])).not.toContain(dir);
      expect(other.healthEvents).toHaveLength(0);
    });

    it('retries a failed watch: same path, replaced stop, retried:true', async () => {
      vi.useFakeTimers();
      try {
        const owner = new FakeWebContents(1);
        const dir = await makeDir();
        const { watchId } = await invokeWatch(owner, dir);
        harness.fireLatestHealth(makeTransition('failed', FAILED_TRANSITION_FAILURE));

        vi.advanceTimersByTime(WATCH_RETRY_BACKOFF_MS[0] + 1);
        const result = await invokeRetry(owner, watchId);

        expect(result).toEqual({ retried: true });
        expect(harness.startedPaths).toEqual([dir, dir]);
        expect(harness.stops[0]).toHaveBeenCalledOnce();
        expect(liveFileSystemWatcherCountForTest()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('throttles retries with escalating backoff per consecutive failure', async () => {
      vi.useFakeTimers();
      try {
        const owner = new FakeWebContents(1);
        const dir = await makeDir();
        const { watchId } = await invokeWatch(owner, dir);
        harness.fireLatestHealth(makeTransition('failed', FAILED_TRANSITION_FAILURE));

        // Immediately after the failure the first backoff window applies.
        const throttled = await invokeRetry(owner, watchId);
        expect(throttled.retried).toBe(false);
        expect(throttled).toMatchObject({ reason: 'throttled' });

        vi.advanceTimersByTime(WATCH_RETRY_BACKOFF_MS[0] + 1);
        const first = await invokeRetry(owner, watchId);
        expect(first).toEqual({ retried: true });

        // Second consecutive failure escalates to the next backoff step.
        harness.fireLatestHealth(makeTransition('failed', FAILED_TRANSITION_FAILURE));
        vi.advanceTimersByTime(WATCH_RETRY_BACKOFF_MS[0] + 1);
        const stillThrottled = await invokeRetry(owner, watchId);
        expect(stillThrottled.retried).toBe(false);
        vi.advanceTimersByTime(WATCH_RETRY_BACKOFF_MS[1]);
        const second = await invokeRetry(owner, watchId);
        expect(second).toEqual({ retried: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it('a healthy transition resets the consecutive-failure backoff', async () => {
      vi.useFakeTimers();
      try {
        const owner = new FakeWebContents(1);
        const dir = await makeDir();
        const { watchId } = await invokeWatch(owner, dir);
        harness.fireLatestHealth(makeTransition('failed', FAILED_TRANSITION_FAILURE));
        vi.advanceTimersByTime(WATCH_RETRY_BACKOFF_MS[0] + 1);
        await invokeRetry(owner, watchId);
        harness.fireLatestHealth(makeTransition('healthy'));

        // Next failure starts back at the FIRST backoff step.
        harness.fireLatestHealth(makeTransition('failed', FAILED_TRANSITION_FAILURE));
        vi.advanceTimersByTime(WATCH_RETRY_BACKOFF_MS[0] + 1);
        const result = await invokeRetry(owner, watchId);
        expect(result).toEqual({ retried: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects retry for a watch that is not failed', async () => {
      const owner = new FakeWebContents(1);
      const dir = await makeDir();
      const { watchId } = await invokeWatch(owner, dir);
      harness.fireLatestHealth(makeTransition('healthy'));

      const result = await invokeRetry(owner, watchId);
      expect(result.retried).toBe(false);
      expect(result).toMatchObject({ reason: 'not-failed' });
      expect(harness.startedPaths).toHaveLength(1);
    });

    it('treats non-owner and unknown watchIds identically (no ownership oracle)', async () => {
      const owner = new FakeWebContents(1);
      const intruder = new FakeWebContents(2);
      const dir = await makeDir();
      const { watchId } = await invokeWatch(owner, dir);
      harness.fireLatestHealth(makeTransition('failed', FAILED_TRANSITION_FAILURE));

      const nonOwner = await invokeRetry(intruder, watchId);
      const unknown = await invokeRetry(intruder, 'fs-watch-does-not-exist');
      expect(nonOwner).toEqual(unknown);
      expect(nonOwner.retried).toBe(false);
      expect(harness.startedPaths).toHaveLength(1);
    });

    it('unwatch drops health/retry state with the watcher', async () => {
      const owner = new FakeWebContents(1);
      const dir = await makeDir();
      const { watchId } = await invokeWatch(owner, dir);
      harness.fireLatestHealth(makeTransition('failed', FAILED_TRANSITION_FAILURE));
      await invokeUnwatch(owner, watchId);

      const result = await invokeRetry(owner, watchId);
      expect(result.retried).toBe(false);
      expect(liveFileSystemWatcherCountForTest()).toBe(0);
    });

    it('exposes a compact telemetry snapshot', async () => {
      vi.useFakeTimers();
      try {
        const owner = new FakeWebContents(1);
        const dir = await makeDir();
        const { watchId } = await invokeWatch(owner, dir);
        harness.fireLatestHealth(makeTransition('failed', FAILED_TRANSITION_FAILURE));
        vi.advanceTimersByTime(WATCH_RETRY_BACKOFF_MS[0] + 1);
        await invokeRetry(owner, watchId);

        const snapshot = await invokeTelemetry(owner);
        expect(snapshot).toMatchObject({
          activeWatchers: 1,
          failures: 1,
          retries: 1,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
