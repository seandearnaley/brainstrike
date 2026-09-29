import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface PostedRequest {
  readonly id: string;
  readonly request: { readonly kind: string };
}

class FakeUtilityProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly messages: PostedRequest[] = [];
  readonly postMessage = vi.fn((message: PostedRequest) => {
    this.messages.push(message);
  });
  pid: number | undefined = 42;
}

const forkMock = vi.hoisted(() => vi.fn());
const dbMainMocks = vi.hoisted(() => ({
  closeDatabase: vi.fn(),
  getDatabase: vi.fn(),
  getDatabaseDiagnostics: vi.fn(() => ({ hasDatabaseHandle: true })),
  initializeMainDatabase: vi.fn(),
  resetLocalDatabase: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/userData'), isPackaged: false },
  utilityProcess: { fork: forkMock },
}));
vi.mock('../../db-main', () => dbMainMocks);

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');

function restoreParentPort(): void {
  Object.defineProperty(
    process,
    'parentPort',
    originalParentPortDescriptor ?? { configurable: true, value: undefined, writable: true }
  );
}

function latestProcess(): FakeUtilityProcess {
  const utilityProcess = forkMock.mock.results.at(-1)?.value;
  if (!(utilityProcess instanceof FakeUtilityProcess)) {
    throw new Error('Expected fake utility process to be forked.');
  }
  return utilityProcess;
}

/** Runs a query that fails inside the real DB-host entry and returns the wire response. */
async function failInsideHost(failure: Error): Promise<{ readonly error: unknown }> {
  const listeners: ((message: unknown) => void)[] = [];
  const postMessage = vi.fn();
  const parentPort = {
    on: vi.fn((_event: 'message', listener: (message: unknown) => void) => {
      listeners.push(listener);
      return parentPort;
    }),
    postMessage,
  };
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: parentPort,
    writable: true,
  });
  dbMainMocks.getDatabase.mockResolvedValue({ query: vi.fn(() => Promise.reject(failure)) });
  await import('../../db-host-entry');

  // Electron's parentPort delivers `{ data: envelope }`; post the production shape.
  listeners[0]?.({
    data: {
      id: 'host-request',
      kind: 'request',
      request: { kind: 'query', params: [], sql: 'SELECT 1' },
    },
  });
  await vi.waitFor(() => {
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });
  const response = postMessage.mock.calls
    .map(([message]) => message as { ok?: boolean; error?: unknown })
    .find((message) => message.ok === false);
  if (!response) {
    throw new Error('Expected the DB host to post an error response.');
  }
  return { error: response.error };
}

describe('DB host error transport', () => {
  beforeEach(() => {
    vi.resetModules();
    forkMock.mockReset();
    forkMock.mockImplementation(() => new FakeUtilityProcess());
    dbMainMocks.getDatabase.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
    restoreParentPort();
  });

  it('round-trips SQLSTATE and identifier-only fields into a classifiable error, never row data', async () => {
    const { error: wireError } = await failInsideHost(
      Object.assign(new Error('index "idx_chunks" contains unexpected zero page'), {
        code: 'XX002',
        detail: 'Key (secret)=(user row data) is broken.',
        file: 'nbtpage.c',
        routine: '_bt_checkpage',
        schema: 'public',
        table: 'brainstrike_chunks',
        where: 'SQL statement "SELECT secret FROM brainstrike_chunks"',
      })
    );

    const { createDbHostManager } = await import('../../db-host-manager');
    const { classifyDatabaseCorruption } = await import('../../database-corruption-classifier');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });
    const databasePromise = manager.getDatabase();
    const initMessage = latestProcess().messages.at(-1) as PostedRequest;
    latestProcess().emit('message', {
      id: initMessage.id,
      kind: 'response',
      ok: true,
      result: { initialized: true },
    });
    const database = await databasePromise;

    const queryPromise = database.query('SELECT 1');
    await vi.waitFor(() => {
      expect(latestProcess().messages.at(-1)?.request.kind).toBe('query');
    });
    const queryMessage = latestProcess().messages.at(-1) as PostedRequest;
    latestProcess().emit('message', {
      error: wireError,
      id: queryMessage.id,
      kind: 'response',
      ok: false,
    });

    const error = await queryPromise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      code: 'XX002',
      file: 'nbtpage.c',
      routine: '_bt_checkpage',
      schema: 'public',
      table: 'brainstrike_chunks',
    });
    expect(error).not.toHaveProperty('detail');
    expect(error).not.toHaveProperty('where');
    expect(classifyDatabaseCorruption(error)).toEqual({
      file: 'nbtpage.c',
      message: 'index "idx_chunks" contains unexpected zero page',
      routine: '_bt_checkpage',
      schema: 'public',
      sqlstate: 'XX002',
      table: 'brainstrike_chunks',
    });
  });
});
