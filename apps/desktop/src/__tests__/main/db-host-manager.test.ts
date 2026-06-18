import { EventEmitter } from 'node:events';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      id: message.id,
      kind: 'response',
      ok: false,
      error: { message: error },
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

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
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

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

describe('DbHostManager', () => {
  const originalNodeEnv = process.env['NODE_ENV'];
  const originalSerializePgliteInit = process.env['BRAINSTRIKE_SERIALIZE_PGLITE_INIT'];

  beforeEach(() => {
    vi.resetModules();
    appGetPathMock.mockClear();
    forkMock.mockReset();
    forkMock.mockImplementation(() => new FakeUtilityProcess());
    loggerErrorMock.mockReset();
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
    Reflect.deleteProperty(process.env, 'SECRET_TOKEN');
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_SERIALIZE_PGLITE_INIT');
  });

  afterEach(() => {
    restoreEnvValue('NODE_ENV', originalNodeEnv);
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
        sql: 'SELECT $1::text AS value',
        params: ['ok'],
      },
    });
    latestProcess().reply(queryMessage as PostedMessage, { rows: [{ value: 'ok' }] });

    await expect(queryPromise).resolves.toEqual({ rows: [{ value: 'ok' }] });
    expect(forkMock).toHaveBeenCalledTimes(1);
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
      kind: 'log',
      level: 'info',
      message: 'DB host init completed',
      context: {
        logSource: 'db-host',
        pid: 123,
        runtime: 'db-host',
      },
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
      hasDatabaseHandle: true,
      dataDir: '/mock/pgdata',
    });

    await expect(diagnosticsPromise).resolves.toMatchObject({
      hasDatabaseHandle: true,
      dataDir: '/mock/pgdata',
    });
    expect(forkMock).toHaveBeenCalledTimes(1);
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
      query: "SELECT * FROM file_records WHERE path LIKE '%' || $1 || '%'",
      params: ['needle'],
    });
    const liveMessage = latestProcess().messages.at(-1);

    expect(liveMessage).toMatchObject({
      request: {
        kind: 'live:start',
        payload: {
          query: "SELECT * FROM file_records WHERE path LIKE '%' || $1 || '%'",
          params: ['needle'],
        },
      },
    });
    latestProcess().reply(liveMessage as PostedMessage, {
      liveId: 'live-1',
      initialResults: { rows: [] },
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
      query: "SELECT * FROM file_records WHERE path LIKE '%' || $1 || '%'",
      params: ['needle'],
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
      liveId: 'live-1',
      initialResults: { rows: [] },
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

      const queryPromise = database.query(
        'SELECT * FROM file_chunks WHERE embedding_set_id = $1 AND embedding IS NULL',
        ['set-timeout']
      );
      const timeoutAssertion = expect(queryPromise).rejects.toThrow(
        'DB host request timed out: query'
      );

      await vi.advanceTimersByTimeAsync(5);
      await timeoutAssertion;

      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          elapsedMs: 5,
          paramsCount: 1,
          pendingCount: 1,
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
        request: { kind: 'transaction:query', transactionId, sql: 'SELECT 1' },
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
    await flushMicrotasks();
    await flushMicrotasks();

    const commitMessage = latestProcess().messages.at(-1);
    expect(commitMessage).toMatchObject({
      request: { kind: 'transaction:commit', transactionId },
    });
    latestProcess().reply(commitMessage as PostedMessage, { committed: true });

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
    await flushMicrotasks();

    const rollbackMessage = latestProcess().messages.at(-1);
    expect(rollbackMessage).toMatchObject({
      request: { kind: 'transaction:rollback', transactionId },
    });
    latestProcess().reply(rollbackMessage as PostedMessage, { rolledBack: true });

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
