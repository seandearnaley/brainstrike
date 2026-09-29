import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  DB_HOST_CLOSE_ACK_TIMEOUT_MS,
  DB_HOST_CLOSE_BUDGET_MS,
  DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS,
  DB_HOST_EXIT_AFTER_TERM_TIMEOUT_MS,
} from '../../db-host-close-budget';

interface PostedMessage {
  readonly id: string;
  readonly request: { readonly kind: string };
}

// SIGTERM (`kill`) does nothing by default: each test decides when, and with what code, the host exits.
class FakeUtilityProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly messages: PostedMessage[] = [];
  readonly postMessage = vi.fn((message: PostedMessage) => {
    this.messages.push(message);
  });
  pid: number | undefined = 42;

  reply(message: PostedMessage, result: unknown): void {
    this.emit('message', { id: message.id, kind: 'response', ok: true, result });
  }

  reject(message: PostedMessage, error: string): void {
    this.emit('message', {
      error: { message: error },
      id: message.id,
      kind: 'response',
      ok: false,
    });
  }
}

const forkMock = vi.hoisted(() => vi.fn());
const loggerErrorMock = vi.hoisted(() => vi.fn());
const loggerWarnMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', isPackaged: false },
  utilityProcess: { fork: forkMock },
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: loggerErrorMock,
      fatal: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: loggerWarnMock,
    }),
  };
});

function latestProcess(): FakeUtilityProcess {
  const host = forkMock.mock.results.at(-1)?.value;
  if (!(host instanceof FakeUtilityProcess)) {
    throw new Error('Expected fake utility process to be forked.');
  }
  return host;
}

function lastMessage(host: FakeUtilityProcess, kind: string): PostedMessage {
  const message = host.messages.at(-1);
  expect(message?.request.kind).toBe(kind);
  return message as PostedMessage;
}

/** Observes a promise without leaving its rejection unhandled: `outcome` is 'resolved' or the error. */
function observe(promise: Promise<unknown>): {
  readonly outcome: Promise<unknown>;
  readonly settled: () => boolean;
} {
  let done = false;
  const outcome = promise
    .then(
      () => 'resolved' as const,
      (error: unknown) => error
    )
    .then((value) => {
      done = true;
      return value;
    });
  return { outcome, settled: () => done };
}

async function openManager(options: { readonly requestTimeoutMs?: number } = {}) {
  const { createDbHostManager } = await import('../../db-host-manager');
  const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js', ...options });
  const opening = manager.getDatabase();
  const host = latestProcess();
  host.reply(lastMessage(host, 'init'), { initialized: true });
  return { database: await opening, host, manager };
}

describe('DbHostManager close ladder', () => {
  let killSpy: MockInstance<typeof process.kill>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    forkMock.mockReset().mockImplementation(() => new FakeUtilityProcess());
    loggerErrorMock.mockReset();
    loggerWarnMock.mockReset();
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
    vi.useRealTimers();
  });

  it('budgets the whole ladder as the sum of its rungs', () => {
    expect(DB_HOST_CLOSE_BUDGET_MS).toBe(
      DB_HOST_CLOSE_ACK_TIMEOUT_MS +
        DB_HOST_EXIT_AFTER_TERM_TIMEOUT_MS +
        DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS
    );
  });

  describe('close acknowledged', () => {
    it('stays pending until the host exits after SIGTERM, whatever the exit code', async () => {
      const { host, manager } = await openManager();
      const closing = observe(manager.close());
      host.reply(lastMessage(host, 'close'), { closed: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(host.kill).toHaveBeenCalledTimes(1);
      expect(closing.settled()).toBe(false);

      host.emit('exit', 15);
      expect(await closing.outcome).toBe('resolved');
      expect(killSpy).not.toHaveBeenCalled();
    });

    it('shares one close, and one close envelope, between concurrent callers', async () => {
      const { host, manager } = await openManager();
      const first = observe(manager.close());
      const second = observe(manager.close());
      host.reply(lastMessage(host, 'close'), { closed: true });
      await vi.advanceTimersByTimeAsync(0);
      host.emit('exit', 0);

      expect([await first.outcome, await second.outcome]).toEqual(['resolved', 'resolved']);
      expect(host.messages.filter((message) => message.request.kind === 'close')).toHaveLength(1);
    });

    it('escalates to SIGKILL when the host ignores SIGTERM, and still counts the close as clean', async () => {
      const { host, manager } = await openManager();
      const closing = observe(manager.close());
      host.reply(lastMessage(host, 'close'), { closed: true });
      await vi.advanceTimersByTimeAsync(DB_HOST_EXIT_AFTER_TERM_TIMEOUT_MS);

      expect(killSpy).toHaveBeenCalledWith(42, 'SIGKILL');
      host.emit('exit', 137);
      expect(await closing.outcome).toBe('resolved');
      expect(loggerErrorMock).toHaveBeenCalledWith(
        'DB host terminated with SIGKILL',
        expect.objectContaining({ exitCode: 137, reason: 'exit-after-close-timeout' })
      );
    });

    it('rejects exit-timeout when the host survives SIGKILL', async () => {
      const { host, manager } = await openManager();
      const closing = observe(manager.close());
      host.reply(lastMessage(host, 'close'), { closed: true });
      await vi.advanceTimersByTimeAsync(
        DB_HOST_EXIT_AFTER_TERM_TIMEOUT_MS + DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS
      );

      expect(await closing.outcome).toMatchObject({
        name: 'DbHostCloseError',
        outcome: 'exit-timeout',
      });
    });

    it('rejects pending requests and forks no replacement until the exit is observed', async () => {
      const { host, manager } = await openManager();
      const pending = observe(manager.getDiagnostics());
      const closing = observe(manager.close());
      host.reply(lastMessage(host, 'close'), { closed: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(await pending.outcome).toMatchObject({ message: 'DB host closed.' });

      const next = manager.getDiagnostics();
      await vi.advanceTimersByTimeAsync(0);
      expect(forkMock).toHaveBeenCalledTimes(1);

      host.emit('exit', 0);
      expect(await closing.outcome).toBe('resolved');
      await vi.advanceTimersByTimeAsync(0);
      expect(forkMock).toHaveBeenCalledTimes(2);
      latestProcess().reply(lastMessage(latestProcess(), 'diagnostics'), {});
      await expect(next).resolves.toBeDefined();
    });
  });

  describe('close acknowledgement times out', () => {
    // Measured with Electron 44.4.5 on macOS: `child.kill()` ends a utility process that has no
    // signal handler with exit code 0 (SIGHUP also 0; SIGTERM 15, SIGINT 2, SIGKILL 9). An exit
    // code, 0 included, is therefore never proof that the database closed.
    it.each([0, 15])(
      'asks the host to close with SIGTERM and rejects exited-unclean when it exits with code %i',
      async (code) => {
        const { host, manager } = await openManager();
        const closing = observe(manager.close());
        await vi.advanceTimersByTimeAsync(DB_HOST_CLOSE_ACK_TIMEOUT_MS);

        expect(loggerWarnMock).toHaveBeenCalledWith(
          'DB host close acknowledgement timed out; asking the host to close now',
          { timeoutMs: DB_HOST_CLOSE_ACK_TIMEOUT_MS }
        );
        expect(host.kill).toHaveBeenCalledTimes(1);
        host.emit('exit', code);

        expect(await closing.outcome).toMatchObject({
          exitCode: code,
          name: 'DbHostCloseError',
          outcome: 'exited-unclean',
        });
        expect(killSpy).not.toHaveBeenCalled();
      }
    );

    it('SIGKILLs a host that ignores SIGTERM and rejects killed once it is gone', async () => {
      const { host, manager } = await openManager();
      const closing = observe(manager.close());
      await vi.advanceTimersByTimeAsync(
        DB_HOST_CLOSE_ACK_TIMEOUT_MS + DB_HOST_EXIT_AFTER_TERM_TIMEOUT_MS
      );
      expect(killSpy).toHaveBeenCalledWith(42, 'SIGKILL');
      host.emit('exit', 137);

      expect(await closing.outcome).toMatchObject({ name: 'DbHostCloseError', outcome: 'killed' });
    });
  });

  describe('close fails or the host exits first', () => {
    it('SIGKILLs at once when the host reports the close failed, and rejects close-failed', async () => {
      const { host, manager } = await openManager();
      const closing = observe(manager.close());
      host.reject(lastMessage(host, 'close'), 'checkpoint failed');
      await vi.advanceTimersByTimeAsync(0);

      expect(killSpy).toHaveBeenCalledWith(42, 'SIGKILL');
      expect(host.kill).not.toHaveBeenCalled();
      host.emit('exit', 137);

      expect(await closing.outcome).toMatchObject({
        cause: expect.objectContaining({ message: 'checkpoint failed' }),
        name: 'DbHostCloseError',
        outcome: 'close-failed',
      });
    });

    // Same measured Electron behaviour: an exit with code 0 that did not acknowledge is NOT clean.
    it.each([0, 1])(
      'rejects exited-unclean for an exit with code %i before the acknowledgement, without any signal',
      async (code) => {
        const { host, manager } = await openManager();
        const closing = observe(manager.close());
        host.emit('exit', code);

        expect(await closing.outcome).toMatchObject({
          exitCode: code,
          name: 'DbHostCloseError',
          outcome: 'exited-unclean',
        });
        expect(killSpy).not.toHaveBeenCalled();
        expect(host.kill).not.toHaveBeenCalled();
      }
    );

    it('still clears the default manager when its close fails', async () => {
      const { closeDbHostManager, getDbHostManager } = await import('../../db-host-manager');
      const { DbHostCloseError } = await import('../../db-host-lifecycle-errors');
      const manager = getDbHostManager();
      const diagnostics = manager.getDiagnostics();
      const host = latestProcess();
      host.reply(lastMessage(host, 'diagnostics'), {});
      await diagnostics;

      const closing = observe(closeDbHostManager());
      host.reject(lastMessage(host, 'close'), 'boom');
      await vi.advanceTimersByTimeAsync(0);
      host.emit('exit', 137);

      expect(await closing.outcome).toBeInstanceOf(DbHostCloseError);
      expect(getDbHostManager()).not.toBe(manager);
    });

    it('leaves the SIGKILL to the close ladder when a transaction times out mid-close', async () => {
      const { database, host, manager } = await openManager({ requestTimeoutMs: 5 });
      const transaction = observe(database.transaction(async () => 'unreachable'));
      const closing = observe(manager.close());
      await vi.advanceTimersByTimeAsync(5);

      expect(await transaction.outcome).toMatchObject({ name: 'DbHostRequestTimeoutError' });
      // The timeout rejected every in-flight request, the close included: the ladder owns the
      // host and SIGKILLs it exactly once.
      expect(killSpy).toHaveBeenCalledTimes(1);
      host.emit('exit', 137);
      expect(await closing.outcome).toMatchObject({
        name: 'DbHostCloseError',
        outcome: 'close-failed',
      });
    });
  });

  describe('no fork once shutdown begins', () => {
    it('rejects with DbHostUnavailableError instead of forking a host', async () => {
      const { markDesktopShuttingDown } = await import('../../desktop-shutdown-state');
      const { DbHostUnavailableError } = await import('../../db-host-lifecycle-errors');
      const { createDbHostManager } = await import('../../db-host-manager');
      const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });
      markDesktopShuttingDown();

      const error = await manager.getDiagnostics().then(
        () => null,
        (rejection: unknown) => rejection
      );

      expect(error).toBeInstanceOf(DbHostUnavailableError);
      expect((error as Error).message).toBe(
        'DB host is unavailable: the application is shutting down.'
      );
      expect(forkMock).not.toHaveBeenCalled();
      await expect(manager.close()).resolves.toBeUndefined();
    });

    it('lets a host that already exists finish its shutdown-time work and close', async () => {
      const { markDesktopShuttingDown } = await import('../../desktop-shutdown-state');
      const { host, manager } = await openManager();
      markDesktopShuttingDown();

      const diagnostics = manager.getDiagnostics();
      host.reply(lastMessage(host, 'diagnostics'), {});
      await expect(diagnostics).resolves.toBeDefined();

      const closing = observe(manager.close());
      host.reply(lastMessage(host, 'close'), { closed: true });
      await vi.advanceTimersByTimeAsync(0);
      host.emit('exit', 0);
      expect(await closing.outcome).toBe('resolved');
      expect(forkMock).toHaveBeenCalledTimes(1);
    });
  });
});
