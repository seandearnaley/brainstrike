import { assertCoverageAuthority, fault } from '@brainstrike/indexer/coverage-reader';
import { describe, expect, it, vi } from 'vitest';
import { SqliteQueryClient, SqliteQueryDeadlineError } from '../client.js';
import type { QueryProcess } from '../process.js';
import type { QueryRequest, SqliteGrepOptions } from '../protocol.js';

function reader(ready = true) {
  let message: (value: unknown) => void = () => undefined;
  let exit: () => void = () => undefined;
  const requests: QueryRequest[] = [];
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
    postMessage: vi.fn((request: QueryRequest) => {
      requests.push(request);
      if ((request.kind === 'open' || request.kind === 'open-native-coverage') && ready) {
        queueMicrotask(() => message({ id: request.id, kind: 'ready' }));
      }
    }),
  };
  return {
    detach,
    exit: () => exit(),
    message: (value: unknown) => message(value),
    process,
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
const grepRows = (id: number) => ({
  id,
  kind: 'grepRows',
  result: {
    columns: ['id'],
    identity: { embedding: { indexMode: 'text-only' }, storeId: 'a'.repeat(64) },
    matchedChunks: 1,
    rows: [[`chunk-${id}`]],
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
    owner.message(grepRows(2));
    await Promise.resolve();
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
    owner.message(grepRows(2));
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
    expect(error).toMatchObject({ message: 'SQLite query process exited.' });
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
    owner.message({ id: 1, kind: 'ready' });
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
    owner.message({ error: fault(failure), id: 2, kind: 'nativeCoverageError' });
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

it('fails a wrong-kind fault before the query deadline and retains listeners until physical exit', async () => {
  vi.useFakeTimers();
  const owner = reader();
  let client: SqliteQueryClient | undefined;
  let outcome: Promise<unknown> | undefined;
  try {
    const opening = open(owner);
    await vi.advanceTimersByTimeAsync(0);
    client = await opening;
    let settled = false;
    outcome = client.grep(options).catch((error: unknown) => {
      settled = true;
      return error;
    });
    owner.message({
      error: fault(new Error('wrong request kind')),
      id: 2,
      kind: 'nativeCoverageError',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.process.kill).toHaveBeenCalledOnce();
    expect(
      settled,
      'a terminal protocol fault must settle the correlated request without its timer'
    ).toBe(true);
    expect(await outcome).toMatchObject({
      message: 'Native coverage error replied to a grep request.',
    });
    for (const detach of Object.values(owner.detach)) {
      expect(detach).not.toHaveBeenCalled();
    }
  } finally {
    owner.exit();
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
    await client?.close();
    vi.useRealTimers();
  }
  for (const detach of Object.values(owner.detach)) {
    expect(detach).toHaveBeenCalledOnce();
  }
});

it.each([
  ['malformed rows', { id: 2, kind: 'grepRows', result: 'invalid' }],
  ['unknown correlation', grepRows(999)],
  ['wrong success kind', { id: 2, kind: 'ready' }],
] as const)('settles %s once and detaches only on exit', async (_name, reply) => {
  const owner = reader();
  const client = await open(owner);
  const outcome = client.grep(options).catch((error: unknown) => error);
  await posted(owner, 2);
  owner.message(reply);
  const error = await outcome;
  expect(error).toBeInstanceOf(Error);
  expect(owner.process.kill).toHaveBeenCalledOnce();
  owner.message(grepRows(2));
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
});
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
it('a late old-generation reply cannot settle a replacement with the same request id', async () => {
  const old = reader();
  const first = await open(old);
  const closed = first.close();
  old.exit();
  await closed;
  const replacement = reader();
  const second = await open(replacement);
  let settled = false;
  const result = second.grep(options).then((value) => {
    settled = true;
    return value;
  });
  await posted(replacement, 2);
  old.message({
    ...grepRows(2),
    result: { ...grepRows(2).result, rows: [['stale-old-generation']] },
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  replacement.message(grepRows(2));
  expect(await result).toMatchObject({ rows: [['chunk-2']] });
  expect(replacement.process.kill).not.toHaveBeenCalled();
  const closing = second.close();
  replacement.exit();
  await closing;
});
