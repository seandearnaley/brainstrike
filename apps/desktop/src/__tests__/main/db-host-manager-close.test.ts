import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  const originalDbRootPath = process.env['BRAINSTRIKE_DB_ROOT_PATH'];
  let appDataDir: string;
  let killSpy: MockInstance<typeof process.kill>;

  // The profile directory the manager reads the clean-shutdown marker from (db-main's app data path).
  const seedMarker = async (contents: { readonly pid: number }): Promise<void> => {
    const { writeCleanShutdownMarker } = await import('../../db-clean-shutdown-marker');
    writeCleanShutdownMarker(appDataDir, { closedAt: '2026-09-29T00:00:00.000Z', ...contents });
  };

  // A real host's `pid` is undefined once it has exited: the proof must use the pid seen at close.
  const exitHost = (host: FakeUtilityProcess, code: number): void => {
    host.pid = undefined;
    host.emit('exit', code);
  };

  beforeEach(() => {
    const rootPath = mkdtempSync(path.join(tmpdir(), 'brainstrike-db-host-close-'));
    appDataDir = path.join(rootPath, 'profiles', 'test');
    mkdirSync(appDataDir, { recursive: true });
    process.env['BRAINSTRIKE_DB_ROOT_PATH'] = rootPath;
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
    rmSync(path.dirname(path.dirname(appDataDir)), { force: true, recursive: true });
    if (originalDbRootPath === undefined) {
      Reflect.deleteProperty(process.env, 'BRAINSTRIKE_DB_ROOT_PATH');
    } else {
      process.env['BRAINSTRIKE_DB_ROOT_PATH'] = originalDbRootPath;
    }
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

    it('rejects pending requests and requests issued while the close runs, and forks nothing until it settles', async () => {
      const { host, manager } = await openManager();
      const pending = observe(manager.getDiagnostics());
      const closing = observe(manager.close());
      // Issued during the acknowledgement wait: the host must never see it.
      const duringAck = observe(manager.getDiagnostics());
      await vi.advanceTimersByTimeAsync(0);
      expect(duringAck.settled()).toBe(true);
      expect(await duringAck.outcome).toMatchObject({
        message: 'DB host is unavailable: the database is closing.',
        name: 'DbHostUnavailableError',
      });
      expect(host.messages.map((message) => message.request.kind)).toEqual([
        'init',
        'diagnostics',
        'close',
      ]);

      host.reply(lastMessage(host, 'close'), { closed: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(await pending.outcome).toMatchObject({ message: 'DB host closed.' });

      // Detached, exit not yet observed: still closing, so still rejected, still no fork.
      const afterDetach = observe(manager.getDiagnostics());
      await vi.advanceTimersByTimeAsync(0);
      expect(afterDetach.settled()).toBe(true);
      expect(await afterDetach.outcome).toMatchObject({ name: 'DbHostUnavailableError' });
      expect(forkMock).toHaveBeenCalledTimes(1);

      host.emit('exit', 0);
      expect(await closing.outcome).toBe('resolved');
      const next = manager.getDiagnostics();
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

  describe('the clean-shutdown marker proves a close the host did not acknowledge', () => {
    it('accepts an exit before the acknowledgement when the marker names the host pid', async () => {
      const { host, manager } = await openManager();
      await seedMarker({ pid: 42 });
      const closing = observe(manager.close());
      exitHost(host, 0);

      expect(await closing.outcome).toBe('resolved');
      expect(killSpy).not.toHaveBeenCalled();
    });

    it('accepts an exit after SIGTERM when the acknowledgement timed out and the marker names the host pid', async () => {
      const { host, manager } = await openManager();
      const closing = observe(manager.close());
      await vi.advanceTimersByTimeAsync(DB_HOST_CLOSE_ACK_TIMEOUT_MS);
      await seedMarker({ pid: 42 });
      exitHost(host, 0);

      expect(await closing.outcome).toBe('resolved');
      expect(host.kill).toHaveBeenCalledTimes(1);
      expect(killSpy).not.toHaveBeenCalled();
    });

    it('accepts an exit after SIGKILL when the marker shows the close had already completed', async () => {
      const { host, manager } = await openManager();
      const closing = observe(manager.close());
      await vi.advanceTimersByTimeAsync(
        DB_HOST_CLOSE_ACK_TIMEOUT_MS + DB_HOST_EXIT_AFTER_TERM_TIMEOUT_MS
      );
      expect(killSpy).toHaveBeenCalledWith(42, 'SIGKILL');
      await seedMarker({ pid: 42 });
      exitHost(host, 137);

      expect(await closing.outcome).toBe('resolved');
    });

    it.each([
      { name: 'there is no marker', seed: async () => undefined },
      { name: 'the marker names another pid', seed: async () => await seedMarker({ pid: 4242 }) },
      {
        name: 'the marker is unreadable',
        seed: async () => writeFileSync(path.join(appDataDir, '.db-clean-shutdown'), '{'),
      },
    ])('rejects exited-unclean when $name, even with exit code 0', async ({ seed }) => {
      const { host, manager } = await openManager();
      const closing = observe(manager.close());
      await seed();
      exitHost(host, 0);

      expect(await closing.outcome).toMatchObject({
        exitCode: 0,
        name: 'DbHostCloseError',
        outcome: 'exited-unclean',
      });
    });

    it('logs an unreadable marker and treats the close as unproven', async () => {
      const { host, manager } = await openManager();
      writeFileSync(path.join(appDataDir, '.db-clean-shutdown'), '{');
      const closing = observe(manager.close());
      exitHost(host, 0);

      await closing.outcome;
      expect(loggerErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Could not read the clean-shutdown marker; treating the close as unproven'
      );
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

    it('replaces the default manager once its failed close has seen the host exit', async () => {
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

  // The only proof a host is gone is its observed `exit`. A kill that throws, or is not followed by
  // an exit, leaves a barrier: nothing forks while it stands, and nothing waits on it unbounded.
  describe('no fork while a previous host may still be alive', () => {
    const eperm = (): Error => Object.assign(new Error('kill EPERM'), { code: 'EPERM' });

    /** The close ladder ends with SIGKILL refused (EPERM): the host may still own the database. */
    async function closeWhereSigkillIsRefused() {
      const opened = await openManager();
      killSpy.mockImplementation(() => {
        throw eperm();
      });
      const closing = observe(opened.manager.close());
      await vi.advanceTimersByTimeAsync(
        DB_HOST_CLOSE_ACK_TIMEOUT_MS + DB_HOST_EXIT_AFTER_TERM_TIMEOUT_MS
      );
      return { ...opened, closing };
    }

    /** A transaction times out; `sigkill` decides whether SIGKILL is accepted or refused. The host never exits. */
    async function wedgeWhereHostSurvivesSigkill(sigkill: 'accepted' | 'refused') {
      const opened = await openManager({ requestTimeoutMs: 5 });
      if (sigkill === 'refused') {
        killSpy.mockImplementation(() => {
          throw eperm();
        });
      }
      const transaction = observe(opened.database.transaction(async () => 'unreachable'));
      await vi.advanceTimersByTimeAsync(5);
      expect(await transaction.outcome).toMatchObject({ name: 'DbHostRequestTimeoutError' });
      // Past the wait for the exit after SIGKILL: nothing else is left to await.
      await vi.advanceTimersByTimeAsync(DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS);
      return opened;
    }

    /** No request forks; each rejects, in bounded time, until the exit is observed; then exactly one host forks. */
    async function expectNoForkUntilExit(
      manager: Awaited<ReturnType<typeof openManager>>['manager'],
      host: FakeUtilityProcess
    ): Promise<void> {
      const forksBefore = forkMock.mock.calls.length;
      const send = observe(manager.getDiagnostics());
      const open = observe(manager.getDatabase());
      await vi.advanceTimersByTimeAsync(DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS);
      expect(send.settled()).toBe(true);
      expect(open.settled()).toBe(true);
      const unavailable = {
        message:
          'DB host is unavailable: the previous host has not exited and may still own the database.',
        name: 'DbHostUnavailableError',
      };
      expect(await send.outcome).toMatchObject(unavailable);
      expect(await open.outcome).toMatchObject(unavailable);
      expect(forkMock).toHaveBeenCalledTimes(forksBefore);

      host.emit('exit', 9);
      await vi.advanceTimersByTimeAsync(0);
      const next = manager.getDiagnostics();
      await vi.advanceTimersByTimeAsync(0);
      expect(forkMock).toHaveBeenCalledTimes(forksBefore + 1);
      latestProcess().reply(lastMessage(latestProcess(), 'diagnostics'), {});
      await expect(next).resolves.toBeDefined();
    }

    it('rejects exit-timeout, not the raw errno, when SIGKILL is refused during a close', async () => {
      const { closing } = await closeWhereSigkillIsRefused();

      expect(await closing.outcome).toMatchObject({
        name: 'DbHostCloseError',
        outcome: 'exit-timeout',
      });
      expect(loggerErrorMock).toHaveBeenCalledWith(
        'DB host SIGKILL failed',
        expect.objectContaining({ err: expect.objectContaining({ code: 'EPERM' }) })
      );
    });

    it('holds the barrier after a close whose SIGKILL was refused, until the host exits', async () => {
      const { closing, host, manager } = await closeWhereSigkillIsRefused();
      await closing.outcome;

      await expectNoForkUntilExit(manager, host);
    });

    it('holds the barrier when a wedge SIGKILL is accepted but no exit follows', async () => {
      const { host, manager } = await wedgeWhereHostSurvivesSigkill('accepted');

      await expectNoForkUntilExit(manager, host);
    });

    it('holds the barrier, and logs the failure, when a wedge SIGKILL is refused', async () => {
      const { host, manager } = await wedgeWhereHostSurvivesSigkill('refused');

      expect(loggerErrorMock).toHaveBeenCalledWith(
        'DB host SIGKILL failed',
        expect.objectContaining({
          err: expect.objectContaining({ code: 'EPERM' }),
          reason: 'request-timeout',
        })
      );
      await expectNoForkUntilExit(manager, host);
    });

    it('holds the barrier when the host outlives a close that timed out on SIGKILL', async () => {
      const { host, manager } = await openManager();
      const closing = observe(manager.close());
      host.reply(lastMessage(host, 'close'), { closed: true });
      await vi.advanceTimersByTimeAsync(
        DB_HOST_EXIT_AFTER_TERM_TIMEOUT_MS + DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS
      );
      expect(await closing.outcome).toMatchObject({ outcome: 'exit-timeout' });

      await expectNoForkUntilExit(manager, host);
    });

    it('rejects a request waiting on the barrier when the manager retires, and forks nothing', async () => {
      const { closeDbHostManager, getDbHostManager } = await import('../../db-host-manager');
      const manager = getDbHostManager();
      const opening = manager.getDatabase();
      const host = latestProcess();
      host.reply(lastMessage(host, 'init'), { initialized: true });
      const database = await opening;
      const transaction = observe(database.transaction(async () => 'unreachable'));
      // The default manager's request deadline: the transaction times out and the host is SIGKILLed.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await transaction.outcome).toMatchObject({ name: 'DbHostRequestTimeoutError' });

      const waiting = observe(manager.getDiagnostics());
      await vi.advanceTimersByTimeAsync(0);
      const retiring = observe(closeDbHostManager());
      host.emit('exit', 9);
      await vi.advanceTimersByTimeAsync(0);

      expect(waiting.settled()).toBe(true);
      expect(await waiting.outcome).toMatchObject({ message: 'DB host manager is retired.' });
      expect(forkMock).toHaveBeenCalledTimes(1);
      expect(await retiring.outcome).toBe('resolved');
    });

    it('never reports a repeated close as success while the host may still be alive', async () => {
      const { closing, host, manager } = await closeWhereSigkillIsRefused();
      expect(await closing.outcome).toMatchObject({ outcome: 'exit-timeout' });

      const repeated = observe(manager.close());
      await vi.advanceTimersByTimeAsync(DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS);
      expect(repeated.settled()).toBe(true);
      expect(await repeated.outcome).toMatchObject({
        name: 'DbHostCloseError',
        outcome: 'exit-timeout',
      });

      const afterExit = observe(manager.close());
      host.emit('exit', 9);
      expect(await afterExit.outcome).toBe('resolved');
    });
  });

  // `closeDbHostManager()` retires the default manager and, when it succeeds, drops it. A close that
  // fails while the host may still be alive must not let a fresh manager fork over that host.
  describe('a default manager whose close failed while its host may still be alive', () => {
    async function failTheDefaultManagerClose() {
      const { closeDbHostManager, getDbHostManager } = await import('../../db-host-manager');
      const manager = getDbHostManager();
      const diagnostics = manager.getDiagnostics();
      const host = latestProcess();
      host.reply(lastMessage(host, 'diagnostics'), {});
      await diagnostics;
      const closing = observe(closeDbHostManager());
      host.reject(lastMessage(host, 'close'), 'boom');
      // SIGKILL is sent (a no-op here) and the host does not exit within the budget.
      await vi.advanceTimersByTimeAsync(DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS);
      expect(await closing.outcome).toMatchObject({
        name: 'DbHostCloseError',
        outcome: 'exit-timeout',
      });
      return { closeDbHostManager, getDbHostManager, host, manager };
    }

    it('is not replaced by a fresh manager, and forks nothing, until the host exits', async () => {
      const { getDbHostManager, host, manager } = await failTheDefaultManagerClose();

      expect(() => getDbHostManager()).toThrow(
        'DB host is unavailable: the previous host has not exited and may still own the database.'
      );
      expect(forkMock).toHaveBeenCalledTimes(1);

      host.emit('exit', 9);
      await vi.advanceTimersByTimeAsync(0);
      const next = getDbHostManager();
      expect(next).not.toBe(manager);
      const request = next.getDiagnostics();
      await vi.advanceTimersByTimeAsync(0);
      expect(forkMock).toHaveBeenCalledTimes(2);
      latestProcess().reply(lastMessage(latestProcess(), 'diagnostics'), {});
      await expect(request).resolves.toBeDefined();
    });

    it('rejects the refusal with DbHostUnavailableError', async () => {
      const { getDbHostManager } = await failTheDefaultManagerClose();
      const { DbHostUnavailableError } = await import('../../db-host-lifecycle-errors');

      expect(() => getDbHostManager()).toThrow(DbHostUnavailableError);
    });

    it('never reports a repeated close as success while the host may still be alive', async () => {
      const { closeDbHostManager, getDbHostManager, host } = await failTheDefaultManagerClose();

      const repeated = observe(closeDbHostManager());
      await vi.advanceTimersByTimeAsync(DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS);
      expect(repeated.settled()).toBe(true);
      expect(await repeated.outcome).toMatchObject({
        name: 'DbHostCloseError',
        outcome: 'exit-timeout',
      });

      const afterExit = observe(closeDbHostManager());
      host.emit('exit', 9);
      expect(await afterExit.outcome).toBe('resolved');
      expect(() => getDbHostManager()).not.toThrow();
    });
  });

  describe('DbHostProcess.forceKill', () => {
    it('sends no signal once the process has exited, so a reused pid is never killed', async () => {
      const { DbHostProcess } = await import('../../db-host-process');
      const handle = new FakeUtilityProcess();
      const hostProcess = new DbHostProcess(handle as never);
      handle.emit('exit', 0);

      hostProcess.forceKill();

      expect(killSpy).not.toHaveBeenCalled();
    });

    it('sends SIGKILL to the pid while the process is running', async () => {
      const { DbHostProcess } = await import('../../db-host-process');
      const hostProcess = new DbHostProcess(new FakeUtilityProcess() as never);

      hostProcess.forceKill();

      expect(killSpy).toHaveBeenCalledWith(42, 'SIGKILL');
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
