import { describe, expect, it, vi } from 'vitest';
import { SqliteQueryCancelledError, SqliteQueryClient } from '../client.js';
import type { QueryProcess } from '../process.js';
import type { QueryRequest } from '../protocol.js';

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
      if (request.kind === 'open' && ready) {
        queueMicrotask(() => message({ id: request.id, kind: 'ready' }));
      }
    },
  };
  return { exit: () => exit(), message: (value: unknown) => message(value), process, requests };
}
function open(owner: ReturnType<typeof reader>, signal?: AbortSignal) {
  return SqliteQueryClient.open({
    databasePath: '/recorded/index.sqlite',
    deadlineMs: 1000,
    signal,
    spawn: () => owner.process,
    startupDeadlineMs: 1000,
  });
}
async function posted(owner: ReturnType<typeof reader>, count: number): Promise<void> {
  await vi.waitFor(() => expect(owner.requests).toHaveLength(count));
}
const rows = (id: number) => ({
  id,
  kind: 'rows',
  result: { columns: ['n'], rows: [[id]], truncated: false },
});

describe('owned reader cancellation', () => {
  it('refuses prior-abort acquisition without spawning', async () => {
    const signal = AbortSignal.abort(new Error('Stop'));
    const spawn = vi.fn();
    await expect(
      SqliteQueryClient.open({
        databasePath: '/recorded/index.sqlite',
        deadlineMs: 1000,
        signal,
        spawn,
        startupDeadlineMs: 1000,
      })
    ).rejects.toBe(signal.reason);
    expect(spawn).not.toHaveBeenCalled();
  });
  it('cancels startup and joins its exit while rejecting late ready', async () => {
    const owner = reader(false);
    const controller = new AbortController();
    const outcome = open(owner, controller.signal).catch((error: unknown) => error);
    await posted(owner, 1);
    controller.abort(new Error('Stop startup'));
    expect(owner.process.kill).toHaveBeenCalledOnce();
    owner.message({ id: 1, kind: 'ready' });
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    owner.exit();
    expect(await outcome).toMatchObject({
      name: 'SqliteQueryCancelledError',
      phase: 'startup',
      requestId: 1,
    });
    expect(owner.process.kill).toHaveBeenCalledOnce();
  });
  it.each(['query', 'listTables', 'describeTable'] as const)(
    'cancels %s and rejects late rows only after exit',
    async (kind) => {
      const owner = reader();
      const client = await open(owner);
      const controller = new AbortController();
      const call =
        kind === 'query'
          ? client.query('SELECT 1', { signal: controller.signal })
          : kind === 'listTables'
            ? client.listTables({ signal: controller.signal })
            : client.describeTable('records', { signal: controller.signal });
      const outcome = call.catch((error: unknown) => error);
      await posted(owner, 2);
      controller.abort(new Error('Stop query'));
      expect(owner.process.kill).toHaveBeenCalledOnce();
      owner.message(rows(2));
      owner.exit();
      const error = await outcome;
      expect(error).toBeInstanceOf(SqliteQueryCancelledError);
      expect(error).toMatchObject({
        cause: controller.signal.reason,
        phase: 'query',
        requestId: 2,
        requestKind: kind,
      });
      await expect(client.query('SELECT 2')).rejects.toBe(error);
      await client.close();
      expect(owner.process.kill).toHaveBeenCalledOnce();
    }
  );
  it('does not post a pre-aborted request or cancel an existing healthy client', async () => {
    const owner = reader();
    const client = await open(owner);
    const signal = AbortSignal.abort(new Error('Already stopped'));
    await expect(client.query('SELECT 1', { signal })).rejects.toBe(signal.reason);
    expect(owner.requests).toHaveLength(1);
    expect(owner.process.kill).not.toHaveBeenCalled();
    owner.exit();
    await client.close();
  });
  it('ignores an old signal after its response while a newer request is pending', async () => {
    const owner = reader();
    const client = await open(owner);
    const controller = new AbortController();
    const first = client.query('SELECT 1', { signal: controller.signal });
    await posted(owner, 2);
    const newer = client.query('SELECT 2');
    await posted(owner, 3);
    owner.message(rows(2));
    controller.abort(new Error('Late Stop'));
    expect(owner.process.kill).not.toHaveBeenCalled();
    owner.message(rows(3));
    expect((await first).rows).toEqual([[2]]);
    expect((await newer).rows).toEqual([[3]]);
    owner.exit();
    await client.close();
  });
  it('keeps failed cancellation cleanup visible and its owner retryable', async () => {
    const owner = reader();
    const client = await open(owner);
    const controller = new AbortController();
    vi.mocked(owner.process.kill).mockImplementation(() => {
      throw new Error('Kill refused');
    });
    const outcome = client
      .query('SELECT 1', { signal: controller.signal })
      .catch((error: unknown) => error);
    await posted(owner, 2);
    controller.abort(new Error('Stop'));
    expect(await outcome).toBeInstanceOf(AggregateError);
    owner.exit();
    await client.close();
  });
});

it('preserves cancellation classification when kill synchronously reports exit', async () => {
  const owner = reader();
  const client = await open(owner);
  vi.mocked(owner.process.kill).mockImplementation(owner.exit);
  const controller = new AbortController();
  const outcome = client
    .query('SELECT 1', { signal: controller.signal })
    .catch((error: unknown) => error);
  await posted(owner, 2);
  controller.abort(new Error('Stop'));
  expect(await outcome).toMatchObject({ name: 'SqliteQueryCancelledError', phase: 'query' });
  expect(owner.process.kill).toHaveBeenCalledOnce();
});
