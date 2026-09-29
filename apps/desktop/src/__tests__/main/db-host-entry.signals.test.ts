import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootHost,
  lifecycleStates,
  posted,
  responsesFor,
  restoreParentPort,
} from '../helpers/db-host-entry-harness';

const dbMainMocks = vi.hoisted(() => ({
  closeDatabase: vi.fn(),
  getDatabase: vi.fn(),
  getDatabaseDiagnostics: vi.fn(() => ({ hasDatabaseHandle: true })),
  initializeMainDatabase: vi.fn(),
  resetLocalDatabase: vi.fn(),
}));

vi.mock('../../db-main', () => dbMainMocks);

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  return Promise.withResolvers<T>();
}

describe('db-host-entry signals and close lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mock of Object.values(dbMainMocks)) {
      mock.mockReset();
    }
    dbMainMocks.getDatabaseDiagnostics.mockReturnValue({ hasDatabaseHandle: true });
    dbMainMocks.closeDatabase.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    restoreParentPort();
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    'registers a persistent %s handler, never a once-only one',
    async (signal) => {
      const host = await bootHost();

      expect(host.signalHandlers.get(signal)).toHaveLength(1);
      dbMainMocks.getDatabase.mockResolvedValue({ query: vi.fn(async () => ({ rows: [] })) });
      host.signal(signal);
      await vi.waitFor(() => expect(host.exitCodes).toEqual([0]));
      // Still installed after firing: a later signal reaches it again.
      host.signal(signal);
      expect(host.exitCodes).toEqual([0, 0]);
      expect(dbMainMocks.closeDatabase).toHaveBeenCalledTimes(1);
    }
  );

  it('SIGINT lets the in-flight query finish, rejects the queued one, then closes and exits 0', async () => {
    const running = deferred<{ rows: unknown[] }>();
    const query = vi.fn(() => running.promise);
    dbMainMocks.getDatabase.mockResolvedValue({ query });
    const host = await bootHost();

    host.send('in-flight', { kind: 'query', sql: 'SELECT slow' });
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    host.send('queued', { kind: 'query', sql: 'SELECT queued' });

    host.signal('SIGINT');

    await vi.waitFor(() => {
      expect(responsesFor(host, 'queued')).toEqual([
        expect.objectContaining({
          error: expect.objectContaining({ message: 'DB host is closing (SIGINT).' }),
          ok: false,
        }),
      ]);
    });
    // The close waits for the statement that is already running.
    expect(dbMainMocks.closeDatabase).not.toHaveBeenCalled();
    expect(host.exitCodes).toEqual([]);

    running.resolve({ rows: [{ done: true }] });

    await vi.waitFor(() => expect(host.exitCodes).toEqual([0]));
    expect(responsesFor(host, 'in-flight')).toEqual([
      expect.objectContaining({ ok: true, result: { rows: [{ done: true }] } }),
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(dbMainMocks.closeDatabase).toHaveBeenCalledTimes(1);
    // The normal close path (which writes the clean-shutdown marker) ran BEFORE the exit.
    expect(dbMainMocks.closeDatabase.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(process.exit).mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY
    );
    expect(lifecycleStates(host)).toEqual(['closing:SIGINT', 'closed:SIGINT']);
    expect(host.parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ lifecycle: 'serving' }),
        kind: 'log',
        level: 'warn',
        message: 'DB host received SIGINT',
      })
    );
  });

  it('unsubscribes live queries before closing on a signal', async () => {
    const unsubscribe = vi.fn(async () => undefined);
    dbMainMocks.getDatabase.mockResolvedValue({
      live: {
        query: vi.fn(async () => ({
          initialResults: { rows: [] },
          refresh: vi.fn(),
          subscribe: vi.fn(),
          unsubscribe,
        })),
      },
      query: vi.fn(async () => ({ rows: [] })),
    });
    const host = await bootHost();
    host.send('live', { kind: 'live:start', payload: { params: [], query: 'SELECT 1' } } as never);
    await vi.waitFor(() => expect(responsesFor(host, 'live')).toHaveLength(1));

    host.signal('SIGTERM');

    await vi.waitFor(() => expect(host.exitCodes).toEqual([0]));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(
      dbMainMocks.closeDatabase.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY
    );
  });

  it('a second signal while closing starts no second close', async () => {
    const closing = deferred();
    dbMainMocks.closeDatabase.mockReturnValue(closing.promise);
    const host = await bootHost();

    host.signal('SIGINT');
    await vi.waitFor(() => expect(dbMainMocks.closeDatabase).toHaveBeenCalledTimes(1));
    host.signal('SIGTERM');
    host.signal('SIGHUP');
    closing.resolve();

    await vi.waitFor(() => expect(host.exitCodes).toEqual([0]));
    expect(dbMainMocks.closeDatabase).toHaveBeenCalledTimes(1);
    expect(lifecycleStates(host)).toEqual(['closing:SIGINT', 'closed:SIGINT']);
  });

  it('answers a close envelope that arrives during a signal close exactly once', async () => {
    const running = deferred<{ rows: unknown[] }>();
    dbMainMocks.getDatabase.mockResolvedValue({ query: vi.fn(() => running.promise) });
    const host = await bootHost();
    host.send('in-flight', { kind: 'query', sql: 'SELECT slow' });
    await vi.waitFor(() => expect(dbMainMocks.getDatabase).toHaveBeenCalledTimes(1));

    host.signal('SIGINT');
    host.send('late-close', { kind: 'close' });
    expect(responsesFor(host, 'late-close')).toEqual([]);
    running.resolve({ rows: [] });

    await vi.waitFor(() => expect(host.exitCodes).toEqual([0]));
    expect(responsesFor(host, 'late-close')).toEqual([
      expect.objectContaining({ ok: true, result: { closed: true } }),
    ]);
    expect(dbMainMocks.closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('answers a close envelope that was already queued when the signal arrived exactly once', async () => {
    const running = deferred<{ rows: unknown[] }>();
    dbMainMocks.getDatabase.mockResolvedValue({ query: vi.fn(() => running.promise) });
    const host = await bootHost();
    host.send('in-flight', { kind: 'query', sql: 'SELECT slow' });
    await vi.waitFor(() => expect(dbMainMocks.getDatabase).toHaveBeenCalledTimes(1));
    host.send('queued-close', { kind: 'close' });

    host.signal('SIGTERM');
    running.resolve({ rows: [] });

    await vi.waitFor(() => expect(host.exitCodes).toEqual([0]));
    expect(responsesFor(host, 'queued-close')).toHaveLength(1);
    expect(responsesFor(host, 'queued-close')[0]).toMatchObject({ ok: true });
    expect(dbMainMocks.closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('answers diagnostics while a close is pending', async () => {
    const running = deferred<{ rows: unknown[] }>();
    dbMainMocks.getDatabase.mockResolvedValue({ query: vi.fn(() => running.promise) });
    const host = await bootHost();
    host.send('in-flight', { kind: 'query', sql: 'SELECT slow' });
    await vi.waitFor(() => expect(dbMainMocks.getDatabase).toHaveBeenCalledTimes(1));

    host.signal('SIGINT');
    host.send('diagnostics', { kind: 'diagnostics' });

    await vi.waitFor(() => expect(responsesFor(host, 'diagnostics')).toHaveLength(1));
    expect(responsesFor(host, 'diagnostics')[0]).toMatchObject({
      ok: true,
      result: { activeLiveQueryCount: 0, hasDatabaseHandle: true },
    });
    running.resolve({ rows: [] });
    await vi.waitFor(() => expect(host.exitCodes).toEqual([0]));
  });

  it('a main-driven close responds and does not exit; a later SIGTERM then exits 0', async () => {
    const host = await bootHost();

    host.send('close', { kind: 'close' });

    await vi.waitFor(() => expect(responsesFor(host, 'close')).toHaveLength(1));
    expect(responsesFor(host, 'close')[0]).toMatchObject({ ok: true, result: { closed: true } });
    expect(host.exitCodes).toEqual([]);
    expect(lifecycleStates(host)).toEqual(['closing:request', 'closed:request']);

    host.signal('SIGTERM');

    expect(host.exitCodes).toEqual([0]);
    expect(dbMainMocks.closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('a SIGTERM during a main-driven close makes the host exit 0 once the close succeeds', async () => {
    const closing = deferred();
    dbMainMocks.closeDatabase.mockReturnValue(closing.promise);
    const host = await bootHost();
    host.send('close', { kind: 'close' });
    await vi.waitFor(() => expect(dbMainMocks.closeDatabase).toHaveBeenCalledTimes(1));

    host.signal('SIGTERM');
    expect(host.exitCodes).toEqual([]);
    closing.resolve();

    await vi.waitFor(() => expect(host.exitCodes).toEqual([0]));
    expect(dbMainMocks.closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('a failed signal close is reported loudly and exits 1, never 0', async () => {
    dbMainMocks.closeDatabase.mockRejectedValue(new Error('checkpoint failed'));
    const host = await bootHost();

    host.signal('SIGTERM');

    await vi.waitFor(() => expect(host.exitCodes).toEqual([1]));
    expect(posted(host)).toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'checkpoint failed' }),
        kind: 'lifecycle',
        reason: 'SIGTERM',
        state: 'close-failed',
      })
    );
    expect(posted(host)).toContainEqual(
      expect.objectContaining({
        kind: 'log',
        level: 'error',
        message: 'DB host failed to close the database',
      })
    );
    // A later signal cannot turn a failed close into a clean exit.
    host.signal('SIGINT');
    expect(host.exitCodes).toEqual([1, 1]);
    expect(dbMainMocks.closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('a failed main-driven close answers with the error and a later SIGTERM exits 1', async () => {
    dbMainMocks.closeDatabase.mockRejectedValue(new Error('checkpoint failed'));
    const host = await bootHost();

    host.send('close', { kind: 'close' });

    await vi.waitFor(() => expect(responsesFor(host, 'close')).toHaveLength(1));
    expect(responsesFor(host, 'close')[0]).toMatchObject({
      error: { message: 'checkpoint failed' },
      ok: false,
    });
    expect(host.exitCodes).toEqual([]);
    host.signal('SIGTERM');
    expect(host.exitCodes).toEqual([1]);
  });

  it.each([
    ['closing', 'DB host is closing (SIGINT).'],
    ['closed', 'DB host is closed (SIGINT).'],
  ] as const)(
    'rejects a data envelope while %s and never touches the database',
    async (phase, message) => {
      const closing = deferred();
      dbMainMocks.closeDatabase.mockReturnValue(closing.promise);
      const host = await bootHost();

      host.signal('SIGINT');
      await vi.waitFor(() => expect(dbMainMocks.closeDatabase).toHaveBeenCalledTimes(1));
      if (phase === 'closed') {
        closing.resolve();
        await vi.waitFor(() => expect(host.exitCodes).toEqual([0]));
      }
      host.send('late', { kind: 'query', sql: 'SELECT 1' });

      await vi.waitFor(() => expect(responsesFor(host, 'late')).toHaveLength(1));
      expect(responsesFor(host, 'late')[0]).toMatchObject({
        error: { message },
        ok: false,
      });
      // Before this change a request queued behind `close` lazily re-opened the database.
      expect(dbMainMocks.getDatabase).not.toHaveBeenCalled();
      closing.resolve();
    }
  );
});
