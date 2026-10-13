import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DbHostRequestEnvelope } from '../../db-host-protocol';

class FakeUtilityProcess extends EventEmitter {
  readonly messages: DbHostRequestEnvelope[] = [];
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  });
  readonly pid = 4242;
  readonly postMessage = (message: DbHostRequestEnvelope): void => {
    this.messages.push(message);
  };
  reply(message: DbHostRequestEnvelope, result: unknown): void {
    this.emit('message', { id: message.id, kind: 'response', ok: true, result });
  }
  reject(message: DbHostRequestEnvelope, error: string): void {
    this.emit('message', {
      error: { message: error },
      id: message.id,
      kind: 'response',
      ok: false,
    });
  }
}

const forkMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', isPackaged: false },
  utilityProcess: { fork: forkMock },
}));

function latestProcess(): FakeUtilityProcess {
  const host: unknown = forkMock.mock.results.at(-1)?.value;
  if (!(host instanceof FakeUtilityProcess)) {
    throw new Error('Expected a fake utility process.');
  }
  return host;
}

async function waitForLastRequest(
  host: FakeUtilityProcess,
  kind: string
): Promise<DbHostRequestEnvelope> {
  await vi.waitFor(
    () => {
      expect(host.messages.at(-1)?.request.kind).toBe(kind);
    },
    { interval: 0 }
  );
  return host.messages.at(-1) as DbHostRequestEnvelope;
}

beforeEach(() => {
  vi.resetModules();
  forkMock.mockReset().mockImplementation(() => new FakeUtilityProcess());
});

afterEach(() => {
  vi.useRealTimers();
});

it('keeps the host alive when initialization rejects so diagnostics report the real failure', async () => {
  const { createDbHostManager } = await import('../../db-host-manager');
  const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

  const databasePromise = manager.getDatabase();
  await vi.waitFor(() => expect(forkMock).toHaveReturned(), { interval: 0 });
  const host = latestProcess();
  host.reject(await waitForLastRequest(host, 'init'), 'init failed');

  const failure = await databasePromise.catch((error: unknown) => error);
  expect(failure).toMatchObject({ message: 'init failed' });
  expect(host.kill).not.toHaveBeenCalled();

  // The failure record lives in the host process: a fresh fork would report none.
  const diagnosticsPromise = manager.getDiagnostics();
  host.reply(await waitForLastRequest(host, 'diagnostics'), {
    activeLiveQueryCount: 0,
    lastInitializationFailure: { category: 'corruption' },
  });
  await expect(diagnosticsPromise).resolves.toMatchObject({
    lastInitializationFailure: { category: 'corruption' },
  });

  await expect(manager.getDatabase()).rejects.toBe(failure);
  expect(host.messages.filter((message) => message.request.kind === 'init')).toHaveLength(1);
  const retryPromise = manager.retryInit({ noDeadline: false });
  host.reply(await waitForLastRequest(host, 'close'), { closed: true });
  await vi.waitFor(() => expect(forkMock).toHaveBeenCalledTimes(2), { interval: 0 });
  const replacement = latestProcess();
  replacement.reply(await waitForLastRequest(replacement, 'init'), { initialized: true });
  await retryPromise;
  await expect(manager.getDatabase()).resolves.toBeDefined();
  expect(host.kill).toHaveBeenCalledTimes(1);
});

it('terminates a timed-out initialization and requires explicit recovery before a fresh fork', async () => {
  vi.useFakeTimers();
  const { createDbHostManager, DbHostRequestTimeoutError } = await import('../../db-host-manager');
  const manager = createDbHostManager({
    entryPath: '/mock/db-host-entry.js',
    initializationTimeoutMs: 15,
  });

  const failure = manager.getDatabase().then(
    () => null,
    (error: unknown) => error
  );
  await vi.waitFor(() => expect(forkMock).toHaveReturned(), { interval: 0 });
  const wedgedHost = latestProcess();
  await waitForLastRequest(wedgedHost, 'init');
  const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  await vi.advanceTimersByTimeAsync(15);

  const original = await failure;
  expect(original).toBeInstanceOf(DbHostRequestTimeoutError);
  expect(killSpy).toHaveBeenCalledWith(wedgedHost.pid, 'SIGKILL');
  killSpy.mockRestore();

  await expect(manager.getDatabase()).rejects.toBe(original);
  wedgedHost.emit('exit', 137);
  await expect(manager.getDatabase()).rejects.toBe(original);
  expect(forkMock).toHaveBeenCalledTimes(1);
  const retryPromise = manager.retryInit({ noDeadline: false });
  await vi.waitFor(() => expect(forkMock).toHaveBeenCalledTimes(2), { interval: 0 });
  const freshHost = latestProcess();
  freshHost.reply(await waitForLastRequest(freshHost, 'init'), { initialized: true });
  await retryPromise;
  await expect(manager.getDatabase()).resolves.toBeDefined();
});
