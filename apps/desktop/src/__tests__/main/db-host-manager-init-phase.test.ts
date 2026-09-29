import { EventEmitter } from 'node:events';
import type { DatabaseInitPhaseReport } from '@brainstrike/types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DbHostRequestEnvelope } from '../../db-host-protocol';

const MIB = 1024 * 1024;

// The incident database's rebuild: 131 MiB heap + 211 MiB toast = 342 MiB -> 30 s + 342 s budget.
const REBUILD_342_MIB: DatabaseInitPhaseReport = {
  index: {
    accessMethod: 'bm25',
    heapBytes: 131 * MIB,
    index: 'idx_file_chunks_content_bm25',
    indexBytes: 32 * MIB,
    schema: 'public',
    table: 'file_chunks',
    toastBytes: 211 * MIB,
  },
  phase: 'index-rebuild',
};
const REBUILD_BUDGET_MS = 372_000;

class FakeUtilityProcess extends EventEmitter {
  readonly messages: DbHostRequestEnvelope[] = [];
  readonly kill = vi.fn(() => true);
  readonly pid = 4242;
  readonly postMessage = (message: DbHostRequestEnvelope): void => {
    this.messages.push(message);
  };

  get initRequest(): DbHostRequestEnvelope {
    const request = this.messages.find((message) => message.request.kind === 'init');
    if (!request) {
      throw new Error('Expected an init request to have been posted.');
    }
    return request;
  }

  reply(message: DbHostRequestEnvelope, result: unknown): void {
    this.emit('message', { id: message.id, kind: 'response', ok: true, result });
  }

  progress(id: string, report: unknown): void {
    this.emit('message', { id, kind: 'progress', report });
  }
}

const forkMock = vi.hoisted(() => vi.fn());
const loggerErrorMock = vi.hoisted(() => vi.fn());
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
      warn: vi.fn(),
    }),
  };
});

function latestProcess(): FakeUtilityProcess {
  const host: unknown = forkMock.mock.results.at(-1)?.value;
  if (!(host instanceof FakeUtilityProcess)) {
    throw new Error('Expected a fake utility process.');
  }
  return host;
}

async function settled(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => null,
    (error: unknown) => error
  );
}

async function loadManager(options: {
  readonly initializationTimeoutMs: number;
  readonly requestTimeoutMs?: number;
}) {
  const module = await import('../../db-host-manager');
  return {
    DbHostRequestTimeoutError: module.DbHostRequestTimeoutError,
    manager: module.createDbHostManager({ entryPath: '/mock/db-host-entry.js', ...options }),
  };
}

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  loggerErrorMock.mockReset();
  forkMock.mockReset().mockImplementation(() => new FakeUtilityProcess());
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
  killSpy.mockRestore();
  vi.useRealTimers();
});

it('does not terminate a host whose index-rebuild phase outlives the initial deadline but not its budget', async () => {
  const { manager } = await loadManager({ initializationTimeoutMs: 15 });

  const database = manager.getDatabase();
  const host = latestProcess();
  await vi.advanceTimersByTimeAsync(10);
  host.progress(host.initRequest.id, REBUILD_342_MIB);

  // t=25: past the 15 ms first window, far inside the 372 s rebuild budget.
  await vi.advanceTimersByTimeAsync(15);
  expect(killSpy).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(75);
  host.reply(host.initRequest, { initialized: true });
  await expect(database).resolves.toBeDefined();
  expect(killSpy).not.toHaveBeenCalled();
  expect(loggerErrorMock).not.toHaveBeenCalled();
});

it('terminates the host when a phase exceeds its own budget and names the phase in the error', async () => {
  const { DbHostRequestTimeoutError, manager } = await loadManager({ initializationTimeoutMs: 15 });

  const failure = settled(manager.getDatabase());
  const host = latestProcess();
  await vi.advanceTimersByTimeAsync(10);
  host.progress(host.initRequest.id, REBUILD_342_MIB);

  await vi.advanceTimersByTimeAsync(REBUILD_BUDGET_MS - 1);
  expect(killSpy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);

  const error = await failure;
  expect(error).toBeInstanceOf(DbHostRequestTimeoutError);
  expect(error).toMatchObject({
    message:
      'DB host init timed out in phase index-rebuild (public.idx_file_chunks_content_bm25, 342 MiB table, budget 372 s)',
    phase: REBUILD_342_MIB,
    progressCount: 1,
    requestKind: 'init',
    timeoutMs: REBUILD_BUDGET_MS,
  });
  expect(killSpy).toHaveBeenCalledWith(host.pid, 'SIGKILL');
});

it('re-arms every report with the budget of its own phase, in order', async () => {
  const { DbHostRequestTimeoutError, manager } = await loadManager({ initializationTimeoutMs: 15 });

  const failure = settled(manager.getDatabase());
  const host = latestProcess();
  const id = host.initRequest.id;
  host.progress(id, { pgWalBytes: 912 * MIB, phase: 'open-database' });
  // 912 MiB of pg_wal at 4 MiB/s + the 30 s floor = 258 s; alive at 257 s.
  await vi.advanceTimersByTimeAsync(257_000);
  expect(killSpy).not.toHaveBeenCalled();

  // The migration report replaces that budget with the fixed 90 s, counted from ITS arrival.
  host.progress(id, { phase: 'migration' });
  await vi.advanceTimersByTimeAsync(89_999);
  expect(killSpy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);

  const error = await failure;
  expect(error).toBeInstanceOf(DbHostRequestTimeoutError);
  expect(error).toMatchObject({
    message: 'DB host init timed out in phase migration (budget 90 s)',
    phase: { phase: 'migration' },
    progressCount: 2,
    timeoutMs: 90_000,
  });
  expect(killSpy).toHaveBeenCalledWith(host.pid, 'SIGKILL');
});

it('names the open-database phase with its pg_wal size', async () => {
  const { manager } = await loadManager({ initializationTimeoutMs: 15 });

  const failure = settled(manager.getDatabase());
  const host = latestProcess();
  host.progress(host.initRequest.id, { pgWalBytes: 912 * MIB, phase: 'open-database' });
  await vi.advanceTimersByTimeAsync(258_000);

  expect(await failure).toMatchObject({
    message: 'DB host init timed out in phase open-database (pg_wal 912 MiB, budget 258 s)',
  });
});

it('ignores a malformed progress envelope and keeps the original deadline', async () => {
  const { DbHostRequestTimeoutError, manager } = await loadManager({ initializationTimeoutMs: 15 });

  const failure = settled(manager.getDatabase());
  const host = latestProcess();
  await vi.advanceTimersByTimeAsync(10);
  host.progress(host.initRequest.id, {
    index: { heapBytes: 'big' },
    phase: 'index-rebuild',
  });

  expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  expect(loggerErrorMock).toHaveBeenCalledWith(
    'Dropped malformed DB host progress envelope',
    expect.objectContaining({ message: expect.objectContaining({ kind: 'progress' }) })
  );
  // Not re-armed: the 15 ms window still ends at t=15, not t=25.
  await vi.advanceTimersByTimeAsync(5);
  const error = await failure;
  expect(error).toBeInstanceOf(DbHostRequestTimeoutError);
  expect(error).toMatchObject({
    message: 'DB host request timed out: init',
    phase: null,
    progressCount: 0,
    timeoutMs: 15,
  });
  expect(killSpy).toHaveBeenCalledWith(host.pid, 'SIGKILL');
});

it('ignores a progress envelope for a request that is not init', async () => {
  const { DbHostRequestTimeoutError, manager } = await loadManager({
    initializationTimeoutMs: 15,
    requestTimeoutMs: 20,
  });

  const failure = settled(manager.getDiagnostics());
  const host = latestProcess();
  const diagnostics = host.messages.at(-1);
  expect(diagnostics?.request.kind).toBe('diagnostics');
  await vi.advanceTimersByTimeAsync(10);
  host.progress(diagnostics?.id ?? '', REBUILD_342_MIB);

  expect(loggerErrorMock).toHaveBeenCalledWith(
    'Dropped DB host progress for a request that is not init',
    expect.objectContaining({ requestKind: 'diagnostics' })
  );
  // Not re-armed: the 20 ms window still ends at t=20.
  await vi.advanceTimersByTimeAsync(10);
  const error = await failure;
  expect(error).toBeInstanceOf(DbHostRequestTimeoutError);
  expect(error).toMatchObject({ phase: null, progressCount: 0, requestKind: 'diagnostics' });
});

it('does not let a fresh init attempt inherit the phase of the attempt that timed out', async () => {
  const { manager } = await loadManager({ initializationTimeoutMs: 15 });

  const firstFailure = settled(manager.getDatabase());
  const firstHost = latestProcess();
  firstHost.progress(firstHost.initRequest.id, REBUILD_342_MIB);
  await vi.advanceTimersByTimeAsync(REBUILD_BUDGET_MS);
  expect(await firstFailure).toMatchObject({ phase: REBUILD_342_MIB });

  const secondFailure = settled(manager.getDatabase());
  firstHost.emit('exit', 137);
  await vi.advanceTimersByTimeAsync(0);
  expect(forkMock).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(15);

  // The second host never reported: its timeout is the first-report window, with no phase.
  expect(await secondFailure).toMatchObject({
    message: 'DB host request timed out: init',
    phase: null,
    progressCount: 0,
    timeoutMs: 15,
  });
});
