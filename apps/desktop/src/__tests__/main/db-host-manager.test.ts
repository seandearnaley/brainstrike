import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface PostedMessage {
  readonly id: string;
  readonly kind: 'request';
  readonly request: {
    readonly kind: string;
    readonly params?: readonly unknown[];
    readonly payload?: {
      readonly params?: readonly unknown[] | null;
      readonly query?: string;
    };
    readonly sql?: string;
    readonly transactionId?: string;
  };
}

class FakeUtilityProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly postMessage = vi.fn((message: PostedMessage) => {
    this.messages.push(message);
  });
  readonly messages: PostedMessage[] = [];
  pid: number | undefined = 42;

  reply(message: PostedMessage, result: unknown): void {
    this.emit('message', {
      id: message.id,
      kind: 'response',
      ok: true,
      result,
    });
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
const appGetPathMock = vi.hoisted(() =>
  vi.fn((name: string) => (name === 'documents' ? '/mock/documents' : '/mock/userData'))
);
const loggerErrorMock = vi.hoisted(() => vi.fn());
const loggerInfoMock = vi.hoisted(() => vi.fn());
const loggerWarnMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: {
    getPath: appGetPathMock,
    isPackaged: false,
  },
  utilityProcess: {
    fork: forkMock,
  },
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: loggerErrorMock,
      fatal: vi.fn(),
      info: loggerInfoMock,
      trace: vi.fn(),
      warn: loggerWarnMock,
    }),
  };
});

function latestProcess(): FakeUtilityProcess {
  const utilityProcess = forkMock.mock.results.at(-1)?.value;
  if (!(utilityProcess instanceof FakeUtilityProcess)) {
    throw new Error('Expected fake utility process to be forked.');
  }
  return utilityProcess;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// Waited on rather than counted in ticks: dispatch depth is a request-layer detail.
async function waitForLastRequest(kind: string): Promise<PostedMessage> {
  await vi.waitFor(() => {
    expect(latestProcess().messages.at(-1)?.request.kind).toBe(kind);
  });
  return latestProcess().messages.at(-1) as PostedMessage;
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

describe('DbHostManager', () => {
  const originalNodeEnv = process.env['NODE_ENV'];
  const originalDbProfile = process.env['BRAINSTRIKE_DB_PROFILE'];
  const originalSerializePgliteInit = process.env['BRAINSTRIKE_SERIALIZE_PGLITE_INIT'];

  beforeEach(() => {
    vi.resetModules();
    appGetPathMock.mockClear();
    forkMock.mockReset();
    forkMock.mockImplementation(() => new FakeUtilityProcess());
    loggerErrorMock.mockReset();
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_DB_PROFILE');
    Reflect.deleteProperty(process.env, 'SECRET_TOKEN');
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_SERIALIZE_PGLITE_INIT');
  });

  afterEach(() => {
    restoreEnvValue('NODE_ENV', originalNodeEnv);
    restoreEnvValue('BRAINSTRIKE_DB_PROFILE', originalDbProfile);
    restoreEnvValue('BRAINSTRIKE_SERIALIZE_PGLITE_INIT', originalSerializePgliteInit);
  });

  it('starts the utility DB host once and routes query requests through it', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const databasePromise = manager.getDatabase();
    const initMessage = latestProcess().messages.at(-1);
    expect(initMessage?.request.kind).toBe('init');
    latestProcess().reply(initMessage as PostedMessage, { initialized: true });
    const database = await databasePromise;

    const queryPromise = database.query('SELECT $1::text AS value', ['ok']);
    const queryMessage = latestProcess().messages.at(-1);
    expect(queryMessage).toMatchObject({
      kind: 'request',
      request: {
        kind: 'query',
        params: ['ok'],
        sql: 'SELECT $1::text AS value',
      },
    });
    latestProcess().reply(queryMessage as PostedMessage, { rows: [{ value: 'ok' }] });

    await expect(queryPromise).resolves.toEqual({ rows: [{ value: 'ok' }] });
    expect(forkMock).toHaveBeenCalledTimes(1);
  });

  it('carries rowMode to the host and returns fields, inside a transaction', async () => {
    // The agent SQL sandbox runs its whole preamble and statement in ONE
    // transaction and needs array rows plus `fields` — PostgreSQL permits
    // duplicate output column names that object-keyed rows collapse.
    //
    // Before the protocol carried `rowMode`, this argument was accepted by the
    // type checker (bivariant method parameters), dropped silently here, and
    // every production self-query failed. This test is that seam.
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const databasePromise = manager.getDatabase();
    latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, { initialized: true });
    const database = await databasePromise;

    // Auto-respond as the host would: transaction:start acks with its id, the
    // array-mode query returns duplicate `id` fields, everything else acks empty.
    let answered = 0;
    const pump = setInterval(() => {
      const process_ = latestProcess();
      while (answered < process_.messages.length) {
        const message = process_.messages[answered];
        answered += 1;
        if (message === undefined) {
          continue;
        }
        if (message.request.kind === 'transaction:start') {
          process_.reply(message, { transactionId: message.request.transactionId });
        } else if (message.request.kind === 'transaction:query') {
          process_.reply(message, { fields: [{ name: 'id' }, { name: 'id' }], rows: [[1, 2]] });
        } else {
          process_.reply(message, {});
        }
      }
    }, 1);

    try {
      const result = await database.transaction(
        async (tx) => await tx.query('SELECT a.id, b.id', [], { rowMode: 'array' })
      );

      // Duplicate names survive intact — the whole reason array mode exists.
      expect(result).toEqual({ fields: [{ name: 'id' }, { name: 'id' }], rows: [[1, 2]] });
    } finally {
      clearInterval(pump);
    }

    const queryMessage = latestProcess().messages.find(
      (message) => message.request.kind === 'transaction:query'
    );
    expect(queryMessage?.request).toMatchObject({ rowMode: 'array', sql: 'SELECT a.id, b.id' });
  });

  it('omits rowMode when the caller does not ask for it', async () => {
    // Every existing caller must keep the default object-keyed shape.
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const databasePromise = manager.getDatabase();
    latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, { initialized: true });
    const database = await databasePromise;

    const queryPromise = database.query('SELECT 1 AS value');
    const queryMessage = latestProcess().messages.at(-1);
    expect(queryMessage?.request).not.toHaveProperty('rowMode');
    latestProcess().reply(queryMessage as PostedMessage, { rows: [{ value: 1 }] });

    await expect(queryPromise).resolves.toEqual({ rows: [{ value: 1 }] });
  });

  it('returns a remote client that satisfies the shared DB execution contract', async () => {
    const { getMissingBrainstrikeDbClientCapabilities } = await import('@brainstrike/db');
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const databasePromise = manager.getDatabase();
    const initMessage = latestProcess().messages.at(-1);
    latestProcess().reply(initMessage as PostedMessage, { initialized: true });

    const database = await databasePromise;

    expect(getMissingBrainstrikeDbClientCapabilities(database)).toEqual([]);
  });

  it('passes the resolved desktop database root path to the utility DB host', async () => {
    process.env['NODE_ENV'] = 'development';
    const expectedDbRootPath = path.join('/mock/documents', 'BrainStrike-dev');
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    void manager.getDiagnostics();

    expect(forkMock).toHaveBeenCalledWith(
      '/mock/db-host-entry.js',
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          BRAINSTRIKE_DB_ROOT_PATH: expectedDbRootPath,
        }),
        serviceName: 'brainstrike-db-host',
      })
    );
  });

  it('forwards the explicit database profile to the utility DB host', async () => {
    process.env['BRAINSTRIKE_DB_PROFILE'] = 'branch-main-wt-155ffb69';
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    void manager.getDiagnostics();

    expect(forkMock).toHaveBeenCalledWith(
      '/mock/db-host-entry.js',
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          BRAINSTRIKE_DB_PROFILE: 'branch-main-wt-155ffb69',
        }),
        serviceName: 'brainstrike-db-host',
      })
    );
  });

  it('does not forward unrelated process environment variables to the utility DB host', async () => {
    process.env['NODE_ENV'] = 'development';
    process.env['SECRET_TOKEN'] = 'should-not-cross-process-boundary';
    const expectedDbRootPath = path.join('/mock/documents', 'BrainStrike-dev');
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    void manager.getDiagnostics();

    const options = forkMock.mock.calls.at(-1)?.[2] as
      | { readonly env?: Record<string, string> }
      | undefined;
    expect(options?.env).toMatchObject({
      BRAINSTRIKE_DB_ROOT_PATH: expectedDbRootPath,
      NODE_ENV: 'development',
    });
    expect(options?.env).not.toHaveProperty('SECRET_TOKEN');
  });

  it('forwards the explicit PGlite initialization serialization flag to the utility DB host', async () => {
    process.env['BRAINSTRIKE_SERIALIZE_PGLITE_INIT'] = '1';
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    void manager.getDiagnostics();

    expect(forkMock).toHaveBeenCalledWith(
      '/mock/db-host-entry.js',
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          BRAINSTRIKE_SERIALIZE_PGLITE_INIT: '1',
        }),
        serviceName: 'brainstrike-db-host',
      })
    );
  });

  it('relays DB host log context as structured pino fields', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    void manager.getDiagnostics();
    latestProcess().emit('message', {
      context: {
        logSource: 'db-host',
        pid: 123,
        runtime: 'db-host',
      },
      kind: 'log',
      level: 'info',
      message: 'DB host init completed',
    });

    expect(loggerInfoMock).toHaveBeenCalledWith(
      {
        logSource: 'db-host',
        pid: 123,
        runtime: 'db-host',
      },
      'DB host init completed'
    );
  });

  it('exposes diagnostics from the DB host without creating another host process', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const diagnosticsPromise = manager.getDiagnostics();
    const diagnosticsMessage = latestProcess().messages.at(-1);
    expect(diagnosticsMessage?.request.kind).toBe('diagnostics');
    latestProcess().reply(diagnosticsMessage as PostedMessage, {
      activeLiveQueryCount: 7,
      dataDir: '/mock/pgdata',
      hasDatabaseHandle: true,
    });

    await expect(diagnosticsPromise).resolves.toMatchObject({
      dataDir: '/mock/pgdata',
      hasDatabaseHandle: true,
    });
    expect(await diagnosticsPromise).not.toHaveProperty('activeLiveQueryCount');
    expect(forkMock).toHaveBeenCalledTimes(1);
  });

  it('reports and releases test-only manager and host live-query ownership', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });
    const databasePromise = manager.getDatabase();
    latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, { initialized: true });
    const database = await databasePromise;

    const livePromise = database.live.query({ query: 'SELECT 1' });
    const liveStartMessage = latestProcess().messages.at(-1);
    latestProcess().reply(liveStartMessage as PostedMessage, {
      initialResults: { rows: [] },
      liveId: 'live-memory-test',
    });
    const liveQuery = await livePromise;

    const activeDiagnosticsPromise = manager.getLiveQueryDiagnosticsForTests();
    const activeDiagnosticsMessage = latestProcess().messages.at(-1);
    expect(activeDiagnosticsMessage?.request.kind).toBe('diagnostics');
    latestProcess().reply(activeDiagnosticsMessage as PostedMessage, {
      activeLiveQueryCount: 1,
    });
    await expect(activeDiagnosticsPromise).resolves.toEqual({
      hostLiveQueryCount: 1,
      managerLiveQueryCount: 1,
    });

    const unsubscribePromise = liveQuery.unsubscribe();
    const stopMessage = latestProcess().messages.at(-1);
    expect(stopMessage?.request.kind).toBe('live:stop');
    latestProcess().reply(stopMessage as PostedMessage, { stopped: true });
    await unsubscribePromise;

    const releasedDiagnosticsPromise = manager.getLiveQueryDiagnosticsForTests();
    const releasedDiagnosticsMessage = latestProcess().messages.at(-1);
    latestProcess().reply(releasedDiagnosticsMessage as PostedMessage, {
      activeLiveQueryCount: 0,
    });
    await expect(releasedDiagnosticsPromise).resolves.toEqual({
      hostLiveQueryCount: 0,
      managerLiveQueryCount: 0,
    });
  });

  it('closes and clears the default utility DB host manager singleton', async () => {
    const { closeDbHostManager, getDbHostManager } = await import('../../db-host-manager');
    const manager = getDbHostManager();

    const diagnosticsPromise = manager.getDiagnostics();
    const diagnosticsMessage = latestProcess().messages.at(-1);
    latestProcess().reply(diagnosticsMessage as PostedMessage, {
      hasDatabaseHandle: true,
    });
    await expect(diagnosticsPromise).resolves.toMatchObject({ hasDatabaseHandle: true });

    const firstHost = latestProcess();
    const closePromise = closeDbHostManager();
    const closeMessage = firstHost.messages.at(-1);
    expect(closeMessage?.request.kind).toBe('close');
    firstHost.reply(closeMessage as PostedMessage, { closed: true });
    await closePromise;

    expect(firstHost.kill).toHaveBeenCalledTimes(1);
    expect(getDbHostManager()).not.toBe(manager);
  });

  it('terminates the utility DB host when close acknowledgement is blocked behind pending work', async () => {
    vi.useFakeTimers();
    try {
      const { createDbHostManager } = await import('../../db-host-manager');
      const manager = createDbHostManager({
        closeTimeoutMs: 5,
        entryPath: '/mock/db-host-entry.js',
      });

      const diagnosticsPromise = manager.getDiagnostics();
      const firstHost = latestProcess();
      expect(firstHost.messages.at(-1)?.request.kind).toBe('diagnostics');
      const diagnosticsAssertion = expect(diagnosticsPromise).rejects.toThrow('DB host closed.');

      const closePromise = manager.close();
      expect(firstHost.messages.at(-1)?.request.kind).toBe('close');

      await vi.advanceTimersByTimeAsync(5);
      await closePromise;

      await diagnosticsAssertion;
      expect(firstHost.kill).toHaveBeenCalledTimes(1);
      expect(loggerWarnMock).toHaveBeenCalledWith(
        'Timed out waiting for DB host close acknowledgement; terminating host',
        { timeoutMs: 5 }
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not create a second default manager while singleton close is in flight', async () => {
    const { closeDbHostManager, getDbHostManager } = await import('../../db-host-manager');
    const manager = getDbHostManager();

    const diagnosticsPromise = manager.getDiagnostics();
    latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, {
      hasDatabaseHandle: true,
    });
    await expect(diagnosticsPromise).resolves.toMatchObject({ hasDatabaseHandle: true });

    const firstHost = latestProcess();
    const closePromise = closeDbHostManager();
    expect(() => getDbHostManager()).toThrow(
      'DB host manager is closing; wait for closeDbHostManager() to complete.'
    );
    expect(forkMock).toHaveBeenCalledTimes(1);

    const closeMessage = firstHost.messages.at(-1);
    firstHost.reply(closeMessage as PostedMessage, { closed: true });
    await closePromise;

    const nextManager = getDbHostManager();
    expect(nextManager).not.toBe(manager);
    void nextManager.getDiagnostics();
    expect(forkMock).toHaveBeenCalledTimes(2);
  });

  it('sends raw live query text to the DB host so escaping happens at one boundary', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });
    const databasePromise = manager.getDatabase();
    latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, { initialized: true });
    const database = await databasePromise;

    const livePromise = database.live.query({
      params: ['needle'],
      query: "SELECT * FROM file_records WHERE path LIKE '%' || $1 || '%'",
    });
    const liveMessage = latestProcess().messages.at(-1);

    expect(liveMessage).toMatchObject({
      request: {
        kind: 'live:start',
        payload: {
          params: ['needle'],
          query: "SELECT * FROM file_records WHERE path LIKE '%' || $1 || '%'",
        },
      },
    });
    latestProcess().reply(liveMessage as PostedMessage, {
      initialResults: { rows: [] },
      liveId: 'live-1',
    });

    await expect(livePromise).resolves.toMatchObject({
      initialResults: { rows: [] },
    });
  });

  it('logs structured live query diagnostics when DB host live start rejects', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });
    const databasePromise = manager.getDatabase();
    latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, { initialized: true });
    const database = await databasePromise;

    const livePromise = database.live.query({
      params: ['needle'],
      query: "SELECT * FROM file_records WHERE path LIKE '%' || $1 || '%'",
    });
    const liveMessage = latestProcess().messages.at(-1);
    latestProcess().reject(liveMessage as PostedMessage, 'too few arguments for format()');

    await expect(livePromise).rejects.toThrow('too few arguments for format()');
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        mode: 'query',
        paramsCount: 1,
        queryPreview: "SELECT * FROM file_records WHERE path LIKE '%' || $1 || '%'",
        unescapedPercentRuns: 2,
      }),
      'DB host live query start failed'
    );
  });

  it('fails existing live query handles when the utility DB host exits', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });
    const databasePromise = manager.getDatabase();
    latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, { initialized: true });
    const database = await databasePromise;

    const livePromise = database.live.query({ query: 'SELECT 1' });
    const liveMessage = latestProcess().messages.at(-1);
    latestProcess().reply(liveMessage as PostedMessage, {
      initialResults: { rows: [] },
      liveId: 'live-1',
    });
    const liveQuery = await livePromise;

    latestProcess().emit('exit', 1);

    await expect(liveQuery.refresh()).rejects.toThrow('DB host exited with code 1.');
    expect(forkMock).toHaveBeenCalledTimes(1);
  });

  it('does not terminate the utility DB host when a non-transaction request times out', async () => {
    vi.useFakeTimers();
    try {
      const { createDbHostManager } = await import('../../db-host-manager');
      const manager = createDbHostManager({
        entryPath: '/mock/db-host-entry.js',
        requestTimeoutMs: 5,
      });

      const diagnosticsPromise = manager.getDiagnostics();
      const diagnosticsAssertion = expect(diagnosticsPromise).rejects.toThrow(
        'DB host request timed out: diagnostics'
      );
      const firstHost = latestProcess();
      await vi.advanceTimersByTimeAsync(5);
      await diagnosticsAssertion;
      expect(firstHost.kill).not.toHaveBeenCalled();

      const nextDiagnosticsPromise = manager.getDiagnostics();
      expect(forkMock).toHaveBeenCalledTimes(1);
      latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, {
        hasDatabaseHandle: true,
      });
      await expect(nextDiagnosticsPromise).resolves.toMatchObject({ hasDatabaseHandle: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs request context when a query request times out', async () => {
    vi.useFakeTimers();
    try {
      const { createDbHostManager, DbHostRequestTimeoutError } = await import(
        '../../db-host-manager'
      );
      const manager = createDbHostManager({
        entryPath: '/mock/db-host-entry.js',
        requestTimeoutMs: 5,
      });
      const databasePromise = manager.getDatabase();
      latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, {
        initialized: true,
      });
      const database = await databasePromise;

      const queryPromise = database.query(
        'SELECT * FROM file_chunks WHERE embedding_set_id = $1 AND embedding IS NULL',
        ['set-timeout']
      );
      const queuedQueryPromise = database.query('SELECT 1');
      const queuedQueryError = queuedQueryPromise.catch((error: unknown) => error);
      const timeoutAssertion = expect(queryPromise).rejects.toThrow(
        'DB host request timed out: query'
      );

      await vi.advanceTimersByTimeAsync(5);
      await timeoutAssertion;
      await expect(queryPromise).rejects.toMatchObject({ hostSaturated: true, pendingCount: 2 });
      await expect(queryPromise).rejects.toBeInstanceOf(DbHostRequestTimeoutError);
      await expect(queuedQueryError).resolves.toMatchObject({
        hostSaturated: true,
        pendingCount: 1,
      });

      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          elapsedMs: 5,
          paramsCount: 1,
          pendingCount: 2,
          requestKind: 'query',
          sqlPreview: 'SELECT * FROM file_chunks WHERE embedding_set_id = $1 AND embedding IS NULL',
          timeoutMs: 5,
        }),
        'DB host request timed out'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs when a timed-out request eventually completes instead of dropping the late response silently', async () => {
    vi.useFakeTimers();
    try {
      const { createDbHostManager } = await import('../../db-host-manager');
      const manager = createDbHostManager({
        entryPath: '/mock/db-host-entry.js',
        requestTimeoutMs: 5,
      });
      const databasePromise = manager.getDatabase();
      latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, {
        initialized: true,
      });
      const database = await databasePromise;

      const queryPromise = database.query('SELECT COUNT(*) FROM job_queue', []);
      const timeoutAssertion = expect(queryPromise).rejects.toThrow(
        'DB host request timed out: query'
      );
      const queryMessage = latestProcess().messages.at(-1) as PostedMessage;
      await vi.advanceTimersByTimeAsync(5);
      await timeoutAssertion;
      loggerWarnMock.mockClear();

      // The DB host executes one statement at a time, so a timed-out request
      // usually means the statement is STILL RUNNING and still blocking the
      // host. Its eventual completion must be visible in logs, not vanish.
      await vi.advanceTimersByTimeAsync(20);
      latestProcess().reply(queryMessage, { rows: [] });
      await flushMicrotasks();

      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          elapsedMs: 25,
          ok: true,
          requestKind: 'query',
          timeoutMs: 5,
        }),
        'DB host request completed after timeout'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not classify a host as transient after an abandoned request stays wedged for another timeout window', async () => {
    vi.useFakeTimers();
    try {
      const { createDbHostManager } = await import('../../db-host-manager');
      const manager = createDbHostManager({
        entryPath: '/mock/db-host-entry.js',
        requestTimeoutMs: 5,
      });
      const databasePromise = manager.getDatabase();
      latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, {
        initialized: true,
      });
      const database = await databasePromise;

      const wedgedQuery = database.query('SELECT 1');
      const wedgedError = wedgedQuery.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5);
      await wedgedError;

      const recoveryQueries = [database.query('SELECT 2'), database.query('SELECT 3')];
      const recoveryMessages = latestProcess().messages.slice(-2) as PostedMessage[];
      const queuedErrors = recoveryQueries.map((query) => query.catch((error: unknown) => error));
      await vi.advanceTimersByTimeAsync(5);

      await expect(queuedErrors[0]).resolves.toMatchObject({
        hostSaturated: false,
        pendingCount: 2,
      });
      await queuedErrors[1];

      for (const message of recoveryMessages) {
        latestProcess().reply(message, { rows: [] });
      }
      await flushMicrotasks();

      const laterErrors = [database.query('SELECT 4'), database.query('SELECT 5')].map((query) =>
        query.catch((error: unknown) => error)
      );
      await vi.advanceTimersByTimeAsync(5);

      await expect(laterErrors[0]).resolves.toMatchObject({ hostSaturated: true, pendingCount: 2 });
      await expect(laterErrors[1]).resolves.toMatchObject({ hostSaturated: true, pendingCount: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains the oldest non-stale abandoned request when the tracking map is full', async () => {
    vi.useFakeTimers();
    try {
      const { createDbHostManager } = await import('../../db-host-manager');
      const manager = createDbHostManager({
        entryPath: '/mock/db-host-entry.js',
        requestTimeoutMs: 5,
      });
      const databasePromise = manager.getDatabase();
      latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, {
        initialized: true,
      });
      const database = await databasePromise;

      const fillPromises = Array.from({ length: 64 }, (_, index) =>
        database.query(`SELECT ${index}`, [])
      );
      const oldestMessage = latestProcess().messages.at(-64) as PostedMessage;
      for (const promise of fillPromises) {
        promise.catch(() => undefined);
      }
      await vi.advanceTimersByTimeAsync(5);

      const overflowPromise = database.query('SELECT 64', []);
      overflowPromise.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(5);
      loggerWarnMock.mockClear();

      await vi.advanceTimersByTimeAsync(20);
      latestProcess().reply(oldestMessage, { rows: [] });
      await flushMicrotasks();

      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          elapsedMs: 30,
          ok: true,
          requestKind: 'query',
        }),
        'DB host request completed after timeout'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the maintenance timeout for explicit maintenance exec requests', async () => {
    vi.useFakeTimers();
    try {
      const { createDbHostManager } = await import('../../db-host-manager');
      const manager = createDbHostManager({
        entryPath: '/mock/db-host-entry.js',
        maintenanceRequestTimeoutMs: 50,
        requestTimeoutMs: 5,
      });
      const databasePromise = manager.getDatabase();
      latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, {
        initialized: true,
      });
      const database = await databasePromise;

      const execPromise = database.maintenance.exec(
        'CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384 ON file_chunks USING hnsw ((embedding::halfvec(384)) halfvec_cosine_ops)'
      );
      const execAssertion = expect(execPromise).rejects.toThrow(
        'DB host request timed out: maintenance:exec'
      );

      await vi.advanceTimersByTimeAsync(5);
      await flushMicrotasks();
      expect(loggerWarnMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ requestKind: 'maintenance:exec' }),
        'DB host request timed out'
      );

      await vi.advanceTimersByTimeAsync(45);
      await execAssertion;

      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          elapsedMs: 50,
          pendingCount: 1,
          requestKind: 'maintenance:exec',
          sqlPreview:
            'CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384 ON file_chunks USING hnsw ((embedding::halfvec(384)) halfvec_cosine_ops)',
          timeoutMs: 50,
        }),
        'DB host request timed out'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the initialization timeout for the first DB host startup request', async () => {
    vi.useFakeTimers();
    try {
      const { createDbHostManager } = await import('../../db-host-manager');
      const manager = createDbHostManager({
        entryPath: '/mock/db-host-entry.js',
        initializationTimeoutMs: 15,
        requestTimeoutMs: 5,
      });

      const databasePromise = manager.getDatabase();
      const databaseErrorPromise = databasePromise.then(
        () => null,
        (error: unknown) => error
      );
      const firstHost = latestProcess();

      await vi.advanceTimersByTimeAsync(5);
      expect(firstHost.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10);
      const databaseError = await databaseErrorPromise;
      expect(databaseError).toBeInstanceOf(Error);
      expect((databaseError as Error).message).toBe('DB host request timed out: init');
      expect(firstHost.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates the utility DB host when initialization fails', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const databasePromise = manager.getDatabase();
    const firstHost = latestProcess();
    firstHost.reject(firstHost.messages.at(-1) as PostedMessage, 'init failed');

    await expect(databasePromise).rejects.toThrow('init failed');
    expect(firstHost.kill).toHaveBeenCalledTimes(1);

    const nextDatabasePromise = manager.getDatabase();
    expect(forkMock).toHaveBeenCalledTimes(2);
    latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, {
      initialized: true,
    });
    await expect(nextDatabasePromise).resolves.toBeDefined();
  });

  it('terminates the utility DB host when a transaction request times out', async () => {
    vi.useFakeTimers();
    try {
      const { createDbHostManager } = await import('../../db-host-manager');
      const manager = createDbHostManager({
        entryPath: '/mock/db-host-entry.js',
        requestTimeoutMs: 5,
      });
      const databasePromise = manager.getDatabase();
      latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, {
        initialized: true,
      });
      const database = await databasePromise;

      const transactionPromise = database.transaction(async () => 'unreachable');
      const txStartMessage = latestProcess().messages.at(-1);
      expect(txStartMessage).toMatchObject({
        request: {
          kind: 'transaction:start',
          transactionId: expect.stringMatching(/^tx:/),
        },
      });
      const firstHost = latestProcess();
      const transactionAssertion = expect(transactionPromise).rejects.toThrow(
        'DB host request timed out: transaction:start'
      );

      await vi.advanceTimersByTimeAsync(5);

      await transactionAssertion;
      expect(firstHost.kill).toHaveBeenCalledTimes(1);

      const nextDiagnosticsPromise = manager.getDiagnostics();
      expect(forkMock).toHaveBeenCalledTimes(2);
      latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, {
        hasDatabaseHandle: true,
      });
      await expect(nextDiagnosticsPromise).resolves.toMatchObject({ hasDatabaseHandle: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('commits a remote transaction after the callback succeeds', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });
    const databasePromise = manager.getDatabase();
    latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, { initialized: true });
    const database = await databasePromise;

    let transactionId = '';
    const resultPromise = database.transaction(async (tx) => {
      const queryPromise = tx.query('SELECT 1');
      const queryMessage = latestProcess().messages.at(-1);
      expect(queryMessage).toMatchObject({
        request: { kind: 'transaction:query', sql: 'SELECT 1', transactionId },
      });
      latestProcess().reply(queryMessage as PostedMessage, { rows: [{ value: 1 }] });
      return (await queryPromise).rows[0];
    });

    const txStart = latestProcess().messages.at(-1);
    transactionId = txStart?.request.transactionId ?? '';
    expect(txStart).toMatchObject({
      request: { kind: 'transaction:start', transactionId: expect.stringMatching(/^tx:/) },
    });
    latestProcess().reply(txStart as PostedMessage, { transactionId });

    const commitMessage = await waitForLastRequest('transaction:commit');
    expect(commitMessage.request.transactionId).toBe(transactionId);
    latestProcess().reply(commitMessage, { committed: true });

    await expect(resultPromise).resolves.toEqual({ value: 1 });
  });

  it('rolls back a remote transaction when the callback throws', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });
    const databasePromise = manager.getDatabase();
    latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, { initialized: true });
    const database = await databasePromise;

    const resultPromise = database.transaction(async () => {
      throw new Error('callback failed');
    });

    const txStart = latestProcess().messages.at(-1);
    const transactionId = txStart?.request.transactionId;
    expect(txStart).toMatchObject({
      request: { kind: 'transaction:start', transactionId: expect.stringMatching(/^tx:/) },
    });
    latestProcess().reply(txStart as PostedMessage, { transactionId });
    const rollbackMessage = await waitForLastRequest('transaction:rollback');
    expect(rollbackMessage.request.transactionId).toBe(transactionId);
    latestProcess().reply(rollbackMessage, { rolledBack: true });

    await expect(resultPromise).rejects.toThrow('callback failed');
  });

  it('rejects a remote transaction if the host acknowledges a different transaction id', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });
    const databasePromise = manager.getDatabase();
    latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, { initialized: true });
    const database = await databasePromise;

    const resultPromise = database.transaction(async () => 'unreachable');
    const txStart = latestProcess().messages.at(-1);
    expect(txStart).toMatchObject({
      request: { kind: 'transaction:start', transactionId: expect.stringMatching(/^tx:/) },
    });
    latestProcess().reply(txStart as PostedMessage, { transactionId: 'tx:wrong' });

    await expect(resultPromise).rejects.toThrow(
      'DB host transaction acknowledgement mismatch: expected'
    );
  });
});
