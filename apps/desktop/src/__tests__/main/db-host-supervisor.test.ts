import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS,
  DB_HOST_EXIT_AFTER_TERM_TIMEOUT_MS,
} from '../../db-host-close-budget';
import type { DbHostManager } from '../../db-host-manager';
import type { DbHostRequestEnvelope } from '../../db-host-protocol';

const fork = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', isPackaged: false },
  utilityProcess: { fork },
}));

class Host extends EventEmitter {
  readonly messages: DbHostRequestEnvelope[] = [];
  readonly pid = 4242;
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  });
  initError = false;
  holdQueries = false;
  readonly postMessage = (message: DbHostRequestEnvelope): void => {
    this.messages.push(message);
    if (message.request.kind === 'query' && this.holdQueries) {
      return;
    }
    queueMicrotask(() => {
      if (message.request.kind === 'init' && this.initError) {
        this.emit('message', {
          error: { code: 'XX001', message: 'Injected database integrity failure' },
          id: message.id,
          kind: 'response',
          ok: false,
        });
        return;
      }
      const result =
        message.request.kind === 'init'
          ? { initialized: true }
          : message.request.kind === 'close'
            ? { closed: true }
            : message.request.kind === 'diagnostics'
              ? { activeLiveQueryCount: 0, hasDatabaseHandle: !this.initError }
              : { rows: [] };
      this.emit('message', { id: message.id, kind: 'response', ok: true, result });
    });
  };
}

const managers: DbHostManager[] = [];
beforeEach(() => {
  vi.resetModules();
  fork.mockReset().mockImplementation(() => new Host());
});
afterEach(async () => {
  for (const result of fork.mock.results) {
    if (result.value instanceof Host) {
      const host = result.value;
      host.kill.mockImplementation(() => {
        queueMicrotask(() => host.emit('exit', 0));
        return true;
      });
    }
  }
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function manager(): Promise<DbHostManager> {
  const { createDbHostManager } = await import('../../db-host-manager');
  const value = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });
  managers.push(value);
  return value;
}
function currentHost(): Host {
  const value: unknown = fork.mock.results.at(-1)?.value;
  if (!(value instanceof Host)) {
    throw new Error('Expected an owned test utility');
  }
  return value;
}
async function outcome(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => null,
    (cause: unknown) => cause
  );
}

it('retains utility loss for passive database, retained-client and diagnostic demand without refork', async () => {
  const owner = await manager();
  const client = await owner.getDatabase();
  const host = currentHost();
  host.holdQueries = true;
  const pending = outcome(client.query('SELECT 1'));
  await vi.waitFor(() => expect(host.messages.at(-1)?.request.kind).toBe('query'));
  host.emit('exit', 9);
  const lost = await pending;
  expect(lost).toMatchObject({ code: 'process.lost' });
  const subsequent = await Promise.all([
    outcome(owner.getDatabase()),
    outcome(client.query('SELECT 2')),
    outcome(owner.getDiagnostics()),
  ]);
  expect(fork).toHaveBeenCalledTimes(1);
  expect(subsequent).toEqual([lost, lost, lost]);
});

it('retains initialization failure while diagnostics still read the same live failed process', async () => {
  fork.mockImplementation(() => {
    const host = new Host();
    host.initError = true;
    return host;
  });
  const owner = await manager();
  const failed = await outcome(owner.getDatabase());
  expect(failed).toMatchObject({ code: 'XX001' });
  const host = currentHost();
  await expect(owner.getDiagnostics()).resolves.toEqual({
    hasDatabaseHandle: false,
    hostPid: 4242,
    initStop: null,
  });
  expect(await outcome(owner.getDatabase())).toBe(failed);
  expect(host.messages.filter((message) => message.request.kind === 'init')).toHaveLength(1);
  expect(host.kill).not.toHaveBeenCalled();
  expect(fork).toHaveBeenCalledTimes(1);
});

it('posts admitted query before close and refuses subsequent query while preserving the close acknowledgement', async () => {
  const owner = await manager();
  const client = await owner.getDatabase();
  const host = currentHost();
  const first = client.query('SELECT 1');
  const closing = owner.close();
  const refused = outcome(client.query('SELECT 2'));
  await expect(first).resolves.toEqual({ rows: [] });
  await closing;
  expect(await refused).toBeInstanceOf(Error);
  expect(host.messages.map((message) => message.request.kind)).toEqual(['init', 'query', 'close']);
  expect(fork).toHaveBeenCalledTimes(1);
});

it('joins physical exit before explicit recovery and never moves a retained client onto the replacement', async () => {
  const owner = await manager();
  const oldClient = await owner.getDatabase();
  const host = currentHost();
  host.kill.mockImplementation(() => true);
  let recovered = false;
  const recovery = Promise.resolve(owner.retryInit({ noDeadline: false })).then(() => {
    recovered = true;
  });
  await vi.waitFor(() => expect(host.messages.at(-1)?.request.kind).toBe('close'));
  expect(recovered).toBe(false);
  expect(fork).toHaveBeenCalledTimes(1);
  host.emit('exit', 0);
  await recovery;
  expect(fork).toHaveBeenCalledTimes(2);
  const replacement = await owner.getDatabase();
  expect(replacement).not.toBe(oldClient);
  expect(await outcome(oldClient.query('SELECT 1'))).toBeInstanceOf(Error);
  await expect(replacement.query('SELECT 2')).resolves.toEqual({ rows: [] });
});

it('a repeated failed close only joins the already departing process at the existing exit rung', async () => {
  const owner = await manager();
  await owner.getDatabase();
  const host = currentHost();
  host.kill.mockImplementation(() => true);
  const forceKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  vi.useFakeTimers();
  try {
    const first = outcome(owner.close());
    await vi.advanceTimersByTimeAsync(
      DB_HOST_EXIT_AFTER_TERM_TIMEOUT_MS + DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS
    );
    expect(await first).toMatchObject({ outcome: 'exit-timeout' });
    let settled = false;
    const second = outcome(owner.close()).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS);
    const atExitRung = settled;
    host.emit('exit', 0);
    await second;
    expect(atExitRung).toBe(true);
    expect(host.messages.filter((message) => message.request.kind === 'close')).toHaveLength(1);
    expect(host.kill).toHaveBeenCalledTimes(1);
    expect(forceKill).toHaveBeenCalledTimes(1);
  } finally {
    host.emit('exit', 0);
    vi.useRealTimers();
  }
});

it('retains failed kill ownership and its close cause until late physical exit permits explicit recovery', async () => {
  const owner = await manager();
  const oldClient = await owner.getDatabase();
  const host = currentHost();
  host.kill.mockImplementation(() => true);
  const refusedKill = Object.assign(new Error('Injected utility kill refusal'), { code: 'EPERM' });
  const forceKill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw refusedKill;
  });
  vi.useFakeTimers();
  try {
    const closing = outcome(owner.close());
    await vi.advanceTimersByTimeAsync(DB_HOST_EXIT_AFTER_TERM_TIMEOUT_MS);
    const firstFailure = await closing;
    expect(firstFailure).toMatchObject({ outcome: 'exit-timeout' });
    const cleanup = outcome(owner.close());
    await vi.advanceTimersByTimeAsync(DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS);
    expect(await cleanup).toMatchObject({ cause: firstFailure, outcome: 'exit-timeout' });
    expect(fork).toHaveBeenCalledTimes(1);
    expect(host.kill).toHaveBeenCalledTimes(1);
    expect(forceKill).toHaveBeenCalledTimes(1);
    host.emit('exit', 9);
    await owner.retryInit({ noDeadline: false });
    expect(fork).toHaveBeenCalledTimes(2);
    expect(await outcome(oldClient.query('SELECT 1'))).toBeInstanceOf(Error);
    await expect((await owner.getDatabase()).query('SELECT 2')).resolves.toEqual({ rows: [] });
  } finally {
    host.emit('exit', 9);
    vi.useRealTimers();
  }
});

it('ignores an old physical process response even when it copies a current request ID', async () => {
  const owner = await manager();
  await owner.getDatabase();
  const oldHost = currentHost();
  oldHost.emit('exit', 9);
  await owner.retryInit({ noDeadline: false });
  const client = await owner.getDatabase();
  const host = currentHost();
  host.holdQueries = true;
  let settled = false;
  const query = client.query('SELECT 1').then((result) => {
    settled = true;
    return result;
  });
  const request = host.messages.at(-1);
  expect(request?.request.kind).toBe('query');
  const reply = { id: request?.id, kind: 'response', ok: true, result: { rows: [{ value: 1 }] } };
  oldHost.emit('message', reply);
  await Promise.resolve();
  expect(settled).toBe(false);
  host.emit('message', reply);
  await expect(query).resolves.toEqual({ rows: [{ value: 1 }] });
});
