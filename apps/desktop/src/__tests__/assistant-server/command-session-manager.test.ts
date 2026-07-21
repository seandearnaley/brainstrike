import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IPty } from 'node-pty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandSessionManager } from '../../assistant-server/command-session-manager';
import type { WorkspaceRootResolver } from '../../workspace-root-cwd';

class FakePty {
  readonly pid: number;
  readonly writes: string[] = [];
  killCalls = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();

  constructor(pid: number) {
    this.pid = pid;
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(exitCode: number, signal?: number): void {
    for (const listener of this.exitListeners) {
      listener({ exitCode, signal });
    }
  }

  kill(): void {
    this.killCalls += 1;
    this.emitExit(0, 9);
  }

  onData(listener: (data: string) => void): { dispose: () => void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose: () => void;
  } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  resize(): void {
    // Unused by command sessions, but part of IPty.
  }

  write(data: string): void {
    this.writes.push(data);
  }
}

function resolverFor(
  roots: { displayName: string; path: string; rootId: string }[]
): WorkspaceRootResolver {
  return { listRoots: () => Promise.resolve(roots) };
}

describe('command session manager', () => {
  let rootA: string;
  let rootB: string;
  let createdDirectories: string[];
  let spawned: FakePty[];
  let nextPid: number;

  beforeEach(async () => {
    rootA = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-command-session-a-'));
    rootB = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-command-session-b-'));
    createdDirectories = [rootA, rootB];
    spawned = [];
    nextPid = 41_000;
  });

  afterEach(async () => {
    await Promise.all(
      createdDirectories.map((directory) =>
        fsPromises.rm(directory, { force: true, recursive: true })
      )
    );
  });

  function createManager(options?: { exitedRetention?: number; maxBufferChars?: number }) {
    return createCommandSessionManager({
      ...options,
      idFactory: () => `session-${spawned.length + 1}`,
      resolver: resolverFor([
        { displayName: 'A', path: rootA, rootId: 'root-a' },
        { displayName: 'B', path: rootB, rootId: 'root-b' },
      ]),
      spawn: ((_file, _args, _options) => {
        const process = new FakePty(nextPid++);
        spawned.push(process);
        return process as unknown as IPty;
      }) as never,
      treeKill: (_pid, _signal, callback) => callback?.(),
    });
  }

  it('scopes opaque session ids and inventory to the owning workspace root', async () => {
    const manager = createManager();
    const session = await manager.start({ command: 'dev-server', rootId: 'root-a' });

    expect(session).toMatchObject({
      cwd: await fsPromises.realpath(rootA),
      id: 'session-1',
      rootId: 'root-a',
      status: 'running',
    });
    expect(manager.list('root-a')).toHaveLength(1);
    expect(manager.list('root-b')).toEqual([]);
    expect(() => manager.get('root-b', session.id)).toThrowError(
      expect.objectContaining({ code: 'session-not-found' })
    );
    expect(() => manager.read('root-b', session.id)).toThrowError(
      expect.objectContaining({ code: 'session-not-found' })
    );

    await manager.dispose();
  });

  it('replays bounded output with absolute cursors, explicit gaps, and no duplicates', async () => {
    const manager = createManager({ maxBufferChars: 8 });
    const session = await manager.start({ command: 'stream', rootId: 'root-a' });
    const process = spawned[0];
    expect(process).toBeDefined();

    process?.emitData('abc');
    const first = manager.read('root-a', session.id);
    expect(first).toEqual({
      bufferStartCursor: 0,
      nextCursor: 3,
      output: 'abc',
      requestedCursor: 0,
      truncatedBeforeCursor: false,
    });

    process?.emitData('defghijk');
    const incremental = manager.read('root-a', session.id, first.nextCursor);
    expect(incremental).toMatchObject({
      bufferStartCursor: 3,
      nextCursor: 11,
      output: 'defghijk',
      requestedCursor: 3,
      truncatedBeforeCursor: false,
    });
    const gap = manager.read('root-a', session.id, 0);
    expect(gap).toMatchObject({
      bufferStartCursor: 3,
      nextCursor: 11,
      output: 'defghijk',
      requestedCursor: 0,
      truncatedBeforeCursor: true,
    });
    expect(manager.read('root-a', session.id, incremental.nextCursor).output).toBe('');
    expect(() => manager.read('root-a', session.id, 12)).toThrowError(
      expect.objectContaining({ code: 'cursor-out-of-range' })
    );

    await manager.dispose();
  });

  it('accepts stdin while running and retains natural non-zero exit state', async () => {
    const manager = createManager();
    const session = await manager.start({ command: 'interactive', rootId: 'root-a' });
    const process = spawned[0];

    manager.write('root-a', session.id, 'hello\n');
    expect(process?.writes).toEqual(['hello\n']);
    process?.emitExit(7);

    expect(manager.get('root-a', session.id)).toMatchObject({
      exitCode: 7,
      signal: null,
      status: 'exited',
    });
    expect(() => manager.write('root-a', session.id, 'late')).toThrowError(
      expect.objectContaining({ code: 'session-exited' })
    );
    await expect(manager.stop('root-a', session.id)).rejects.toMatchObject({
      code: 'session-exited',
    });

    await manager.dispose();
  });

  it('retains only the newest bounded number of exited sessions per root', async () => {
    const manager = createManager({ exitedRetention: 2 });
    const first = await manager.start({ command: 'one', rootId: 'root-a' });
    spawned[0]?.emitExit(0);
    const second = await manager.start({ command: 'two', rootId: 'root-a' });
    spawned[1]?.emitExit(0);
    const third = await manager.start({ command: 'three', rootId: 'root-a' });
    spawned[2]?.emitExit(0);

    expect(manager.list('root-a').map(({ id }) => id)).toEqual([second.id, third.id]);
    expect(() => manager.get('root-a', first.id)).toThrowError(
      expect.objectContaining({ code: 'session-not-found' })
    );
  });

  it('surfaces startup failure without registering a phantom session', async () => {
    const manager = createCommandSessionManager({
      resolver: resolverFor([{ displayName: 'A', path: rootA, rootId: 'root-a' }]),
      spawn: (() => {
        throw new Error('pty unavailable');
      }) as never,
    });

    await expect(manager.start({ command: 'server', rootId: 'root-a' })).rejects.toMatchObject({
      code: 'start-failed',
    });
    expect(manager.list('root-a')).toEqual([]);
  });

  it('rejects invalid cwd containment before spawning', async () => {
    const manager = createManager();
    await expect(
      manager.start({ command: 'server', cwd: rootB, rootId: 'root-a' })
    ).rejects.toMatchObject({ code: 'cwd-outside-root' });
    expect(spawned).toEqual([]);
  });

  it('reaps running sessions on abort, remove, root disposal, and manager disposal', async () => {
    const manager = createManager();
    const abortController = new AbortController();
    const aborted = await manager.start({
      command: 'aborted',
      rootId: 'root-a',
      signal: abortController.signal,
    });
    abortController.abort();
    await vi.waitFor(() => expect(spawned[0]?.killCalls).toBe(1));

    const removed = await manager.start({ command: 'removed', rootId: 'root-a' });
    await manager.remove('root-a', removed.id);
    expect(spawned[1]?.killCalls).toBe(1);
    expect(() => manager.get('root-a', removed.id)).toThrowError(
      expect.objectContaining({ code: 'session-not-found' })
    );

    await manager.start({ command: 'root-a', rootId: 'root-a' });
    await manager.start({ command: 'root-b', rootId: 'root-b' });
    expect(await manager.disposeRoot('root-a')).toBe(1);
    expect(spawned[0]?.killCalls).toBe(1);
    expect(spawned[2]?.killCalls).toBe(1);
    expect(spawned[3]?.killCalls).toBe(0);
    expect(await manager.dispose()).toBe(1);
    expect(spawned[3]?.killCalls).toBe(1);

    expect(manager.list('root-a')).toEqual([]);
    expect(manager.list('root-b')).toEqual([]);
    expect(() => manager.get('root-a', aborted.id)).toThrowError(
      expect.objectContaining({ code: 'session-not-found' })
    );
  });
});
