import { assertCoverageAuthority, fault } from '@brainstrike/indexer/coverage-reader';
import { describe, expect, it, vi } from 'vitest';
import { SqliteQueryClient, SqliteQueryDeadlineError } from '../client.js';
import type { QueryProcess } from '../process.js';
import type { QueryRequest, SqliteGrepOptions } from '../protocol.js';

function reader(ready = true) {
  let message: (value: unknown) => void = () => undefined;
  let exit: () => void = () => undefined;
  const requests: QueryRequest[] = [];
  const process: QueryProcess = {
    kill: vi.fn(),
    onError: () => () => undefined,
    onExit: (listener) => {
      exit = listener;
      return vi.fn();
    },
    onMessage: (listener) => {
      message = listener;
      return vi.fn();
    },
    postMessage: (request) => {
      requests.push(request);
      if ((request.kind === 'open' || request.kind === 'open-native-coverage') && ready) {
        queueMicrotask(() => message({ id: request.id, kind: 'ready' }));
      }
    },
  };
  return { exit: () => exit(), message: (value: unknown) => message(value), process, requests };
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
