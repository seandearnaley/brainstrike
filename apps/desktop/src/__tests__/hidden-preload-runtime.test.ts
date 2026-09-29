import Module from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  databaseChunkingContract,
  databaseEmbeddingContract,
  databaseIntegrityContract,
} from '../ipc-domains/database.contract';

const { exposeInMainWorldMock, invokeMock, onMock, removeListenerMock, sendMock } = vi.hoisted(
  () => ({
    exposeInMainWorldMock: vi.fn(),
    invokeMock: vi.fn(),
    onMock: vi.fn(),
    removeListenerMock: vi.fn(),
    sendMock: vi.fn(),
  })
);

const mockElectron = {
  contextBridge: {
    exposeInMainWorld: exposeInMainWorldMock,
  },
  ipcRenderer: {
    invoke: invokeMock,
    on: onMock,
    removeListener: removeListenerMock,
    send: sendMock,
  },
};

type ModuleLoader = (this: typeof Module, id: string, ...rest: unknown[]) => unknown;
const moduleWithLoader = Module as unknown as { _load: ModuleLoader };
const originalLoad = moduleWithLoader._load;
moduleWithLoader._load = function (this: typeof Module, id: string, ...rest: unknown[]) {
  if (id === 'electron') {
    return mockElectron;
  }
  return originalLoad.call(this, id, ...rest);
};

const ROLE_ARGUMENT_PREFIX = '--brainstrike-hidden-renderer-role=';
const originalArgv = [...process.argv];

async function loadHiddenPreload(roleArguments: readonly string[]): Promise<Map<string, unknown>> {
  process.argv = [
    ...originalArgv.filter((argument) => !argument.startsWith(ROLE_ARGUMENT_PREFIX)),
    ...roleArguments,
  ];
  vi.resetModules();
  await import('../hidden-preload');
  return new Map(exposeInMainWorldMock.mock.calls as [string, unknown][]);
}

describe('hidden preload runtime capability manifest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.argv = [...originalArgv];
  });

  it.each([
    ['chunking-host', ['chunkingHost', 'electronAPI', 'logging', 'parserHost']],
    ['embedding-host', ['databaseIntegrity', 'electronAPI', 'embeddingHost', 'logging', 'power']],
    ['llm-host', ['llmHost', 'logging']],
  ] as const)('exposes only the %s capability manifest', async (role, expectedGlobals) => {
    const exposed = await loadHiddenPreload([`${ROLE_ARGUMENT_PREFIX}${role}`]);

    expect([...exposed.keys()].sort()).toEqual([...expectedGlobals].sort());
    expect(exposed.has('secrets')).toBe(false);
    expect(exposed.has('assistant')).toBe(false);
    // The MCP bridge (and with it `mcp.tasks` and `mcp.apps`) is visible-UI only.
    expect(exposed.has('mcp')).toBe(false);
  });

  it('preserves the embedding host power snapshot capability', async () => {
    invokeMock.mockResolvedValueOnce({ onBattery: true, thermalState: 'serious' });
    const exposed = await loadHiddenPreload([`${ROLE_ARGUMENT_PREFIX}embedding-host`]);
    const power = exposed.get('power') as { getSnapshot?: () => Promise<unknown> } | undefined;

    await expect(power?.getSnapshot?.()).resolves.toEqual({
      onBattery: true,
      thermalState: 'serious',
    });
    expect(invokeMock).toHaveBeenCalledWith('app:power-snapshot');
  });

  it.each([
    ['chunking-host', databaseChunkingContract],
    ['embedding-host', databaseEmbeddingContract],
  ] as const)(
    'derives the %s database capability without extra methods',
    async (role, contract) => {
      const exposed = await loadHiddenPreload([`${ROLE_ARGUMENT_PREFIX}${role}`]);
      const electronAPI = exposed.get('electronAPI') as
        | { db?: Record<string, (...args: unknown[]) => Promise<unknown>> }
        | undefined;

      expect(Object.keys(electronAPI?.db ?? {}).sort()).toEqual(Object.keys(contract).sort());
      invokeMock.mockResolvedValueOnce({ rows: [] });
      await electronAPI?.db?.['query']?.('SELECT 1');
      expect(invokeMock).toHaveBeenLastCalledWith('db:query', 'SELECT 1');
    }
  );
  it('keeps each hidden role bridge at its exact runtime key set', async () => {
    const chunking = await loadHiddenPreload([`${ROLE_ARGUMENT_PREFIX}chunking-host`]);
    const chunkingApi = chunking.get('electronAPI') as { db: object };
    expect(Object.keys(chunkingApi).sort()).toEqual(['db']);
    expect(Object.keys(chunkingApi.db).sort()).toEqual(['query']);
    expect(Object.keys(chunking.get('chunkingHost') as object).sort()).toEqual([
      'onRequest',
      'reportResponse',
      'reportStatus',
    ]);

    const embedding = await loadHiddenPreload([`${ROLE_ARGUMENT_PREFIX}embedding-host`]);
    const embeddingApi = embedding.get('electronAPI') as {
      db: object;
      vectorPreferences: object;
    };
    expect(Object.keys(embeddingApi).sort()).toEqual(['db', 'vectorPreferences']);
    expect(Object.keys(embeddingApi.db).sort()).toEqual([
      'applyManagedCacheBatch',
      'diagnostics',
      'exec',
      'insertChunksAndEnqueueEmbeddingJobs',
      'invalidateManagedCacheEntriesByIdentity',
      'query',
      'runTransaction',
      'schedulerSnapshot',
      'test',
    ]);
    expect(Object.keys(embeddingApi.vectorPreferences).sort()).toEqual(['clear', 'read', 'write']);
    expect(Object.keys(embedding.get('embeddingHost') as object).sort()).toEqual([
      'onCommand',
      'onQueryEmbeddingRequest',
      'reportQueryEmbeddingResponse',
      'reportStatus',
    ]);
  });

  it('gives the embedding host the read-only database integrity capability', async () => {
    const exposed = await loadHiddenPreload([`${ROLE_ARGUMENT_PREFIX}embedding-host`]);
    const integrity = exposed.get('databaseIntegrity') as Record<
      string,
      (...args: unknown[]) => unknown
    >;

    expect(Object.keys(integrity).sort()).toEqual(Object.keys(databaseIntegrityContract).sort());
    const snapshot = { revision: 2, state: { kind: 'healthy' } };
    invokeMock.mockResolvedValueOnce({ ok: true, value: snapshot });
    await expect(integrity['getState']?.()).resolves.toEqual(snapshot);
    expect(invokeMock).toHaveBeenLastCalledWith('db:integrity:state');

    integrity['onChanged']?.(vi.fn());
    expect(onMock).toHaveBeenCalledWith('db:integrity:changed', expect.any(Function));
  });

  it('gives the embedding host a key-less vector preferences capability', async () => {
    invokeMock.mockResolvedValueOnce('{"state":{},"version":3}');
    const exposed = await loadHiddenPreload([`${ROLE_ARGUMENT_PREFIX}embedding-host`]);
    const electronAPI = exposed.get('electronAPI') as {
      storage?: unknown;
      vectorPreferences?: {
        clear: () => Promise<unknown>;
        read: () => Promise<unknown>;
        write: (value: string) => Promise<unknown>;
      };
    };

    // BST-1380: the host reads the SAME canonical record the visible UI writes,
    // but never receives the unrestricted key-value bridge.
    expect(electronAPI.storage).toBeUndefined();
    await expect(electronAPI.vectorPreferences?.read()).resolves.toBe('{"state":{},"version":3}');
    expect(invokeMock).toHaveBeenCalledWith('vector-preferences:read');

    await electronAPI.vectorPreferences?.write('{"state":{},"version":3}');
    expect(invokeMock).toHaveBeenCalledWith('vector-preferences:write', '{"state":{},"version":3}');

    await electronAPI.vectorPreferences?.clear();
    expect(invokeMock).toHaveBeenCalledWith('vector-preferences:clear');

    // No call may carry a renderer-chosen key — main pins the record.
    for (const call of invokeMock.mock.calls) {
      expect(call).not.toContain('vector-preferences.v1');
    }
  });

  it.each([
    ['chunking-host', 'electronAPI'],
    ['llm-host', 'electronAPI'],
  ] as const)(
    'withholds the vector preferences capability from the %s role',
    async (role, globalName) => {
      const exposed = await loadHiddenPreload([`${ROLE_ARGUMENT_PREFIX}${role}`]);
      const electronAPI = exposed.get(globalName) as
        | { storage?: unknown; vectorPreferences?: unknown }
        | undefined;

      expect(electronAPI?.vectorPreferences).toBeUndefined();
      expect(electronAPI?.storage).toBeUndefined();
    }
  );

  it.each([
    ['a missing role', []],
    ['an unsupported role', [`${ROLE_ARGUMENT_PREFIX}visible-ui`]],
    [
      'duplicate roles',
      [`${ROLE_ARGUMENT_PREFIX}embedding-host`, `${ROLE_ARGUMENT_PREFIX}llm-host`],
    ],
  ] as const)('fails closed for %s', async (_description, roleArguments) => {
    await expect(loadHiddenPreload(roleArguments)).rejects.toThrow(
      /hidden renderer|unsupported role/i
    );
    expect(exposeInMainWorldMock).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  moduleWithLoader._load = originalLoad;
});
