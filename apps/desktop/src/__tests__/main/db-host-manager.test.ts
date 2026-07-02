import { EventEmitter } from 'node:events';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface PostedMessage {
  readonly id: string;
  readonly kind: 'request';
  readonly request: {
    readonly kind: string;
    readonly params?: readonly unknown[];
    readonly payload?: unknown;
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

async function waitForHostMessageCount(
  utilityProcess: FakeUtilityProcess,
  expectedCount: number
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (utilityProcess.messages.length >= expectedCount) {
      return;
    }
    await flushMicrotasks();
  }
  throw new Error(`Timed out waiting for ${expectedCount} DB host messages.`);
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

function createReadyBootstrapReport() {
  const checks = [
    'store.open',
    'schema.migrated',
    'extension.pgvector',
    'extension.pg_trgm',
    'search.fts-grep',
    'capability.transaction',
    'capability.live-query',
    'queue.table',
    'assistant-memory.run-usage',
    'assistant-memory.mastra-schema',
    'workspace-index.system-role',
    'store.close',
  ].map((id) => ({
    id,
    label: id,
    required: id !== 'assistant-memory.mastra-schema',
    status: id === 'assistant-memory.mastra-schema' ? 'skipped' : 'passed',
  }));

  return {
    checks,
    failure: null,
    phase: 'ready',
    profileId: 'default',
    ready: true,
    runtime: {
      engine: 'pglite',
      host: 'electron-utility',
      persistence: 'filesystem',
    },
    startedAt: '2026-06-22T00:00:00.000Z',
    updatedAt: '2026-06-22T00:00:01.000Z',
  };
}

function createReadyTursoBootstrapReport() {
  const checks = [
    'store.open',
    'primary-store.mvcc',
    'schema.baseline',
    'search.grep-content-grams',
    'search.vector32-functions',
    'search.ownership',
    'store.close',
  ].map((id) => ({
    id,
    label: id,
    required: true,
    status: 'passed',
  }));

  return {
    checks,
    failure: null,
    phase: 'ready',
    profileId: 'default',
    ready: true,
    runtime: {
      engine: 'turso',
      host: 'electron-utility',
      persistence: 'filesystem',
    },
    search: {
      indexedSearch: 'available',
      message: 'Primary Turso MVCC store requires an explicitly owned search-index store.',
      ownershipMode: 'split-search-index-store',
    },
    startedAt: '2026-06-22T00:00:00.000Z',
    updatedAt: '2026-06-22T00:00:01.000Z',
  };
}

function createReadyInitResult(overrides: Record<string, unknown> = {}) {
  return {
    bootstrapReport: createReadyBootstrapReport(),
    capabilities: { liveQuery: true },
    initialized: true,
    ...overrides,
  };
}

describe('DbHostManager', () => {
  const originalNodeEnv = process.env['NODE_ENV'];
  const originalDbProfile = process.env['BRAINSTRIKE_DB_PROFILE'];
  const originalDbRuntime = process.env['BRAINSTRIKE_DB_RUNTIME'];
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
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_DB_RUNTIME');
    Reflect.deleteProperty(process.env, 'SECRET_TOKEN');
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_SERIALIZE_PGLITE_INIT');
  });

  afterEach(() => {
    restoreEnvValue('NODE_ENV', originalNodeEnv);
    restoreEnvValue('BRAINSTRIKE_DB_PROFILE', originalDbProfile);
    restoreEnvValue('BRAINSTRIKE_DB_RUNTIME', originalDbRuntime);
    restoreEnvValue('BRAINSTRIKE_SERIALIZE_PGLITE_INIT', originalSerializePgliteInit);
  });

  it('starts the utility DB host once and routes query requests through it', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const databasePromise = manager.getDatabase();
    const initMessage = latestProcess().messages.at(-1);
    expect(initMessage?.request.kind).toBe('init');
    latestProcess().reply(initMessage as PostedMessage, createReadyInitResult());
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
    latestProcess().reply(initMessage as PostedMessage, createReadyInitResult());

    const database = await databasePromise;

    expect(getMissingBrainstrikeDbClientCapabilities(database)).toEqual([]);
  });

  it('fails live queries locally without sending live:start when Turso disables live-query capability', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const databasePromise = manager.getDatabase();
    const firstHost = latestProcess();
    firstHost.reply(
      firstHost.messages.at(-1) as PostedMessage,
      createReadyInitResult({
        bootstrapReport: createReadyTursoBootstrapReport(),
        capabilities: { liveQuery: false },
      })
    );

    const database = await databasePromise;
    expect(database.capabilities).toEqual({ liveQuery: false });
    const messageCountBeforeLiveQuery = firstHost.messages.length;

    await expect(database.live.query({ query: 'SELECT 1' })).rejects.toThrow(
      'DB host live queries are unavailable for runtime engine turso.'
    );
    expect(firstHost.messages).toHaveLength(messageCountBeforeLiveQuery);
  });

  it('rejects ready Turso bootstrap reports that omit the schema baseline check', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });
    const reportWithoutSchemaBaseline = {
      ...createReadyTursoBootstrapReport(),
      checks: createReadyTursoBootstrapReport().checks.filter(
        (check) => check.id !== 'schema.baseline'
      ),
    };

    const databasePromise = manager.getDatabase();
    const firstHost = latestProcess();
    firstHost.reply(
      firstHost.messages.at(-1) as PostedMessage,
      createReadyInitResult({
        bootstrapReport: reportWithoutSchemaBaseline,
        capabilities: { liveQuery: false },
      })
    );

    await expect(databasePromise).rejects.toThrow(
      'Bootstrap report missing required check: schema.baseline'
    );
  });

  it('rejects ready Turso bootstrap reports that omit the grep content gram check', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });
    const reportWithoutGrepContentGrams = {
      ...createReadyTursoBootstrapReport(),
      checks: createReadyTursoBootstrapReport().checks.filter(
        (check) => check.id !== 'search.grep-content-grams'
      ),
    };

    const databasePromise = manager.getDatabase();
    const firstHost = latestProcess();
    firstHost.reply(
      firstHost.messages.at(-1) as PostedMessage,
      createReadyInitResult({
        bootstrapReport: reportWithoutGrepContentGrams,
        capabilities: { liveQuery: false },
      })
    );

    await expect(databasePromise).rejects.toThrow(
      'Bootstrap report missing required check: search.grep-content-grams'
    );
  });

  it('rejects ready Turso bootstrap reports that omit the vector function check', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });
    const reportWithoutVectorFunctions = {
      ...createReadyTursoBootstrapReport(),
      checks: createReadyTursoBootstrapReport().checks.filter(
        (check) => check.id !== 'search.vector32-functions'
      ),
    };

    const databasePromise = manager.getDatabase();
    const firstHost = latestProcess();
    firstHost.reply(
      firstHost.messages.at(-1) as PostedMessage,
      createReadyInitResult({
        bootstrapReport: reportWithoutVectorFunctions,
        capabilities: { liveQuery: false },
      })
    );

    await expect(databasePromise).rejects.toThrow(
      'Bootstrap report missing required check: search.vector32-functions'
    );
  });

  it('fails incremental live queries locally without sending live:start when Turso disables live-query capability', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const databasePromise = manager.getDatabase();
    const firstHost = latestProcess();
    firstHost.reply(
      firstHost.messages.at(-1) as PostedMessage,
      createReadyInitResult({
        bootstrapReport: createReadyTursoBootstrapReport(),
        capabilities: { liveQuery: false },
      })
    );

    const database = await databasePromise;
    const messageCountBeforeLiveQuery = firstHost.messages.length;

    await expect(
      database.live.incrementalQuery('SELECT 1', null, 'turso-live-disabled')
    ).rejects.toThrow('DB host live queries are unavailable for runtime engine turso.');
    expect(firstHost.messages).toHaveLength(messageCountBeforeLiveQuery);
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

  it('forwards the explicit database runtime selector to the utility DB host', async () => {
    process.env['BRAINSTRIKE_DB_RUNTIME'] = 'turso';
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    void manager.getDiagnostics();

    expect(forkMock).toHaveBeenCalledWith(
      '/mock/db-host-entry.js',
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          BRAINSTRIKE_DB_RUNTIME: 'turso',
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
    latestProcess().reply(
      latestProcess().messages.at(-1) as PostedMessage,
      createReadyInitResult()
    );
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

  it('sends incremental live query text to the DB host with the caller-provided key', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });
    const databasePromise = manager.getDatabase();
    latestProcess().reply(
      latestProcess().messages.at(-1) as PostedMessage,
      createReadyInitResult()
    );
    const database = await databasePromise;

    const livePromise = database.live.incrementalQuery(
      'SELECT * FROM file_records WHERE name = $1',
      ['readme.md'],
      'file-records:readme'
    );
    const liveMessage = latestProcess().messages.at(-1);

    expect(liveMessage).toMatchObject({
      request: {
        kind: 'live:start',
        payload: {
          key: 'file-records:readme',
          mode: 'incremental',
          query: 'SELECT * FROM file_records WHERE name = $1',
          params: ['readme.md'],
        },
      },
    });
    latestProcess().reply(liveMessage as PostedMessage, {
      liveId: 'live-incremental-1',
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
    latestProcess().reply(
      latestProcess().messages.at(-1) as PostedMessage,
      createReadyInitResult()
    );
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
    latestProcess().reply(
      latestProcess().messages.at(-1) as PostedMessage,
      createReadyInitResult()
    );
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

  it('terminates the Turso utility DB host when an owner-client request times out', async () => {
    vi.useFakeTimers();
    try {
      const { createDbHostManager } = await import('../../db-host-manager');
      const manager = createDbHostManager({
        entryPath: '/mock/db-host-entry.js',
        requestTimeoutMs: 5,
      });
      const databasePromise = manager.getDatabase();
      latestProcess().reply(
        latestProcess().messages.at(-1) as PostedMessage,
        createReadyInitResult({
          bootstrapReport: createReadyTursoBootstrapReport(),
          capabilities: { liveQuery: false },
        })
      );
      const database = await databasePromise;

      const queryPromise = database.query('SELECT * FROM file_chunks WHERE embedding IS NULL');
      const timeoutAssertion = expect(queryPromise).rejects.toThrow(
        'DB host request timed out: query'
      );
      const firstHost = latestProcess();

      await vi.advanceTimersByTimeAsync(5);
      await timeoutAssertion;

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

  it('initializes Turso before a first-touch managed-cache request can time out', async () => {
    vi.useFakeTimers();
    try {
      const { createDbHostManager } = await import('../../db-host-manager');
      const manager = createDbHostManager({
        entryPath: '/mock/db-host-entry.js',
        requestTimeoutMs: 5,
      });

      const requestPromise = manager.applyManagedCacheBatch({ operations: [] });
      const firstHost = latestProcess();
      const initialMessage = firstHost.messages.at(-1) as PostedMessage;

      if (initialMessage.request.kind === 'init') {
        firstHost.reply(
          initialMessage,
          createReadyInitResult({
            bootstrapReport: createReadyTursoBootstrapReport(),
            capabilities: { liveQuery: false },
          })
        );
        await flushMicrotasks();
      }

      const timeoutAssertion = expect(requestPromise).rejects.toThrow(
        'DB host request timed out: managed-cache:apply-batch'
      );
      await vi.advanceTimersByTimeAsync(5);
      await timeoutAssertion;

      expect(firstHost.messages[0]?.request.kind).toBe('init');
      expect(firstHost.messages[1]?.request.kind).toBe('managed-cache:apply-batch');
      expect(firstHost.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('initializes Turso before forwarding first-touch Turso queue/backfill/vector owner requests', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const queuePromise = manager.runTursoEmbeddingWorkerQueueOperation({
      operation: 'claimMany',
      payload: {
        leaseMs: 60_000,
        limit: 1,
        now: '2026-06-30T10:01:00.000Z',
        queue: 'embeddings',
        workerId: 'worker-1',
      },
    });
    const firstHost = latestProcess();
    firstHost.reply(
      firstHost.messages.at(-1) as PostedMessage,
      createReadyInitResult({
        bootstrapReport: createReadyTursoBootstrapReport(),
        capabilities: { liveQuery: false },
      })
    );
    await flushMicrotasks();
    await flushMicrotasks();
    await waitForHostMessageCount(firstHost, 2);

    expect(firstHost.messages[0]?.request.kind).toBe('init');
    expect(firstHost.messages[1]).toMatchObject({
      request: {
        kind: 'turso:embedding-worker:queue',
        payload: {
          operation: 'claimMany',
          payload: {
            queue: 'embeddings',
            workerId: 'worker-1',
          },
        },
      },
    });
    firstHost.reply(firstHost.messages[1] as PostedMessage, [{ id: 'job-1' }]);
    await expect(queuePromise).resolves.toEqual([{ id: 'job-1' }]);

    const statsPromise = manager.runTursoEmbeddingWorkerStatsOperation({
      embeddingSetIds: ['set-1'],
      operation: 'refresh',
    });
    await waitForHostMessageCount(firstHost, 3);
    expect(firstHost.messages[2]).toMatchObject({
      request: {
        kind: 'turso:embedding-worker:stats',
        payload: {
          embeddingSetIds: ['set-1'],
          operation: 'refresh',
        },
      },
    });
    firstHost.reply(firstHost.messages[2] as PostedMessage, undefined);
    await expect(statsPromise).resolves.toBeUndefined();

    const backfillPromise = manager.runTursoEmbeddingBackfillOperation<number>({
      embeddingSetId: 'set-1',
      operation: 'chunk:countEmbeddingBackfillCandidates',
      queue: 'embeddings',
    });
    await waitForHostMessageCount(firstHost, 4);
    expect(firstHost.messages[3]).toMatchObject({
      request: {
        kind: 'turso:embedding-backfill',
        payload: {
          embeddingSetId: 'set-1',
          operation: 'chunk:countEmbeddingBackfillCandidates',
          queue: 'embeddings',
        },
      },
    });
    firstHost.reply(firstHost.messages[3] as PostedMessage, 2);
    await expect(backfillPromise).resolves.toBe(2);

    const actionPromise = manager.runTursoVectorQueueAction({
      operation: 'retryFailed',
      payload: { limit: 5 },
    });
    await waitForHostMessageCount(firstHost, 5);
    expect(firstHost.messages[4]).toMatchObject({
      request: {
        kind: 'turso:vector-queue:action',
        payload: {
          operation: 'retryFailed',
          payload: { limit: 5 },
        },
      },
    });
    firstHost.reply(firstHost.messages[4] as PostedMessage, {
      repairedQueued: 1,
      requeuedFailed: 1,
    });
    await expect(actionPromise).resolves.toEqual({
      repairedQueued: 1,
      requeuedFailed: 1,
    });
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
      latestProcess().reply(
        latestProcess().messages.at(-1) as PostedMessage,
        createReadyInitResult()
      );
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
      latestProcess().reply(
        latestProcess().messages.at(-1) as PostedMessage,
        createReadyInitResult()
      );
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

  it.each([
    'clearEmbeddingsForSet',
    'wipeQueue',
  ] as const)('uses the maintenance timeout for bulk Turso vector owner action %s', async (operation) => {
    vi.useFakeTimers();
    try {
      const { createDbHostManager } = await import('../../db-host-manager');
      const manager = createDbHostManager({
        entryPath: '/mock/db-host-entry.js',
        maintenanceRequestTimeoutMs: 50,
        requestTimeoutMs: 5,
      });
      const databasePromise = manager.getDatabase();
      latestProcess().reply(
        latestProcess().messages.at(-1) as PostedMessage,
        createReadyInitResult({
          bootstrapReport: createReadyTursoBootstrapReport(),
          capabilities: { liveQuery: false },
        })
      );
      await databasePromise;

      const actionPromise = manager.runTursoVectorQueueAction(
        operation === 'clearEmbeddingsForSet'
          ? { operation, payload: { embeddingSetId: 'set-timeout' } }
          : { operation, payload: null }
      );
      const actionAssertion = expect(actionPromise).rejects.toThrow(
        'DB host request timed out: turso:vector-queue:action'
      );

      await vi.advanceTimersByTimeAsync(5);
      await flushMicrotasks();
      expect(loggerWarnMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ requestKind: 'turso:vector-queue:action' }),
        'DB host request timed out'
      );

      await vi.advanceTimersByTimeAsync(45);
      await actionAssertion;

      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          elapsedMs: 50,
          pendingCount: 1,
          requestKind: 'turso:vector-queue:action',
          timeoutMs: 50,
          vectorQueueOperation: operation,
        }),
        'DB host request timed out'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs Turso embedding backfill operation context when a request times out', async () => {
    vi.useFakeTimers();
    try {
      const { createDbHostManager } = await import('../../db-host-manager');
      const manager = createDbHostManager({
        entryPath: '/mock/db-host-entry.js',
        requestTimeoutMs: 5,
      });
      const databasePromise = manager.getDatabase();
      latestProcess().reply(
        latestProcess().messages.at(-1) as PostedMessage,
        createReadyInitResult({
          bootstrapReport: createReadyTursoBootstrapReport(),
          capabilities: { liveQuery: false },
        })
      );
      await databasePromise;

      const backfillPromise = manager.runTursoEmbeddingBackfillOperation({
        embeddingSetId: 'set-timeout',
        operation: 'chunk:countEmbeddingBackfillCandidates',
        queue: 'embeddings',
      });
      const backfillAssertion = expect(backfillPromise).rejects.toThrow(
        'DB host request timed out: turso:embedding-backfill'
      );

      await vi.advanceTimersByTimeAsync(5);
      await backfillAssertion;

      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          elapsedMs: 5,
          embeddingBackfillOperation: 'chunk:countEmbeddingBackfillCandidates',
          pendingCount: 1,
          requestKind: 'turso:embedding-backfill',
          timeoutMs: 5,
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
    latestProcess().reply(
      latestProcess().messages.at(-1) as PostedMessage,
      createReadyInitResult()
    );
    await expect(nextDatabasePromise).resolves.toBeDefined();
  });

  it('terminates the utility DB host when init omits the bootstrap report', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const databasePromise = manager.getDatabase();
    const firstHost = latestProcess();
    firstHost.reply(firstHost.messages.at(-1) as PostedMessage, { initialized: true });

    await expect(databasePromise).rejects.toThrow(
      'DB host init completed without a bootstrap report.'
    );
    expect(firstHost.kill).toHaveBeenCalledTimes(1);
  });

  it('terminates the utility DB host when init returns a blocked bootstrap report', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const databasePromise = manager.getDatabase();
    const firstHost = latestProcess();
    firstHost.reply(firstHost.messages.at(-1) as PostedMessage, {
      bootstrapReport: {
        ...createReadyBootstrapReport(),
        phase: 'blocked',
        ready: false,
      },
      initialized: true,
    });

    await expect(databasePromise).rejects.toThrow(
      'DB host init bootstrap report is not ready: Bootstrap phase has not reached ready: blocked.'
    );
    expect(firstHost.kill).toHaveBeenCalledTimes(1);
  });

  it('terminates the utility DB host when init returns an inconsistent ready report', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const databasePromise = manager.getDatabase();
    const firstHost = latestProcess();
    firstHost.reply(firstHost.messages.at(-1) as PostedMessage, {
      bootstrapReport: {
        ...createReadyBootstrapReport(),
        checks: createReadyBootstrapReport().checks.map((check) =>
          check.id === 'queue.table' ? { ...check, status: 'failed' } : check
        ),
        ready: true,
      },
      initialized: true,
    });

    await expect(databasePromise).rejects.toThrow(
      'DB host init bootstrap report is not ready: Required bootstrap check failed: queue.table.'
    );
    expect(firstHost.kill).toHaveBeenCalledTimes(1);
  });

  it('validates Turso bootstrap reports against Turso checks before failing closed on missing client initialization', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const databasePromise = manager.getDatabase();
    const firstHost = latestProcess();
    firstHost.reply(firstHost.messages.at(-1) as PostedMessage, {
      bootstrapReport: createReadyTursoBootstrapReport(),
      initialized: false,
    });

    await expect(databasePromise).rejects.toThrow(
      'DB host init bootstrap report is not ready: DB host did not initialize the database.'
    );
    expect(firstHost.kill).toHaveBeenCalledTimes(1);
  });

  it('terminates the utility DB host when init omits a valid capability contract', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const databasePromise = manager.getDatabase();
    const firstHost = latestProcess();
    firstHost.reply(firstHost.messages.at(-1) as PostedMessage, {
      bootstrapReport: createReadyBootstrapReport(),
      initialized: true,
    });

    await expect(databasePromise).rejects.toThrow(
      'DB host init bootstrap report is not ready: DB host did not return a valid capability contract.'
    );
    expect(firstHost.kill).toHaveBeenCalledTimes(1);
  });

  it('terminates the utility DB host when init returns a malformed capability contract', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const databasePromise = manager.getDatabase();
    const firstHost = latestProcess();
    firstHost.reply(firstHost.messages.at(-1) as PostedMessage, {
      bootstrapReport: createReadyBootstrapReport(),
      capabilities: { liveQuery: 'yes' },
      initialized: true,
    });

    await expect(databasePromise).rejects.toThrow(
      'DB host init bootstrap report is not ready: DB host did not return a valid capability contract.'
    );
    expect(firstHost.kill).toHaveBeenCalledTimes(1);
  });

  it('terminates the utility DB host when init returns a ready report for an unsupported runtime engine', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const databasePromise = manager.getDatabase();
    const firstHost = latestProcess();
    firstHost.reply(firstHost.messages.at(-1) as PostedMessage, {
      bootstrapReport: {
        ...createReadyBootstrapReport(),
        runtime: {
          engine: 'sqlite',
          host: 'electron-utility',
          persistence: 'filesystem',
        },
      },
      initialized: true,
    });

    await expect(databasePromise).rejects.toThrow(
      'DB host init bootstrap report is not ready: Unsupported bootstrap runtime engine: sqlite.'
    );
    expect(firstHost.kill).toHaveBeenCalledTimes(1);
  });

  it('terminates the utility DB host when init returns a stale partial bootstrap report', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const databasePromise = manager.getDatabase();
    const firstHost = latestProcess();
    firstHost.reply(firstHost.messages.at(-1) as PostedMessage, {
      bootstrapReport: {
        ...createReadyBootstrapReport(),
        checks: [],
      },
      initialized: true,
    });

    await expect(databasePromise).rejects.toThrow(
      'DB host init bootstrap report is not ready: Bootstrap report missing required check: store.open.'
    );
    expect(firstHost.kill).toHaveBeenCalledTimes(1);
  });

  it('terminates the utility DB host when a Turso ready report omits the schema baseline check', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    const databasePromise = manager.getDatabase();
    const firstHost = latestProcess();
    const readyTursoReport = createReadyTursoBootstrapReport();
    firstHost.reply(firstHost.messages.at(-1) as PostedMessage, {
      bootstrapReport: {
        ...readyTursoReport,
        checks: readyTursoReport.checks.filter((check) => check.id !== 'schema.baseline'),
      },
      capabilities: { liveQuery: false },
      initialized: true,
    });

    await expect(databasePromise).rejects.toThrow(
      'DB host init bootstrap report is not ready: Bootstrap report missing required check: schema.baseline.'
    );
    expect(firstHost.kill).toHaveBeenCalledTimes(1);
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
      latestProcess().reply(
        latestProcess().messages.at(-1) as PostedMessage,
        createReadyInitResult()
      );
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
    latestProcess().reply(
      latestProcess().messages.at(-1) as PostedMessage,
      createReadyInitResult()
    );
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
    latestProcess().reply(
      latestProcess().messages.at(-1) as PostedMessage,
      createReadyInitResult()
    );
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
    latestProcess().reply(
      latestProcess().messages.at(-1) as PostedMessage,
      createReadyInitResult()
    );
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
