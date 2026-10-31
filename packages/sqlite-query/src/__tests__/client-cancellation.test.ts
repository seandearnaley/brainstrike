import { assertCoverageAuthority, fault } from '@brainstrike/indexer/coverage-reader';
import { CHILD_SIGNAL_GRACE_MS } from '@brainstrike/state-store';
import { describe, expect, it, vi } from 'vitest';
import {
  SqliteQueryClient,
  SqliteQueryDeadlineError,
  SqliteQueryProcessExitedError,
} from '../client.js';
import type { QueryProcess } from '../process.js';
import type { SqliteGrepOptions } from '../protocol.js';

interface Request {
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}
function reader(ready = true) {
  let message: (value: unknown) => void = () => undefined;
  let exit: () => void = () => undefined;
  const requests: Request[] = [];
  const detach = { error: vi.fn(), exit: vi.fn(), message: vi.fn() };
  const process: QueryProcess = {
    kill: vi.fn(),
    onError: () => detach.error,
    onExit: (listener) => {
      exit = listener;
      return detach.exit;
    },
    onMessage: (listener) => {
      message = listener;
      return detach.message;
    },
    postMessage: vi.fn((frame) => {
      const request = frame as unknown as Request;
      requests.push(request);
      if ((request.method === 'open' || request.method === 'openNativeCoverage') && ready) {
        queueMicrotask(() => message({ id: request.id, jsonrpc: '2.0', result: null }));
      }
    }),
  };
  return {
    detach,
    exit: () => exit(),
    message: (value: unknown) => message(value),
    process,
    /** The id the client gave its `index`-th request. */
    requestId: (index: number) => requests[index]?.id ?? -1,
    requests,
  };
}
function open(owner: ReturnType<typeof reader>, deadlineMs = 1000) {
  return SqliteQueryClient.open({
    databasePath: '/recorded/index.sqlite',
    deadlineMs,
    spawn: () => owner.process,
    startupDeadlineMs: 1000,
  });
}
async function posted(owner: ReturnType<typeof reader>, count: number): Promise<void> {
  await vi.waitFor(() => expect(owner.requests).toHaveLength(count));
}
const options: SqliteGrepOptions = {
  caseSensitive: false,
  isRegex: false,
  maxRows: 10,
  pattern: 'needle',
  rootIds: ['root'],
};
const grepRows = (id: number, rows: readonly (readonly string[])[] = [[`chunk-${id}`]]) => ({
  id,
  jsonrpc: '2.0',
  result: {
    columns: ['id'],
    identity: { storeId: 'a'.repeat(64) },
    matchedChunks: 1,
    rows,
    truncated: false,
  },
});

// Production stops an in-flight grep three ways: its deadline, the owner's close
// (host Stop, reset and shutdown all reach it through closeAllIndexQueries), and a
// reader crash. No production caller cancels a single request.
describe('owned grep reader stop paths', () => {
  it('owner close rejects the in-flight grep, kills once and joins exit before resolving', async () => {
    const owner = reader();
    const client = await open(owner);
    const outcome = client.grep(options).catch((error: unknown) => error);
    await posted(owner, 2);
    let closed = false;
    const closing = client.close().then(() => {
      closed = true;
    });
    const error = await outcome;
    expect(error).toMatchObject({ message: 'SQLite query client is closed.' });
    expect(owner.process.kill).toHaveBeenCalledOnce();
    owner.message(grepRows(owner.requestId(1)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    owner.exit();
    await closing;
    await expect(client.grep(options)).rejects.toBe(error);
    expect(owner.process.kill).toHaveBeenCalledOnce();
  });

  it('a deadline kills the reader, ignores its late rows and keeps the deadline error', async () => {
    const owner = reader();
    const client = await open(owner, 20);
    const outcome = client.grep(options).catch((error: unknown) => error);
    await posted(owner, 2);
    const error = await outcome;
    expect(error).toBeInstanceOf(SqliteQueryDeadlineError);
    expect(owner.process.kill).toHaveBeenCalledOnce();
    owner.message(grepRows(owner.requestId(1)));
    await expect(client.grep(options)).rejects.toBe(error);
    const closing = client.close();
    owner.exit();
    await closing;
    expect(owner.process.kill).toHaveBeenCalledOnce();
  });

  it('a reader crash rejects the in-flight grep and leaves the client dead', async () => {
    const owner = reader();
    const client = await open(owner);
    const outcome = client.grep(options).catch((error: unknown) => error);
    await posted(owner, 2);
    owner.exit();
    const error = await outcome;
    // Typed, so Main classifies a signal's exit while quitting by its type (BST-2192).
    expect(error).toMatchObject({
      message: 'SQLite query process exited.',
      name: 'SqliteQueryProcessExitedError',
    });
    expect(error).toBeInstanceOf(SqliteQueryProcessExitedError);
    await expect(client.grep(options)).rejects.toBe(error);
    await client.close();
    expect(owner.process.kill).not.toHaveBeenCalled();
  });

  it('a startup deadline kills the reader and joins its exit while rejecting late ready', async () => {
    const owner = reader(false);
    const outcome = SqliteQueryClient.open({
      databasePath: '/recorded/index.sqlite',
      deadlineMs: 1000,
      spawn: () => owner.process,
      startupDeadlineMs: 20,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(owner.process.kill).toHaveBeenCalledOnce());
    owner.message({ id: owner.requestId(0), jsonrpc: '2.0', result: null });
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    owner.exit();
    expect(await outcome).toBeInstanceOf(SqliteQueryDeadlineError);
    expect(owner.process.kill).toHaveBeenCalledOnce();
  });

  it('keeps a failed kill visible and its owner retryable', async () => {
    const owner = reader();
    const client = await open(owner, 20);
    vi.mocked(owner.process.kill).mockImplementationOnce(() => {
      throw new Error('Kill refused');
    });
    const outcome = client.grep(options).catch((error: unknown) => error);
    await posted(owner, 2);
    const error = await outcome;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ message: expect.stringContaining('ownership is retained') });
    const closing = client.close();
    expect(owner.process.kill).toHaveBeenCalledTimes(2);
    owner.exit();
    await closing;
  });

  it('keeps the deadline classification when kill synchronously reports exit', async () => {
    const owner = reader();
    const client = await open(owner, 20);
    vi.mocked(owner.process.kill).mockImplementation(owner.exit);
    const outcome = client.grep(options).catch((error: unknown) => error);
    await posted(owner, 2);
    expect(await outcome).toBeInstanceOf(SqliteQueryDeadlineError);
    expect(owner.process.kill).toHaveBeenCalledOnce();
  });
});

it.each(['store', 'revision'] as const)(
  'preserves the canonical %s coverage discriminant through the process fault envelope',
  async (mismatch) => {
    const owner = reader();
    const authority = {
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      dbPath: '/recorded/index.sqlite',
      fileBindings: [],
      rootIds: [],
      scopes: [],
      storeId: 'a'.repeat(64),
    };
    const client = await SqliteQueryClient.openNativeCoverage({
      authority,
      deadlineMs: 1000,
      spawn: () => owner.process,
      startupDeadlineMs: 1000,
    });
    let failure: unknown;
    try {
      assertCoverageAuthority(
        {
          ...authority,
          authorityRevision: 2,
          storeId: mismatch === 'store' ? 'c'.repeat(64) : authority.storeId,
        },
        authority
      );
    } catch (error) {
      failure = error;
    }
    const result = client.nativeCoverage([{ scope: { kind: 'workspace', rootId: 'root' } }]);
    const response = result.catch((error: unknown) => error);
    await posted(owner, 2);
    owner.message({
      error: {
        code: -32_603,
        data: { fault: fault(failure), kind: 'coverage' },
        message: 'coverage refused',
      },
      id: owner.requestId(1),
      jsonrpc: '2.0',
    });
    expect(await response).toMatchObject({
      code: mismatch === 'store' ? 'coverage-store-mismatch' : 'coverage-authority-changed',
      name: 'IndexerError',
    });
    const closing = client.close();
    expect(owner.process.kill).toHaveBeenCalledOnce();
    owner.exit();
    await closing;
  }
);

it.each([
  ['malformed rows', (id: number) => ({ id, jsonrpc: '2.0', result: 'invalid' })],
  ['an empty success', (id: number) => ({ id, jsonrpc: '2.0', result: null })],
  [
    'an untyped refusal',
    (id: number) => ({ error: { code: -32_603, message: 'no data' }, id, jsonrpc: '2.0' }),
  ],
  ['a frame that is not JSON-RPC', (id: number) => ({ id, kind: 'grepRows' })],
] as const)(
  'settles %s once as a protocol fault and detaches only on exit',
  async (_name, reply) => {
    const owner = reader();
    const client = await open(owner);
    const outcome = client.grep(options).catch((error: unknown) => error);
    await posted(owner, 2);
    owner.message(reply(owner.requestId(1)));
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(owner.process.kill).toHaveBeenCalledOnce();
    owner.message(grepRows(owner.requestId(1)));
    await expect(client.grep(options)).rejects.toBe(error);
    for (const detach of Object.values(owner.detach)) {
      expect(detach).not.toHaveBeenCalled();
    }
    const closing = client.close();
    owner.exit();
    await closing;
    for (const detach of Object.values(owner.detach)) {
      expect(detach).toHaveBeenCalledOnce();
    }
  }
);
it('a synchronous post failure rejects the request and keeps its original error through joined close', async () => {
  const owner = reader();
  const client = await open(owner);
  const refusal = new Error('IPC send refused');
  vi.mocked(owner.process.postMessage).mockImplementationOnce(() => {
    throw refusal;
  });
  await expect(client.grep(options)).rejects.toBe(refusal);
  expect(owner.process.kill).toHaveBeenCalledOnce();
  await expect(client.grep(options)).rejects.toBe(refusal);
  const closing = client.close();
  owner.exit();
  await closing;
  for (const detach of Object.values(owner.detach)) {
    expect(detach).toHaveBeenCalledOnce();
  }
});
it('repeated close joins the same physical exit without duplicate kills or detached listeners', async () => {
  const owner = reader();
  const client = await open(owner);
  let first = false,
    second = false;
  const a = client.close().then(() => {
      first = true;
    }),
    b = client.close().then(() => {
      second = true;
    });
  await Promise.resolve();
  expect(first).toBe(false);
  expect(second).toBe(false);
  expect(owner.process.kill).toHaveBeenCalledOnce();
  for (const detach of Object.values(owner.detach)) {
    expect(detach).not.toHaveBeenCalled();
  }
  owner.exit();
  await Promise.all([a, b]);
  await client.close();
  expect(first).toBe(true);
  expect(second).toBe(true);
  expect(owner.process.kill).toHaveBeenCalledOnce();
  for (const detach of Object.values(owner.detach)) {
    expect(detach).toHaveBeenCalledOnce();
  }
});
// Lifecycle redesign PR D (R5(b)): after its kill, close joins the exit however long it takes.
it('joins an exit that arrives 6 s after the kill: close resolves and nothing is abandoned', async () => {
  vi.useFakeTimers();
  try {
    const owner = reader();
    const slowExits: number[] = [];
    const opening = SqliteQueryClient.open({
      databasePath: '/recorded/index.sqlite',
      deadlineMs: 1000,
      onSlowExit: (elapsedMs) => slowExits.push(elapsedMs),
      spawn: () => owner.process,
      startupDeadlineMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(0);
    const client = await opening;
    let settled = false;
    const closing = client.close().finally(() => {
      settled = true;
    });
    closing.catch(() => undefined);
    expect(owner.process.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5999);
    expect(settled).toBe(false);
    // The late exit is reported once, at the report window, and still joined.
    expect(slowExits).toEqual([CHILD_SIGNAL_GRACE_MS]);
    owner.exit();
    await expect(closing).resolves.toBeUndefined();
    expect(owner.process.kill).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

// Lifecycle redesign PR D: background coverage opens with no deadline; only the exit ends it.
it('a client opened with no deadline waits out a slow startup and read, and never stops its process', async () => {
  vi.useFakeTimers();
  try {
    const owner = reader(false);
    const opening = SqliteQueryClient.open({
      databasePath: '/recorded/index.sqlite',
      spawn: () => owner.process,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    owner.message({ id: owner.requestId(0), jsonrpc: '2.0', result: null });
    await vi.advanceTimersByTimeAsync(0);
    const client = await opening;

    const read = client.grep(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    owner.message(grepRows(owner.requestId(1), [['chunk']]));
    await vi.advanceTimersByTimeAsync(0);
    expect(await read).toMatchObject({ rows: [['chunk']] });
    expect(owner.process.kill).not.toHaveBeenCalled();
    const closing = client.close();
    owner.exit();
    await closing;
  } finally {
    vi.useRealTimers();
  }
});
