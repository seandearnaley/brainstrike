import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ParentPortMock {
  readonly on: (event: 'message', listener: (message: unknown) => void) => ParentPortMock;
  readonly postMessage: ReturnType<typeof vi.fn>;
}

const dbMainMocks = vi.hoisted(() => ({
  closeDatabase: vi.fn(),
  getDatabase: vi.fn(),
  getDatabaseDiagnostics: vi.fn(() => ({ hasDatabaseHandle: true })),
  initializeMainDatabase: vi.fn(),
  resetLocalDatabase: vi.fn(),
}));

vi.mock('../../db-main', () => dbMainMocks);

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');

function restoreParentPort(): void {
  if (originalParentPortDescriptor) {
    Object.defineProperty(process, 'parentPort', originalParentPortDescriptor);
    return;
  }

  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: undefined,
    writable: true,
  });
}

function installParentPortMock(): {
  readonly listeners: readonly ((message: unknown) => void)[];
  readonly parentPort: ParentPortMock;
} {
  const listeners: ((message: unknown) => void)[] = [];
  const parentPort: ParentPortMock = {
    on: vi.fn((event: 'message', listener: (message: unknown) => void) => {
      if (event === 'message') {
        listeners.push(listener);
      }
      return parentPort;
    }),
    postMessage: vi.fn(),
  };

  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: parentPort,
    writable: true,
  });

  return { listeners, parentPort };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('db-host-entry', () => {
  beforeEach(() => {
    vi.resetModules();
    dbMainMocks.closeDatabase.mockReset();
    dbMainMocks.getDatabase.mockReset();
    dbMainMocks.getDatabaseDiagnostics.mockReset();
    dbMainMocks.getDatabaseDiagnostics.mockReturnValue({ hasDatabaseHandle: true });
    dbMainMocks.initializeMainDatabase.mockReset();
    dbMainMocks.initializeMainDatabase.mockResolvedValue(undefined);
    dbMainMocks.resetLocalDatabase.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
    restoreParentPort();
  });

  it('unwraps Electron utility process MessageEvent envelopes before handling requests', async () => {
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    expect(listeners).toHaveLength(1);
    listeners[0]?.({
      data: {
        id: 'init-request',
        kind: 'request',
        request: { kind: 'init' },
      },
    });
    await flushMicrotasks();

    expect(dbMainMocks.initializeMainDatabase).toHaveBeenCalledTimes(1);
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      id: 'init-request',
      kind: 'response',
      ok: true,
      result: { initialized: true },
    });
    expect(parentPort.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'unknown' })
    );
  });

  it('emits source-tagged lifecycle logs from the utility process', async () => {
    const { parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    expect(parentPort.postMessage).toHaveBeenCalledWith({
      context: expect.objectContaining({
        logSource: 'db-host',
        pid: process.pid,
        runtime: 'db-host',
      }),
      kind: 'log',
      level: 'info',
      message: 'DB host process started',
    });
  });

  it('rejects non-array query params before calling PGlite', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    dbMainMocks.getDatabase.mockResolvedValue({ query });
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    listeners[0]?.({
      data: {
        id: 'query-request',
        kind: 'request',
        request: {
          kind: 'query',
          sql: 'SELECT $1',
          params: { value: 'not-array-params' },
        },
      },
    });
    await flushMicrotasks();

    expect(query).not.toHaveBeenCalled();
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'DB host query params must be an array when provided.',
        }),
        id: 'query-request',
        kind: 'response',
        ok: false,
      })
    );
  });

  it('escapes literal percents for live query params before calling PGlite', async () => {
    const liveQuery = vi.fn(async () => ({
      initialResults: { rows: [] },
      refresh: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    }));
    dbMainMocks.getDatabase.mockResolvedValue({
      live: { query: liveQuery },
      query: vi.fn(async () => ({ rows: [] })),
    });
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    listeners[0]?.({
      data: {
        id: 'live-start-request',
        kind: 'request',
        request: {
          kind: 'live:start',
          payload: {
            query: "SELECT * FROM file_records WHERE path LIKE '%' || $1 || '%'",
            params: ['needle'],
          },
        },
      },
    });
    await flushMicrotasks();

    expect(liveQuery).toHaveBeenCalledWith({
      query: "SELECT * FROM file_records WHERE path LIKE '%%' || $1 || '%%'",
      params: ['needle'],
    });
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'live-start-request',
        kind: 'response',
        ok: true,
      })
    );
  });
});
