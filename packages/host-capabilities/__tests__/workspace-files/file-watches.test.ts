import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorkspaceFilesEvent } from '@brainstrike/agent-host';
import type { FileSystemChange, WatcherHealthTransition } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHostFileWatches,
  MAX_FILE_WATCHES_PER_CLIENT,
  type StartFileWatch,
} from '../../src/workspace-files/file-watches.ts';

let workspace: string;

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'host-file-watches-')));
  mkdirSync(path.join(workspace, 'src'));
});

afterEach(() => {
  rmSync(workspace, { force: true, recursive: true });
});

const roots = (...paths: string[]) => ({
  listRoots: async () =>
    paths.map((rootPath, index) => ({
      displayName: path.basename(rootPath),
      path: rootPath,
      rootId: `root-${index}`,
    })),
});

function health(state: WatcherHealthTransition['state']): WatcherHealthTransition {
  return {
    backend: 'inotify',
    ...(state === 'failed'
      ? { failure: { code: 'backend-error', message: 'EMFILE', retryable: true, terminal: false } }
      : {}),
    state,
    timestamp: Date.now(),
  };
}

/** A watch engine the test drives: each start's sinks and its stop. */
function scriptedWatch() {
  const started: {
    readonly onChanges: (changes: FileSystemChange[]) => void;
    readonly onHealth: (transition: WatcherHealthTransition) => void;
    readonly rootPath: string;
    readonly stop: ReturnType<typeof vi.fn>;
  }[] = [];
  const startWatch: StartFileWatch = async (rootPath, onChanges, onHealth) => {
    const stop = vi.fn(async () => undefined);
    started.push({ onChanges, onHealth, rootPath, stop });
    onHealth(health('healthy'));
    return stop;
  };
  return { started, startWatch };
}

/** ADR-0029 stage 4: the agent host owns the Explorer's watches on live roots. */
describe('host file watches', () => {
  it('watches only the exact path of a live root', async () => {
    const owner = createHostFileWatches({
      roots: roots(workspace),
      startWatch: scriptedWatch().startWatch,
    });
    const session = owner.service.open(vi.fn());

    await expect(
      session['workspace/files/watch']({ path: path.join(workspace, 'src') })
    ).rejects.toMatchObject({ failure: { code: 'workspace.watch-root-unknown' } });
    await expect(session['workspace/files/watch']({ path: tmpdir() })).rejects.toMatchObject({
      failure: { code: 'workspace.watch-root-unknown' },
    });
    await expect(session['workspace/files/watch']({ path: workspace })).resolves.toMatchObject({
      health: { state: 'healthy' },
    });
    await owner.close();
  });

  it('reports a live root that is gone from disk as unavailable', async () => {
    const missing = path.join(workspace, 'removed');
    const owner = createHostFileWatches({ roots: roots(missing) });
    await expect(
      owner.service.open(vi.fn())['workspace/files/watch']({ path: missing })
    ).rejects.toMatchObject({ failure: { code: 'workspace.watch-root-unavailable' } });
  });

  it('shares one native watch per root across clients, and stops it with the last one', async () => {
    const engine = scriptedWatch();
    const owner = createHostFileWatches({ roots: roots(workspace), startWatch: engine.startWatch });
    const firstEvents: WorkspaceFilesEvent[] = [];
    const secondEvents: WorkspaceFilesEvent[] = [];
    const first = owner.service.open((event) => firstEvents.push(event));
    const second = owner.service.open((event) => secondEvents.push(event));

    const a = await first['workspace/files/watch']({ path: workspace });
    const b = await second['workspace/files/watch']({ path: workspace });
    const change: FileSystemChange = {
      kind: 'file',
      path: path.join(workspace, 'a.ts'),
      type: 'added',
    };
    engine.started[0]?.onChanges([change]);

    expect(engine.started).toHaveLength(1);
    expect(firstEvents).toContainEqual({ changes: [change], type: 'changes', watchId: a.watchId });
    expect(secondEvents).toContainEqual({ changes: [change], type: 'changes', watchId: b.watchId });
    await first['workspace/files/unwatch']({ watchId: a.watchId });
    expect(engine.started[0]?.stop).not.toHaveBeenCalled();
    // A closed client's watches end with it.
    await second.close();
    expect(engine.started[0]?.stop).toHaveBeenCalledOnce();
  });

  it('retries a failed watch only when asked, and throttles repeated failures', async () => {
    const engine = scriptedWatch();
    const owner = createHostFileWatches({ roots: roots(workspace), startWatch: engine.startWatch });
    const events: WorkspaceFilesEvent[] = [];
    const session = owner.service.open((event) => events.push(event));
    const { watchId } = await session['workspace/files/watch']({ path: workspace });

    await expect(session['workspace/files/watch-retry']({ watchId })).resolves.toEqual({
      reason: 'not-failed',
      retried: false,
    });
    engine.started[0]?.onHealth(health('failed'));
    expect(events.at(-1)).toMatchObject({ state: 'failed', type: 'health', watchId });
    vi.useFakeTimers({ now: Date.now() });
    try {
      await expect(session['workspace/files/watch-retry']({ watchId })).resolves.toMatchObject({
        reason: 'throttled',
        retried: false,
      });
      vi.advanceTimersByTime(1000);
      await expect(session['workspace/files/watch-retry']({ watchId })).resolves.toEqual({
        retried: true,
      });
    } finally {
      vi.useRealTimers();
    }

    expect(engine.started).toHaveLength(2);
    expect(engine.started[0]?.stop).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ state: 'healthy', type: 'health', watchId });
    // The replaced watch's late reports reach no one.
    engine.started[0]?.onChanges([{ kind: 'file', path: workspace, type: 'modified' }]);
    expect(events.filter((event) => event.type === 'changes')).toEqual([]);
    await expect(
      session['workspace/files/watch-retry']({ watchId: 'fs-watch-unknown' })
    ).resolves.toEqual({ reason: 'unknown', retried: false });
    await owner.close();
  });

  it('refuses a failed start and keeps no producer for it', async () => {
    let fail = true;
    const startWatch: StartFileWatch = async () => {
      if (fail) {
        throw new Error('ENOSPC: inotify watch limit reached');
      }
      return async () => undefined;
    };
    const owner = createHostFileWatches({ roots: roots(workspace), startWatch });
    const session = owner.service.open(vi.fn());

    await expect(session['workspace/files/watch']({ path: workspace })).rejects.toThrow('ENOSPC');
    fail = false;
    await expect(session['workspace/files/watch']({ path: workspace })).resolves.toMatchObject({
      watchId: expect.stringMatching(/^fs-watch-/u),
    });
    await owner.close();
  });

  it('holds a client to its watch limit when its requests arrive together', async () => {
    const { startWatch } = scriptedWatch();
    const owner = createHostFileWatches({ roots: roots(workspace), startWatch });
    const session = owner.service.open(vi.fn());

    const results = await Promise.allSettled(
      Array.from({ length: MAX_FILE_WATCHES_PER_CLIENT + 3 }, () =>
        session['workspace/files/watch']({ path: workspace })
      )
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
      MAX_FILE_WATCHES_PER_CLIENT
    );
    expect(results.filter((result) => result.status === 'rejected')).toEqual(
      Array.from({ length: 3 }, () => ({
        reason: expect.objectContaining({
          failure: expect.objectContaining({ code: 'workspace.files-watch-limit' }),
        }),
        status: 'rejected',
      }))
    );
    await owner.close();
  });

  it("joins a disconnected client's pending start and reports its failed stop at close", async () => {
    const starting = Promise.withResolvers<() => Promise<void>>();
    const stopping = Promise.withResolvers<void>();
    const stop = vi.fn(() => stopping.promise);
    const startWatch = vi.fn<StartFileWatch>(() => starting.promise);
    const owner = createHostFileWatches({ roots: roots(workspace), startWatch });
    const session = owner.service.open(vi.fn());
    const watching = session['workspace/files/watch']({ path: workspace });
    await vi.waitFor(() => expect(startWatch).toHaveBeenCalledOnce());

    // The connection's dispose starts the client's close without awaiting it.
    session.close().catch(() => undefined);
    let settled = false;
    const closing = owner.close().finally(() => {
      settled = true;
    });
    starting.resolve(stop);
    await expect(watching).rejects.toMatchObject({ failure: { code: 'workspace.files-closed' } });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    const failure = new Error('EBUSY: the watch did not close');
    stopping.reject(failure);
    await expect(closing).rejects.toMatchObject({ errors: [failure] });
  });

  it('pushes a file written in the root to the client that watches it', async () => {
    const owner = createHostFileWatches({ roots: roots(workspace) });
    const events: WorkspaceFilesEvent[] = [];
    const session = owner.service.open((event) => events.push(event));
    const { watchId } = await session['workspace/files/watch']({ path: workspace });

    writeFileSync(path.join(workspace, 'src', 'index.ts'), 'export const value = 1;\n');

    await vi.waitFor(
      () =>
        expect(events).toContainEqual(
          expect.objectContaining({
            changes: expect.arrayContaining([
              expect.objectContaining({ path: path.join(workspace, 'src', 'index.ts') }),
            ]),
            type: 'changes',
            watchId,
          })
        ),
      { timeout: 10_000 }
    );
    await owner.close();
  });
});
