import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAllowlistedSenderFrame,
  createTrustedInvokeEvent,
} from '../helpers/desktop-ipc-sender-test-helpers';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const { handlers, removeHandler } = vi.hoisted(() => {
  const registeredHandlers = new Map<string, IpcHandler>();
  return {
    handlers: registeredHandlers,
    removeHandler: vi.fn((channel: string) => {
      registeredHandlers.delete(channel);
    }),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  ipcMain: {
    handle: vi.fn((channel: string, listener: IpcHandler) => {
      handlers.set(channel, listener);
    }),
    on: vi.fn(),
    removeHandler,
    removeListener: vi.fn(),
  },
}));

// Fake main-process PGlite whose transaction() runs the callback against a tx that
// echoes the statements, so the db:transaction success path can be exercised without
// a real database.
const { transactionSpy } = vi.hoisted(() => ({ transactionSpy: vi.fn() }));
const { dbHostManagerMock } = vi.hoisted(() => ({
  dbHostManagerMock: {
    getDiagnostics: vi.fn(async () => ({ hostState: 'ready' })),
    getLiveQueryDiagnosticsForTests: vi.fn(async () => ({
      hostLiveQueryCount: 2,
      managerLiveQueryCount: 2,
    })),
    insertChunksAndEnqueueEmbeddingJobs: vi.fn(async () => undefined),
  },
}));
vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(async () => ({
    transaction: async (
      fn: (tx: {
        query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
      }) => Promise<unknown>
    ) => {
      const queries: { sql: string; params?: unknown[] }[] = [];
      const result = await fn({
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ params, sql });
          return { rows: [{ sql }] };
        },
      });
      transactionSpy(queries);
      return result;
    },
  })),
  handleRuntimeCorruption: vi.fn(),
}));
vi.mock('../../db-host-manager', () => ({
  getDbHostManager: vi.fn(() => dbHostManagerMock),
}));

import { registerDatabaseIpcHandlers } from '../../ipc-domains/db-ipc';

describe('database IPC domain', () => {
  let unregisterDatabaseHandlers: (() => void) | null = null;

  beforeEach(() => {
    handlers.clear();
    removeHandler.mockClear();
    dbHostManagerMock.getLiveQueryDiagnosticsForTests.mockClear();
    dbHostManagerMock.insertChunksAndEnqueueEmbeddingJobs.mockClear();
    unregisterDatabaseHandlers = registerDatabaseIpcHandlers({});
  });

  afterEach(() => {
    unregisterDatabaseHandlers?.();
    unregisterDatabaseHandlers = null;
  });

  it('registers lightweight diagnostics handlers and unregisters owned channels', async () => {
    await expect(handlers.get('db:ping')?.(createTrustedInvokeEvent())).resolves.toEqual({
      message: 'ping',
      success: true,
    });
    await expect(
      handlers.get('db:scheduler:snapshot')?.(createTrustedInvokeEvent())
    ).resolves.toMatchObject({
      queued: { background: 0, foreground: 0, normal: 0 },
      runningPriority: null,
    });

    const unregister = registerDatabaseIpcHandlers({});
    unregister();
    expect(removeHandler).toHaveBeenCalledWith('db:ping');
    expect(removeHandler).toHaveBeenCalledWith('db:scheduler:snapshot');
    expect(removeHandler).toHaveBeenCalledWith('db:live-query:start');
  });

  it('publishes and clears test-only live-query ownership diagnostics', async () => {
    const diagnosticsKey = '__brainstrike_e2e_db_live_query_diagnostics__' as const;
    const e2eGlobal = globalThis as typeof globalThis &
      Partial<
        Record<
          typeof diagnosticsKey,
          () => Promise<{
            hostLiveQueryCount: number;
            ipcLiveQueryCount: number;
            managerLiveQueryCount: number;
          }>
        >
      >;
    const unregister = unregisterDatabaseHandlers;
    if (!unregister) {
      throw new Error('Expected database IPC handlers to be registered for the test.');
    }
    const diagnostics = e2eGlobal[diagnosticsKey];
    if (!diagnostics) {
      throw new Error('Expected test-only live-query diagnostics to be registered.');
    }

    await expect(diagnostics()).resolves.toEqual({
      hostLiveQueryCount: 2,
      ipcLiveQueryCount: 0,
      managerLiveQueryCount: 2,
    });
    expect(dbHostManagerMock.getLiveQueryDiagnosticsForTests).toHaveBeenCalledTimes(1);

    unregister();
    unregisterDatabaseHandlers = null;
    expect(e2eGlobal[diagnosticsKey]).toBeUndefined();
  });

  it('rejects malformed renderer SQL before scheduling database work', async () => {
    await expect(
      handlers.get('db:query')?.(createTrustedInvokeEvent(), 'SELECT\0 1')
    ).rejects.toThrow('db:query SQL must not contain null bytes.');

    await expect(handlers.get('db:exec')?.(createTrustedInvokeEvent(), '')).rejects.toThrow(
      'db:exec SQL must be a non-empty string.'
    );
  });

  it('keeps raw renderer SQL inside the documented app-internal policy', async () => {
    await expect(
      handlers.get('db:query')?.(createTrustedInvokeEvent(), 'DROP TABLE file_records')
    ).rejects.toThrow('db:query does not permit destructive schema SQL from the renderer.');

    await expect(
      handlers.get('db:exec')?.(createTrustedInvokeEvent(), 'DROP TABLE file_records')
    ).rejects.toThrow('db:exec does not permit destructive schema SQL from the renderer.');

    await expect(
      handlers.get('db:exec')?.(createTrustedInvokeEvent(), 'DROP TYPE file_record_kind')
    ).rejects.toThrow('db:exec does not permit destructive schema SQL from the renderer.');

    await expect(
      handlers.get('db:exec')?.(
        createTrustedInvokeEvent(),
        'ALTER TABLE file_records DROP COLUMN path'
      )
    ).rejects.toThrow('db:exec does not permit destructive schema SQL from the renderer.');
  });

  it('validates the db:transaction statement list and guards each statement SQL', async () => {
    // Empty / non-array statement list is rejected before any DB work.
    await expect(
      handlers.get('db:transaction')?.(createTrustedInvokeEvent(), [], 0)
    ).rejects.toThrow('db:transaction requires a non-empty statements array.');

    // Every statement's SQL passes through the same assertRendererSql guard as db:query.
    await expect(
      handlers.get('db:transaction')?.(
        createTrustedInvokeEvent(),
        [{ sql: "SET LOCAL hnsw.ef_search = '1'" }, { sql: 'SELECT\0 1' }],
        0
      )
    ).rejects.toThrow('db:transaction SQL must not contain null bytes.');

    await expect(
      handlers.get('db:transaction')?.(
        createTrustedInvokeEvent(),
        [{ sql: 'DROP TABLE file_records' }],
        0
      )
    ).rejects.toThrow('db:transaction does not permit destructive schema SQL from the renderer.');
  });

  it('runs db:transaction statements through a single main-process transaction', async () => {
    const result = await handlers.get('db:transaction')?.(
      createTrustedInvokeEvent(),
      [
        { sql: "SET LOCAL hnsw.ef_search = '120'" },
        { params: ['set-1'], sql: 'SELECT id FROM file_chunks WHERE embedding_set_id = $1' },
      ],
      1
    );

    // The handler returns the rows of statements[resultIndex] (the SELECT).
    expect(result).toEqual({
      rows: [{ sql: 'SELECT id FROM file_chunks WHERE embedding_set_id = $1' }],
    });
    // Both statements ran inside ONE transaction() call, in order.
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    const ranSql = transactionSpy.mock.calls[0]?.[0]?.map((s: { sql: string }) => s.sql);
    expect(ranSql).toEqual([
      "SET LOCAL hnsw.ef_search = '120'",
      'SELECT id FROM file_chunks WHERE embedding_set_id = $1',
    ]);
  });

  it('forwards atomic chunk/job enqueue payloads to the DB host manager', async () => {
    const now = new Date().toISOString();
    await expect(
      handlers.get('db:chunks:insert-and-enqueue-embedding-jobs')?.(
        createTrustedInvokeEvent(),
        [
          {
            chunkIndex: 0,
            chunkSize: 12,
            chunkType: 'sentence',
            content: 'hello world',
            contentHash: 'chunk-hash',
            createdAt: now,
            fileRecordId: 'file-1',
            id: 'chunk-1',
            tokenCount: 2,
            updatedAt: now,
          },
        ],
        'file-1',
        {
          dimensionParameter: null,
          model: 'local::Xenova/all-MiniLM-L6-v2',
          provider: 'local',
          targetDimension: 384,
          targetEmbeddingSetId: 'workspace-index',
        },
        { label: 'workspace-index import', priority: 'background' }
      )
    ).resolves.toBeUndefined();

    expect(dbHostManagerMock.insertChunksAndEnqueueEmbeddingJobs).toHaveBeenCalledWith({
      chunks: [
        expect.objectContaining({
          contentHash: 'chunk-hash',
          fileRecordId: 'file-1',
          id: 'chunk-1',
        }),
      ],
      dimensionParameter: null,
      fileRecordId: 'file-1',
      model: 'local::Xenova/all-MiniLM-L6-v2',
      provider: 'local',
      targetDimension: 384,
      targetEmbeddingSetId: 'workspace-index',
    });
  });

  it('rejects malformed atomic chunk/job payloads before DB host scheduling', async () => {
    await expect(
      handlers.get('db:chunks:insert-and-enqueue-embedding-jobs')?.(
        createTrustedInvokeEvent(),
        [],
        'file-1',
        {
          model: 'local::Xenova/all-MiniLM-L6-v2',
          provider: 'local',
          targetDimension: 0,
        }
      )
    ).rejects.toThrow('Atomic chunk/job enqueue requires a positive targetDimension.');

    expect(dbHostManagerMock.insertChunksAndEnqueueEmbeddingJobs).not.toHaveBeenCalled();
  });

  // BST-1641: every `db:*` channel the embedding host holds in
  // `hidden-preload.ts` (`exposeEmbeddingElectronApiBridge`) besides the
  // shared `db:query` is sender-authorized for exactly the roles that hold it
  // in a preload manifest — the embedding host and the visible UI (the
  // chunking host holds only `db:query`; the llm host has no db bridge).
  // Each accepted case proves the handler ran (a guard it throws, or a result
  // only it produces); the chunking/llm hosts and untracked senders never get
  // there.
  describe('sender authorization', () => {
    type Invoke = () => Promise<unknown> | unknown;
    const rejectsWith =
      (guard: string) =>
      async (invoke: Invoke): Promise<void> => {
        await expect(invoke()).rejects.toThrow(guard);
      };
    const CASES: ReadonlyArray<
      readonly [
        channel: string,
        args: readonly unknown[],
        accepted: (invoke: Invoke) => Promise<void>,
      ]
    > = [
      ['db:exec', [''], rejectsWith('db:exec SQL must be a non-empty string.')],
      [
        'db:transaction',
        [[], 0],
        rejectsWith('db:transaction requires a non-empty statements array.'),
      ],
      [
        'db:diagnostics',
        [],
        async (invoke) => {
          await expect(invoke()).resolves.toEqual({ hostState: 'ready' });
        },
      ],
      [
        'db:scheduler:snapshot',
        [],
        async (invoke) => {
          await expect(invoke()).resolves.toMatchObject({ runningPriority: null });
        },
      ],
      [
        'db:managed-cache:apply-batch',
        [null],
        rejectsWith('Managed cache batch payload must be an object.'),
      ],
      [
        'db:managed-cache:invalidate-by-identity',
        [null],
        rejectsWith('Managed cache invalidation payload must be an object.'),
      ],
      [
        'db:chunks:insert-and-enqueue-embedding-jobs',
        [null],
        rejectsWith(
          'database insertChunksAndEnqueueEmbeddingJobs requires between 3 and 4 arguments'
        ),
      ],
      [
        'db:test',
        [],
        async (invoke) => {
          await expect(invoke()).resolves.toMatchObject({ dbLocation: 'DB Host' });
        },
      ],
    ];

    it.each(CASES)(
      '%s accepts the embedding host and the visible UI',
      async (channel, args, accepted) => {
        await accepted(() =>
          handlers.get(channel)?.(createTrustedInvokeEvent('embedding-host'), ...args)
        );
        await accepted(() =>
          handlers.get(channel)?.(createTrustedInvokeEvent('visible-ui'), ...args)
        );
      }
    );

    it.each(CASES)(
      '%s rejects the chunking host, the llm host, and an untracked sender',
      async (channel, args) => {
        const rejection = `Desktop IPC ${channel} requires sender role embedding-host, visible-ui.`;
        await expect(
          handlers.get(channel)?.(createTrustedInvokeEvent('chunking-host'), ...args)
        ).rejects.toThrow(rejection);
        await expect(
          handlers.get(channel)?.(createTrustedInvokeEvent('llm-host'), ...args)
        ).rejects.toThrow(rejection);
        await expect(
          handlers.get(channel)?.(
            {
              sender: { id: 777_001 },
              senderFrame: createAllowlistedSenderFrame(),
            } as unknown as IpcMainInvokeEvent,
            ...args
          )
        ).rejects.toThrow(rejection);
      }
    );

    it('authorizes db:query for both indexing hosts and the visible UI only', async () => {
      for (const role of ['chunking-host', 'embedding-host', 'visible-ui'] as const) {
        await expect(
          handlers.get('db:query')?.(createTrustedInvokeEvent(role), 42)
        ).rejects.toThrow('database query sql must be a string');
      }

      for (const role of ['llm-host'] as const) {
        await expect(
          handlers.get('db:query')?.(createTrustedInvokeEvent(role), 42)
        ).rejects.toThrow(
          'Desktop IPC db:query requires sender role chunking-host, embedding-host, visible-ui.'
        );
      }
      await expect(
        handlers.get('db:query')?.(
          {
            sender: { id: 777_002 },
            senderFrame: createAllowlistedSenderFrame(),
          } as unknown as IpcMainInvokeEvent,
          42
        )
      ).rejects.toThrow(
        'Desktop IPC db:query requires sender role chunking-host, embedding-host, visible-ui.'
      );
    });

    it.each([
      ['db:clearAll', [42], 'database clearAll confirmationToken must be a string when present'],
      ['db:getUserDataPath', ['extra'], 'database getUserDataPath requires exactly 0 arguments'],
      ['db:live-query:refresh', [], 'database live refresh requires between 1 and 2 arguments'],
      ['db:live-query:start', [], 'database live start requires between 1 and 2 arguments'],
      ['db:live-query:stop', ['1'], 'database live stop id must be a finite number'],
      ['db:ping', ['extra'], 'database ping requires exactly 0 arguments'],
      ['db:resetLocal', ['extra'], 'database resetLocal requires exactly 0 arguments'],
    ] as const)('%s is visible-UI-only', async (channel, args, acceptedGuard) => {
      await expect(
        handlers.get(channel)?.(createTrustedInvokeEvent('visible-ui'), ...args)
      ).rejects.toThrow(acceptedGuard);

      for (const role of ['chunking-host', 'embedding-host', 'llm-host'] as const) {
        await expect(
          handlers.get(channel)?.(createTrustedInvokeEvent(role), ...args)
        ).rejects.toThrow(`Desktop IPC ${channel} requires sender role visible-ui.`);
      }
    });
  });
});
