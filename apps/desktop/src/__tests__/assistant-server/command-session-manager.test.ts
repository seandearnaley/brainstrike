import { Buffer } from 'node:buffer';
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
  killEmitsExit = true;
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
    if (this.killEmitsExit) {
      this.emitExit(0, 9);
    }
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

  function createManager(options?: {
    exitedRetention?: number;
    maxBufferChars?: number;
    processExitTimeoutMs?: number;
  }) {
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
    const tail = manager.read('root-a', session.id, -1);
    expect(tail).toMatchObject({
      nextCursor: 3,
      output: '',
      requestedCursor: -1,
      truncatedBeforeCursor: false,
    });
    const first = manager.read('root-a', session.id);
    expect(first).toEqual({
      bufferStartCursor: 0,
      hasMore: false,
      nextCursor: 3,
      output: 'abc',
      requestedCursor: 0,
      truncatedBeforeCursor: false,
    });

    process?.emitData('defghijk');
    expect(manager.read('root-a', session.id, tail.nextCursor).output).toBe('defghijk');
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

  it('does not slice the full retained buffer when appending output', async () => {
    const manager = createManager({ maxBufferChars: 24 });
    const session = await manager.start({ command: 'stream', rootId: 'root-a' });
    const process = spawned[0];
    const originalSlice = String.prototype.slice;
    const retainedBufferSlices: number[] = [];
    const sliceSpy = vi.spyOn(String.prototype, 'slice').mockImplementation(function (
      this: string,
      start?: number,
      end?: number
    ) {
      const source = String(this);
      if (source.length > 24 && source.startsWith('bolt-buffer-')) {
        retainedBufferSlices.push(source.length);
      }
      return originalSlice.call(source, start, end);
    });

    try {
      process?.emitData('bolt-buffer-');
      process?.emitData('abcdefghijkl');
      process?.emitData('mnopqrstuvwx');
    } finally {
      sliceSpy.mockRestore();
    }

    expect(retainedBufferSlices).toEqual([]);
    expect(manager.read('root-a', session.id).output).toBe('abcdefghijklmnopqrstuvwx');
    process?.emitData('yz');
    expect(manager.read('root-a', session.id)).toMatchObject({
      bufferStartCursor: 14,
      nextCursor: 38,
      output: 'cdefghijklmnopqrstuvwxyz',
    });
    expect(manager.read('root-a', session.id, 33).output).toBe('vwxyz');
    await manager.dispose();
  });

  it('preserves bounded string semantics across mixed output chunk sizes', async () => {
    const maxBufferChars = 37;
    const manager = createManager({ maxBufferChars });
    const session = await manager.start({ command: 'stream', rootId: 'root-a' });
    const process = spawned[0];
    const chunks = [
      'abc',
      'defghijklmnop',
      'q\uD800',
      '\uDCFFrstuvwxyz0123456789',
      'L'.repeat(53),
      'tail',
    ];
    let retained = '';
    let outputCursor = 0;

    for (const chunk of chunks) {
      process?.emitData(chunk);
      outputCursor += chunk.length;
      retained = `${retained}${chunk}`.slice(-maxBufferChars);
      const bufferStartCursor = outputCursor - retained.length;
      expect(manager.read('root-a', session.id)).toMatchObject({
        bufferStartCursor,
        nextCursor: outputCursor,
        output: retained,
      });
      for (const requestedCursor of [
        0,
        bufferStartCursor,
        Math.max(0, outputCursor - 5),
        outputCursor,
      ]) {
        const replayCursor = Math.max(requestedCursor, bufferStartCursor);
        expect(manager.read('root-a', session.id, requestedCursor).output).toBe(
          retained.slice(replayCursor - bufferStartCursor)
        );
      }
    }

    await manager.dispose();
  });

  it('coalesces tiny PTY events into a bounded number of retained blocks', async () => {
    const maxBufferChars = 40_000;
    const manager = createManager({ maxBufferChars });
    const session = await manager.start({ command: 'stream', rootId: 'root-a' });
    const process = spawned[0];
    const originalJoin = Array.prototype.join;
    const retainedBlockCounts: number[] = [];
    const joinSpy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
      this: unknown[],
      separator?: string
    ) {
      if (
        this.length > 0 &&
        this.every((value) => typeof value === 'string' && /^\uE000+$/u.test(value))
      ) {
        retainedBlockCounts.push(this.length);
      }
      return originalJoin.call(this, separator);
    });

    try {
      for (let index = 0; index < maxBufferChars; index += 1) {
        process?.emitData('\uE000');
      }
      expect(manager.read('root-a', session.id, undefined, maxBufferChars).output).toHaveLength(
        maxBufferChars
      );
    } finally {
      joinSpy.mockRestore();
    }

    expect(retainedBlockCounts).toEqual([3]);
    await manager.dispose();
  });

  it('decodes only one bounded page from a near-cap retained buffer', async () => {
    const maxBufferChars = 2 * 1024 * 1024;
    const pageChars = 32_768;
    const manager = createManager({ maxBufferChars });
    const session = await manager.start({ command: 'stream', rootId: 'root-a' });
    const process = spawned[0];

    process?.emitData('x'.repeat(maxBufferChars));
    const originalToString = Buffer.prototype.toString;
    const decodedByteLengths: number[] = [];
    const toStringSpy = vi.spyOn(Buffer.prototype, 'toString').mockImplementation(function (
      this: Buffer,
      encoding?: BufferEncoding,
      start?: number,
      end?: number
    ) {
      if (encoding === 'latin1' && start !== undefined && end !== undefined) {
        decodedByteLengths.push(end - start);
      }
      return originalToString.call(this, encoding, start, end);
    });

    let page: ReturnType<typeof manager.read>;
    try {
      page = manager.read('root-a', session.id, 0, pageChars);
    } finally {
      toStringSpy.mockRestore();
    }

    expect(page).toMatchObject({
      hasMore: true,
      nextCursor: pageChars,
      output: 'x'.repeat(pageChars),
      requestedCursor: 0,
    });
    expect(decodedByteLengths.reduce((total, length) => total + length, 0)).toBe(pageChars);
    await manager.dispose();
  });

  it('backs a page cursor off a high surrogate without dropping the pair', async () => {
    const pageChars = 8;
    const manager = createManager({ maxBufferChars: 32 });
    const session = await manager.start({ command: 'stream', rootId: 'root-a' });
    const process = spawned[0];
    const prefix = 'a'.repeat(pageChars - 1);
    const pairAndTail = '\uD83D\uDE80tail';

    process?.emitData(`${prefix}${pairAndTail}`);

    const first = manager.read('root-a', session.id, 0, pageChars);
    expect(first).toMatchObject({ hasMore: true, nextCursor: pageChars - 1, output: prefix });
    expect(manager.read('root-a', session.id, first.nextCursor, pageChars)).toMatchObject({
      hasMore: false,
      nextCursor: prefix.length + pairAndTail.length,
      output: pairAndTail,
    });
    await manager.dispose();
  });

  it('keeps Latin-1 PTY output in compact one-byte blocks', async () => {
    const maxBufferChars = 40_000;
    const manager = createManager({ maxBufferChars });
    const session = await manager.start({ command: 'stream', rootId: 'root-a' });
    const process = spawned[0];
    const allocatedBlockBytes: number[] = [];
    const allocUnsafeSpy = vi.spyOn(Buffer, 'allocUnsafe');

    try {
      for (let index = 0; index < maxBufferChars; index += 1) {
        process?.emitData('x');
      }
      for (const call of allocUnsafeSpy.mock.calls) {
        allocatedBlockBytes.push(call[0]);
      }
    } finally {
      allocUnsafeSpy.mockRestore();
    }

    expect(allocatedBlockBytes).toEqual([16_384, 16_384, 16_384]);
    expect(manager.read('root-a', session.id, undefined, maxBufferChars).output).toBe(
      'x'.repeat(maxBufferChars)
    );
    await manager.dispose();
  });

  it('accepts incremental output after a cap-sized event with the default block scale', async () => {
    const maxBufferChars = 20_000;
    const manager = createManager({ maxBufferChars });
    const session = await manager.start({ command: 'stream', rootId: 'root-a' });
    const process = spawned[0];

    process?.emitData('a'.repeat(maxBufferChars));
    process?.emitData('tail');

    expect(manager.read('root-a', session.id)).toMatchObject({
      bufferStartCursor: 4,
      nextCursor: maxBufferChars + 4,
      output: `${'a'.repeat(maxBufferChars - 4)}tail`,
    });
    await manager.dispose();
  });

  it('copies an oversized retained suffix without changing UTF-16 code units', async () => {
    const maxBufferChars = 7;
    const manager = createManager({ maxBufferChars });
    const session = await manager.start({ command: 'stream', rootId: 'root-a' });
    const process = spawned[0];
    const oversizedChunk = `discarded-parent-${'x'.repeat(40)}\uD800a\uDCFFtail`;
    const retainedSuffix = oversizedChunk.slice(-maxBufferChars);
    const bufferFromSpy = vi.spyOn(Buffer, 'from');
    let copiedRetainedSuffix = false;

    try {
      process?.emitData(oversizedChunk);
      copiedRetainedSuffix = bufferFromSpy.mock.calls.some(
        (call) => call[0] === retainedSuffix && call[1] === 'utf16le'
      );
    } finally {
      bufferFromSpy.mockRestore();
    }

    expect(copiedRetainedSuffix).toBe(true);
    const output = manager.read('root-a', session.id).output;
    expect(output).toBe(retainedSuffix);
    expect(Array.from(output, (character) => character.charCodeAt(0))).toEqual(
      Array.from(retainedSuffix, (character) => character.charCodeAt(0))
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

  it('rejects and reaps when cancellation races with PTY startup', async () => {
    const abortController = new AbortController();
    const manager = createCommandSessionManager({
      idFactory: () => 'raced-session',
      resolver: resolverFor([{ displayName: 'A', path: rootA, rootId: 'root-a' }]),
      spawn: ((_file, _args, _options) => {
        const process = new FakePty(nextPid++);
        spawned.push(process);
        abortController.abort();
        return process as unknown as IPty;
      }) as never,
      treeKill: (_pid, _signal, callback) => callback?.(),
    });

    await expect(
      manager.start({
        command: 'server',
        rootId: 'root-a',
        signal: abortController.signal,
      })
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(spawned[0]?.killCalls).toBe(1);
    expect(manager.list('root-a')).toEqual([]);
  });

  it('finishes root and global disposal when one PTY never reports exit', async () => {
    const manager = createManager({ processExitTimeoutMs: 5 });
    await manager.start({ command: 'hung-root', rootId: 'root-a' });
    await manager.start({ command: 'healthy-root', rootId: 'root-a' });
    spawned[0]!.killEmitsExit = false;

    await expect(manager.disposeRoot('root-a')).resolves.toBe(2);
    expect(spawned[0]?.killCalls).toBe(1);
    expect(spawned[1]?.killCalls).toBe(1);

    await manager.start({ command: 'hung-global', rootId: 'root-b' });
    await manager.start({ command: 'healthy-global', rootId: 'root-b' });
    spawned[2]!.killEmitsExit = false;

    await expect(manager.dispose()).resolves.toBe(2);
    expect(spawned[2]?.killCalls).toBe(1);
    expect(spawned[3]?.killCalls).toBe(1);
  });
});
