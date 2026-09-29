import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DbHostRequestEnvelope } from '../../db-host-protocol';

class FakeUtilityProcess extends EventEmitter {
  readonly messages: DbHostRequestEnvelope[] = [];
  readonly kill = vi.fn(() => true);
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
  await vi.waitFor(() => {
    expect(host.messages.at(-1)?.request.kind).toBe(kind);
  });
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
  const host = latestProcess();
  host.reject(host.messages.at(-1) as DbHostRequestEnvelope, 'init failed');

  await expect(databasePromise).rejects.toThrow('init failed');
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

  // A later caller retries initialization on the same host.
  const retryPromise = manager.getDatabase();
  host.reply(await waitForLastRequest(host, 'init'), { initialized: true });
  await expect(retryPromise).resolves.toBeDefined();
  expect(forkMock).toHaveBeenCalledTimes(1);
  expect(host.kill).not.toHaveBeenCalled();
});

it('terminates a host whose initialization timed out and forks a fresh one next', async () => {
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
  const wedgedHost = latestProcess();
  const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  await vi.advanceTimersByTimeAsync(15);

  expect(await failure).toBeInstanceOf(DbHostRequestTimeoutError);
  expect(killSpy).toHaveBeenCalledWith(wedgedHost.pid, 'SIGKILL');
  killSpy.mockRestore();

  // A possibly wedged host must not serve the retry: the next call forks anew, once it is gone.
  const retryPromise = manager.getDatabase();
  wedgedHost.emit('exit', 137);
  await vi.advanceTimersByTimeAsync(0);
  expect(forkMock).toHaveBeenCalledTimes(2);
  const freshHost = latestProcess();
  freshHost.reply(freshHost.messages.at(-1) as DbHostRequestEnvelope, { initialized: true });
  await expect(retryPromise).resolves.toBeDefined();
});
