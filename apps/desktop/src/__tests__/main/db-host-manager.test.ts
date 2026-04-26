import { EventEmitter } from 'node:events';
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
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
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
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

describe('DbHostManager', () => {
  const originalNodeEnv = process.env['NODE_ENV'];

  beforeEach(() => {
    vi.resetModules();
    appGetPathMock.mockClear();
    forkMock.mockReset();
    forkMock.mockImplementation(() => new FakeUtilityProcess());
    loggerErrorMock.mockReset();
  });

  afterEach(() => {
    restoreEnvValue('NODE_ENV', originalNodeEnv);
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

  it('passes the resolved desktop database root path to the utility DB host', async () => {
    process.env['NODE_ENV'] = 'development';
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    void manager.getDiagnostics();

    expect(forkMock).toHaveBeenCalledWith(
      '/mock/db-host-entry.js',
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          BRAINSTRIKE_DB_ROOT_PATH: '/mock/documents/BrainStrike-dev',
        }),
        serviceName: 'brainstrike-db-host',
      })
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

  it('escapes literal percents before sending live query requests to the DB host', async () => {
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
          query: "SELECT * FROM file_records WHERE path LIKE '%%' || $1 || '%%'",
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
        queryPreview: "SELECT * FROM file_records WHERE path LIKE '%%' || $1 || '%%'",
        unescapedPercentRuns: 0,
      }),
      'DB host live query start failed'
    );
  });

  it('commits a remote transaction after the callback succeeds', async () => {
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });
    const databasePromise = manager.getDatabase();
    latestProcess().reply(latestProcess().messages.at(-1) as PostedMessage, { initialized: true });
    const database = await databasePromise;

    const resultPromise = database.transaction(async (tx) => {
      const queryPromise = tx.query('SELECT 1');
      const queryMessage = latestProcess().messages.at(-1);
      expect(queryMessage).toMatchObject({
        request: { kind: 'transaction:query', transactionId: 'tx-1', sql: 'SELECT 1' },
      });
      latestProcess().reply(queryMessage as PostedMessage, { rows: [{ value: 1 }] });
      return (await queryPromise).rows[0];
    });

    const txStart = latestProcess().messages.at(-1);
    expect(txStart).toMatchObject({ request: { kind: 'transaction:start' } });
    latestProcess().reply(txStart as PostedMessage, { transactionId: 'tx-1' });
    await flushMicrotasks();
    await flushMicrotasks();

    const commitMessage = latestProcess().messages.at(-1);
    expect(commitMessage).toMatchObject({
      request: { kind: 'transaction:commit', transactionId: 'tx-1' },
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
    expect(txStart).toMatchObject({ request: { kind: 'transaction:start' } });
    latestProcess().reply(txStart as PostedMessage, { transactionId: 'tx-1' });
    await flushMicrotasks();

    const rollbackMessage = latestProcess().messages.at(-1);
    expect(rollbackMessage).toMatchObject({
      request: { kind: 'transaction:rollback', transactionId: 'tx-1' },
    });
    latestProcess().reply(rollbackMessage as PostedMessage, { rolledBack: true });

    await expect(resultPromise).rejects.toThrow('callback failed');
  });
});
