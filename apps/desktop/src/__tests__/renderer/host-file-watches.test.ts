// @vitest-environment jsdom
import type { HostClient } from '@brainstrike/agent-host/browser';
import type { WorkspaceFilesEvent } from '@brainstrike/agent-host/protocol';
import type {
  FileSystemWatchSignal,
  WatcherHealthTransition,
  WatcherRootHealthEvent,
} from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopHostConnection } from '../../renderer/desktop-host-connection';
import { createDesktopFileWatches } from '../../renderer/host-file-watches';

// The window's real connector loads the browser JSON-RPC transport; each test injects its host.
vi.mock('../../renderer/agent-host-client', () => ({ connectDesktopAgentHost: vi.fn() }));

const ROOT = {
  kind: 'directory' as const,
  name: 'alpha',
  path: '/roots/alpha',
  platform: 'electron' as const,
};

function health(state: WatcherHealthTransition['state']): WatcherHealthTransition {
  return { backend: 'inotify', state, timestamp: Date.now() };
}

/** One agent host: its file-event stream, the requests it answered, and a way to end it. */
function fakeHost(answer: (method: string, params: unknown) => unknown) {
  let push: (event: WorkspaceFilesEvent) => void = () => undefined;
  let stop: () => void = () => undefined;
  const request = vi.fn(async (method: string, params: unknown) => answer(method, params));
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
  return { host, push: (event: WorkspaceFilesEvent) => push(event), request, stop: () => stop() };
}

function connectionTo(...hosts: HostClient[]) {
  const queue = [...hosts];
  return createDesktopHostConnection(async () => {
    const next = queue.shift();
    if (!next) {
      throw new Error('No further agent host');
    }
    return next;
  });
}

function watchesOn(...hosts: HostClient[]) {
  return createDesktopFileWatches(connectionTo(...hosts));
}

const watching = (watchId: string, initial?: WatcherHealthTransition) => (method: string) =>
  method === 'workspace/files/watch'
    ? { ...(initial ? { health: initial } : {}), watchId }
    : method === 'workspace/files/watch-retry'
      ? { retried: true }
      : null;

/** ADR-0029 stage 4: the Explorer's root watches are held on the window's host connection. */
describe('desktop file watches', () => {
  it('delivers a root’s batches with their filtered boundaries, and stops the watch on dispose', async () => {
    const agent = fakeHost(watching('watch-1'));
    const watches = watchesOn(agent.host);
    const callback = vi.fn();

    const stop = watches.watchDirectory(ROOT, callback);
    await vi.waitFor(() =>
      expect(agent.request).toHaveBeenCalledWith('workspace/files/watch', { path: '/roots/alpha' })
    );
    await vi.waitFor(() => expect(agent.host.onWorkspaceFiles).toHaveBeenCalled());
    await Promise.resolve();
    const changes = [{ kind: 'file' as const, path: '/roots/alpha/a.ts', type: 'added' as const }];
    agent.push({ changes, type: 'changes', watchId: 'watch-1' });
    agent.push({
      changes: [],
      filteredChangeBoundaries: ['dist'],
      type: 'changes',
      watchId: 'watch-1',
    });
    agent.push({ changes, type: 'changes', watchId: 'someone-else' });
    stop();
    agent.push({ changes, type: 'changes', watchId: 'watch-1' });

    expect(callback.mock.calls).toEqual([[changes], [[], { filteredChangeBoundaries: ['dist'] }]]);
    expect(agent.request).toHaveBeenCalledWith('workspace/files/unwatch', { watchId: 'watch-1' });
  });

  it('surfaces a watch the host refused as an errored signal, so the folder is visibly unwatched', async () => {
    const agent = fakeHost(() => {
      throw new Error('Only an open workspace folder can be watched.');
    });
    const signals: FileSystemWatchSignal[] = [];

    watchesOn(agent.host).watchDirectory(ROOT, vi.fn(), (signal) => signals.push(signal));

    await vi.waitFor(() =>
      expect(signals).toEqual([
        {
          message:
            'File watching could not start for /roots/alpha: Only an open workspace folder can be watched.',
          type: 'errored',
        },
      ])
    );
  });

  it('reports health on the watched root, from the answer and the stream, and as signals', async () => {
    const agent = fakeHost(watching('watch-1', health('healthy')));
    const watches = watchesOn(agent.host);
    const events: WatcherRootHealthEvent[] = [];
    const signals: FileSystemWatchSignal[] = [];
    watches.onWatcherHealth((event) => events.push(event));

    watches.watchDirectory(ROOT, vi.fn(), (signal) => signals.push(signal));
    await vi.waitFor(() => expect(events.map((event) => event.state)).toEqual(['healthy']));
    agent.push({ ...health('degraded'), type: 'health', watchId: 'watch-1' });
    agent.push({
      ...health('failed'),
      failure: { code: 'backend-error', message: 'EMFILE', retryable: true, terminal: false },
      type: 'health',
      watchId: 'watch-1',
    });

    expect(events.map(({ rootPath, state, watchId }) => ({ rootPath, state, watchId }))).toEqual([
      { rootPath: '/roots/alpha', state: 'healthy', watchId: 'watch-1' },
      { rootPath: '/roots/alpha', state: 'degraded', watchId: 'watch-1' },
      { rootPath: '/roots/alpha', state: 'failed', watchId: 'watch-1' },
    ]);
    expect(signals).toEqual([{ type: 'overflow' }, { message: 'EMFILE', type: 'errored' }]);
    // A later subscriber is replayed the latest state.
    const replayed: WatcherRootHealthEvent[] = [];
    watches.onWatcherHealth((event) => replayed.push(event));
    expect(replayed.map((event) => event.state)).toEqual(['failed']);
  });

  it('asks the holding host to retry a failed watch', async () => {
    const agent = fakeHost(watching('watch-1', health('failed')));
    const watches = watchesOn(agent.host);
    watches.watchDirectory(ROOT, vi.fn());
    await vi.waitFor(() =>
      expect(agent.request).toHaveBeenCalledWith('workspace/files/watch', { path: '/roots/alpha' })
    );
    await vi.waitFor(async () =>
      expect(await watches.retryWatcher('/roots/alpha')).toEqual({ retried: true })
    );

    expect(agent.request).toHaveBeenCalledWith('workspace/files/watch-retry', {
      watchId: 'watch-1',
    });
    await expect(watches.retryWatcher('/roots/never-watched')).resolves.toEqual({
      reason: 'unknown',
      retried: false,
    });
  });

  it('reports nothing when the window closes its own host connection', async () => {
    const agent = fakeHost(watching('watch-1', health('healthy')));
    // The fake's close ends it, as a real client's close settles `closed`.
    vi.mocked(agent.host.close).mockImplementation(async () => agent.stop());
    const connection = connectionTo(agent.host);
    const watches = createDesktopFileWatches(connection);
    const events: WatcherRootHealthEvent[] = [];
    const signals: FileSystemWatchSignal[] = [];
    watches.onWatcherHealth((event) => events.push(event));
    watches.watchDirectory(ROOT, vi.fn(), (signal) => signals.push(signal));
    await vi.waitFor(() => expect(events).toHaveLength(1));

    await connection.close();

    expect(events.map((event) => event.state)).toEqual(['healthy']);
    expect(signals).toEqual([]);
  });

  it('shows a watch failed when its host ends, and a retry watches again on the replacement', async () => {
    const first = fakeHost(watching('watch-1', health('healthy')));
    const replacement = fakeHost(watching('watch-2', health('healthy')));
    const watches = watchesOn(first.host, replacement.host);
    const events: WatcherRootHealthEvent[] = [];
    watches.onWatcherHealth((event) => events.push(event));
    const callback = vi.fn();
    watches.watchDirectory(ROOT, callback);
    await vi.waitFor(() => expect(events).toHaveLength(1));

    first.stop();
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toMatchObject({
      failure: { code: 'host-ended', retryable: true, terminal: false },
      rootPath: '/roots/alpha',
      state: 'failed',
    });
    await expect(watches.retryWatcher('/roots/alpha')).resolves.toEqual({ retried: true });
    const changes = [{ kind: 'file' as const, path: '/roots/alpha/b.ts', type: 'added' as const }];
    replacement.push({ changes, type: 'changes', watchId: 'watch-2' });

    expect(replacement.request).toHaveBeenCalledWith('workspace/files/watch', {
      path: '/roots/alpha',
    });
    expect(events.at(-1)).toMatchObject({ state: 'healthy', watchId: 'watch-2' });
    expect(callback).toHaveBeenCalledWith(changes);
  });

  it('shares one start between overlapping retries, so the root is watched and delivered once', async () => {
    const first = fakeHost(watching('watch-1', health('healthy')));
    let issued = 1;
    const replacement = fakeHost((method) =>
      method === 'workspace/files/watch' ? { watchId: `watch-${++issued}` } : null
    );
    const watches = watchesOn(first.host, replacement.host);
    const events: WatcherRootHealthEvent[] = [];
    watches.onWatcherHealth((event) => events.push(event));
    const callback = vi.fn();
    watches.watchDirectory(ROOT, callback);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    first.stop();
    await vi.waitFor(() => expect(events).toHaveLength(2));

    // The health chip and the rewind recovery can both retry the same root.
    await expect(
      Promise.all([watches.retryWatcher('/roots/alpha'), watches.retryWatcher('/roots/alpha')])
    ).resolves.toEqual([{ retried: true }, { retried: true }]);
    const changes = [{ kind: 'file' as const, path: '/roots/alpha/c.ts', type: 'added' as const }];
    replacement.push({ changes, type: 'changes', watchId: 'watch-2' });
    replacement.push({ changes, type: 'changes', watchId: 'watch-3' });

    expect(
      replacement.request.mock.calls.filter(([method]) => method === 'workspace/files/watch')
    ).toHaveLength(1);
    expect(callback.mock.calls).toEqual([[changes]]);
  });
});
