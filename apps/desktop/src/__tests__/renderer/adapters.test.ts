// @vitest-environment jsdom
import type { HostClient } from '@brainstrike/agent-host/browser';
import type { WorkspaceFilesEvent } from '@brainstrike/agent-host/protocol';
import type {
  FileSystemChange,
  FileSystemWatchSignal,
  WatcherHealthTransition,
  WatcherRootHealthEvent,
} from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ElectronRendererFileSystemAdapter,
  ElectronRendererStorageAdapter,
} from '../../renderer/adapters';
import { createDesktopHostConnection } from '../../renderer/desktop-host-connection';
import { mockElectronAPI } from '../setup';

// The window's real connector loads the browser JSON-RPC transport; each test injects its hosts.
vi.mock('../../renderer/agent-host-client', () => ({ connectDesktopAgentHost: vi.fn() }));

const ROOT = { kind: 'directory', name: 'repo', path: '/repo', platform: 'electron' } as const;
const OTHER = { kind: 'directory', name: 'docs', path: '/docs', platform: 'electron' } as const;

const health = (
  state: WatcherHealthTransition['state'],
  timestamp: number
): WatcherHealthTransition => ({ backend: 'inotify', state, timestamp });

/** One agent host: its answers, its watcher pushes, and a way to stop it. */
function fakeHost(name: string, answers: Readonly<Record<string, unknown>> = {}) {
  let push: (event: WorkspaceFilesEvent) => void = () => undefined;
  let stop: () => void = () => undefined;
  let started = 0;
  /** Health a host pushes for a new watcher before it answers the start. */
  let earlyHealth: WatcherHealthTransition | undefined;
  /** Until settled, a start stays unanswered. */
  let answering: Promise<void> = Promise.resolve();
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === 'files/watch') {
      started += 1;
      const watchId = `${name}-${started}`;
      if (earlyHealth) {
        push({ health: earlyHealth, type: 'health', watchId });
      }
      await answering;
      return { health: health('starting', 1), watchId };
    }
    return answers[method] ?? {};
  });
  const host = {
    close: vi.fn(async () => undefined),
    closed: new Promise<void>((resolve) => {
      stop = resolve;
    }),
    onWorkspaceFiles: vi.fn((listener: (event: WorkspaceFilesEvent) => void) => {
      push = listener;
      return () => undefined;
    }),
    request,
  } as unknown as HostClient;
  return {
    changes: (watchId: string, changes: FileSystemChange[]) =>
      push({ changes, type: 'changes', watchId }),
    health: (watchId: string, transition: WatcherHealthTransition) =>
      push({ health: transition, type: 'health', watchId }),
    holdStarts: () => {
      const held = Promise.withResolvers<void>();
      answering = held.promise;
      return held.resolve;
    },
    host,
    pushHealthBeforeAnswer: (transition: WatcherHealthTransition) => {
      earlyHealth = transition;
    },
    request,
    stop: () => stop(),
  };
}

type FakeHost = ReturnType<typeof fakeHost>;

/** An adapter on a frame connection that connects to each host in turn. */
function adapterOn(...fakes: FakeHost[]) {
  const hosts = fakes.map((fake) => fake.host);
  const connection = createDesktopHostConnection(async () => {
    const next = hosts.shift();
    if (!next) {
      throw new Error('No further agent host');
    }
    return next;
  });
  return { adapter: new ElectronRendererFileSystemAdapter(connection), connection };
}

/** Watch a root, recording what its consumers would see. */
function watch(adapter: ElectronRendererFileSystemAdapter, handle: typeof ROOT | typeof OTHER) {
  const changes: FileSystemChange[][] = [];
  const signals: FileSystemWatchSignal[] = [];
  const dispose = adapter.watchDirectory(
    handle,
    (batch) => changes.push(batch),
    (signal) => signals.push(signal)
  );
  return { changes, dispose, signals };
}

const added = (path: string): FileSystemChange => ({ kind: 'file', path, type: 'added' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('desktop Explorer reads', () => {
  it('lists a folder from the host, sending only the handle fields the host reads', async () => {
    const node = {
      depth: 1,
      handle: { kind: 'file', name: 'a.ts', path: '/repo/a.ts', platform: 'electron' },
      name: 'a.ts',
      path: '/repo/a.ts',
      rootFolderId: '/repo',
      selectionState: 'unchecked',
      type: 'file',
    } as const;
    const host = fakeHost('first', {
      'files/read-directory': [{ ...node, children: [node], type: 'directory' }],
    });
    const { adapter } = adapterOn(host);

    const listed = await adapter.readDirectory({ ...ROOT, _internal: { fsa: true }, rootId: 'r1' });

    expect(listed).toEqual([{ ...node, children: [node], type: 'directory' }]);
    expect(host.request).toHaveBeenCalledWith('files/read-directory', {
      handle: { ...ROOT, rootId: 'r1' },
    });
  });

  it('returns file text, and a missing or oversized file rejects with its code', async () => {
    const host = fakeHost('first', {
      'files/read-file': 'export const a = 1;\n',
      'files/read-file-by-path': { code: 'NOT_FOUND', message: 'The file was removed.' },
    });
    const { adapter } = adapterOn(host);

    await expect(
      adapter.readFile({ kind: 'file', name: 'a.ts', path: '/repo/a.ts', platform: 'electron' })
    ).resolves.toBe('export const a = 1;\n');
    await expect(adapter.readFileByPath('/repo/gone.ts')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'The file was removed.',
    });
  });

  it('refuses an absolute read without a durable root before asking the host', async () => {
    const host = fakeHost('first');
    const { adapter } = adapterOn(host);

    await expect(adapter.readFileByAbsolutePath('/repo/a.ts', '/repo', '')).rejects.toThrow(
      'durable rootId'
    );
    expect(host.request).not.toHaveBeenCalled();
  });

  it("reconstructs the folder picker's refusal after the context bridge", async () => {
    const { adapter } = adapterOn(fakeHost('first'));
    mockElectronAPI.folderPicker.requestDirectoryAccess.mockResolvedValueOnce({
      error: {
        category: 'authorization',
        code: 'workspace.never-granted',
        kind: 'refusal',
        message: 'Folder access was declined.',
        remedy: 'Choose this folder with Add folder to grant access.',
      },
      ok: false,
    } as never);

    await expect(adapter.requestDirectoryAccess()).rejects.toMatchObject({
      code: 'workspace.never-granted',
      failure: { remedy: 'Choose this folder with Add folder to grant access.' },
    });
  });
});

describe('desktop folder watches', () => {
  it("delivers each host batch to the watch that started it, with the host's health", async () => {
    const host = fakeHost('first');
    const { adapter } = adapterOn(host);
    const seen: WatcherRootHealthEvent[] = [];
    adapter.onWatcherHealth((event) => seen.push(event));

    const repo = watch(adapter, ROOT);
    const docs = watch(adapter, OTHER);
    await vi.waitFor(() => expect(host.request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    host.changes('first-2', [added('/docs/b.md')]);
    host.changes('unknown', [added('/repo/stray.ts')]);

    expect(repo.changes).toEqual([]);
    expect(docs.changes).toEqual([[added('/docs/b.md')]]);
    expect(seen.map(({ rootPath, state }) => ({ rootPath, state }))).toEqual([
      { rootPath: '/repo', state: 'starting' },
      { rootPath: '/docs', state: 'starting' },
    ]);
  });

  it('keeps health a host pushed before it answered the start', async () => {
    const host = fakeHost('first');
    host.pushHealthBeforeAnswer(health('healthy', 2));
    const { adapter } = adapterOn(host);
    const seen: WatcherRootHealthEvent[] = [];
    adapter.onWatcherHealth((event) => seen.push(event));

    watch(adapter, ROOT);

    await vi.waitFor(() => expect(seen.map(({ state }) => state)).toEqual(['healthy']));
  });

  it('reports a lost host as failed, then runs the same watch on the replacement', async () => {
    const first = fakeHost('first');
    const replacement = fakeHost('second');
    const { adapter } = adapterOn(first, replacement);
    const seen: WatcherRootHealthEvent[] = [];
    adapter.onWatcherHealth((event) => seen.push(event));
    const repo = watch(adapter, ROOT);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const watchId = seen[0]?.watchId;

    first.stop();
    await vi.waitFor(() =>
      expect(replacement.request).toHaveBeenCalledWith('files/watch', { handle: ROOT })
    );
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    replacement.changes('second-1', [added('/repo/new.ts')]);
    first.changes('first-1', [added('/repo/late.ts')]);

    expect(seen.map((event) => ({ state: event.state, watchId: event.watchId }))).toEqual([
      { state: 'starting', watchId },
      { state: 'failed', watchId },
      { state: 'starting', watchId },
    ]);
    expect(seen[1]?.failure).toMatchObject({ code: 'host-disconnected', retryable: false });
    // The failure stopped the watch visibly; the replacement asks for a refresh of the gap.
    expect(repo.signals.map((signal) => signal.type)).toEqual(['errored', 'overflow']);
    expect(repo.changes).toEqual([[added('/repo/new.ts')]]);
  });

  it('stays failed while no host is connected, and retries nothing there', async () => {
    const first = fakeHost('first');
    const { adapter, connection } = adapterOn(first);
    const seen: WatcherRootHealthEvent[] = [];
    adapter.onWatcherHealth((event) => seen.push(event));
    watch(adapter, ROOT);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    first.stop();
    await vi.waitFor(() => expect(connection.getSnapshot().kind).toBe('failed'));

    expect(seen.at(-1)).toMatchObject({ rootPath: '/repo', state: 'failed' });
    await expect(adapter.retryWatcher('/repo')).resolves.toEqual({
      reason: 'unknown',
      retried: false,
    });
  });

  it("retries a failed watch through its host's own watcher id", async () => {
    const host = fakeHost('first', { 'files/watch-retry': { retried: true } });
    const { adapter } = adapterOn(host);
    const seen: WatcherRootHealthEvent[] = [];
    adapter.onWatcherHealth((event) => seen.push(event));
    watch(adapter, ROOT);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    await expect(adapter.retryWatcher('/repo')).resolves.toEqual({ retried: true });
    expect(host.request).toHaveBeenCalledWith('files/watch-retry', { watchId: 'first-1' });
  });

  it('stops the host watcher of a watch disposed before the host answered', async () => {
    const host = fakeHost('first');
    const answer = host.holdStarts();
    const { adapter } = adapterOn(host);
    const repo = watch(adapter, ROOT);
    await vi.waitFor(() =>
      expect(host.request).toHaveBeenCalledWith('files/watch', { handle: ROOT })
    );

    repo.dispose();
    answer();

    expect(repo.signals).toEqual([]);
    await vi.waitFor(() =>
      expect(host.request).toHaveBeenCalledWith('files/unwatch', { watchId: 'first-1' })
    );
  });

  it('forgets a disposed watch: no batches, no health replay', async () => {
    const host = fakeHost('first');
    const { adapter } = adapterOn(host);
    const seen: WatcherRootHealthEvent[] = [];
    adapter.onWatcherHealth((event) => seen.push(event));
    const repo = watch(adapter, ROOT);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    repo.dispose();
    host.changes('first-1', [added('/repo/a.ts')]);
    host.health('first-1', health('degraded', 3));
    const replayed: WatcherRootHealthEvent[] = [];
    adapter.onWatcherHealth((event) => replayed.push(event));

    expect(repo.changes).toEqual([]);
    expect(repo.signals).toEqual([]);
    expect(replayed).toEqual([]);
    expect(host.request).toHaveBeenCalledWith('files/unwatch', { watchId: 'first-1' });
  });
});

describe('ElectronRendererStorageAdapter', () => {
  it("reads and writes through Main's storage bridge", async () => {
    const adapter = new ElectronRendererStorageAdapter();
    mockElectronAPI.storage.getItem.mockResolvedValueOnce('dark');
    mockElectronAPI.storage.getAllKeys.mockResolvedValueOnce(['theme']);

    await adapter.setItem('theme', 'dark');
    await expect(adapter.getItem('theme')).resolves.toBe('dark');
    await expect(adapter.getAllKeys()).resolves.toEqual(['theme']);
    await adapter.removeItem('theme');
    await adapter.clear();

    expect(mockElectronAPI.storage.setItem).toHaveBeenCalledWith('theme', 'dark');
    expect(mockElectronAPI.storage.removeItem).toHaveBeenCalledWith('theme');
    expect(mockElectronAPI.storage.clear).toHaveBeenCalledOnce();
  });
});
