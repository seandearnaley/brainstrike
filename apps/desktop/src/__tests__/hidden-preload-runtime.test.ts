import Module from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sourceFilesContract } from '../ipc-domains/source-files.contract';

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
    ['chunking-host', ['chunkingHost', 'sourceFiles', 'logging', 'parserHost']],
    ['embedding-host', ['electronAPI', 'embeddingHost', 'logging', 'modelCatalog', 'power']],
    ['llm-host', ['llmHost', 'logging']],
  ] as const)('exposes only the %s capability manifest', async (role, expectedGlobals) => {
    const exposed = await loadHiddenPreload([`${ROLE_ARGUMENT_PREFIX}${role}`]);

    expect([...exposed.keys()].sort()).toEqual([...expectedGlobals].sort());
    expect(exposed.has('viewFilterPresets')).toBe(false);
    expect(exposed.has('secrets')).toBe(false);
    expect(exposed.has('assistant')).toBe(false);
    // The MCP bridge (and with it `mcp.tasks` and `mcp.apps`) is visible-UI only.
    expect(exposed.has('mcp')).toBe(false);
  });

  it('gives native inference read-only catalog access without database authority', async () => {
    const exposed = await loadHiddenPreload([`${ROLE_ARGUMENT_PREFIX}embedding-host`]);
    const catalog = exposed.get('modelCatalog') as { read(): Promise<unknown> };
    expect(Object.keys(catalog)).toEqual(['read']);
    invokeMock.mockResolvedValueOnce({ ok: true, value: { models: [], providers: [] } });
    await expect(catalog.read()).resolves.toEqual({ models: [], providers: [] });
    expect(exposed.get('electronAPI')).not.toHaveProperty('db');
    expect(exposed.has('databaseIntegrity')).toBe(false);
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

  it('gives chunking only canonical source reads without SQL or mutation authority', async () => {
    const exposed = await loadHiddenPreload([`${ROLE_ARGUMENT_PREFIX}chunking-host`]);
    const sources = exposed.get('sourceFiles') as {
      read: (ids: readonly string[], maxBytes: number) => Promise<unknown>;
    };
    expect(Object.keys(sources)).toEqual(['read']);
    expect(exposed.has('electronAPI')).toBe(false);
    const ids = ['file-1'];
    invokeMock.mockResolvedValueOnce({ ok: true, value: [] });
    await expect(sources.read(ids, 1024)).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenLastCalledWith(sourceFilesContract.read.channel, ids, 1024);
  });
  it('keeps each hidden role bridge at its exact runtime key set', async () => {
    const chunking = await loadHiddenPreload([`${ROLE_ARGUMENT_PREFIX}chunking-host`]);
    expect(chunking.has('electronAPI')).toBe(false);
    expect(Object.keys(chunking.get('sourceFiles') as object)).toEqual(['read']);
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
    expect(Object.keys(embeddingApi).sort()).toEqual(['vectorPreferences']);
    expect(embeddingApi).not.toHaveProperty('db');
    expect(Object.keys(embeddingApi.vectorPreferences).sort()).toEqual(['clear', 'read', 'write']);
    expect(Object.keys(embedding.get('embeddingHost') as object).sort()).toEqual([
      'onCommand',
      'onDocumentEmbeddingsCancel',
      'onDocumentEmbeddingsRequest',
      'onQueryEmbeddingCancel',
      'onQueryEmbeddingRequest',
      'onWebgpuAdapterRequest',
      'reportDocumentEmbeddingsResponse',
      'reportQueryEmbeddingResponse',
      'reportStatus',
      'reportWebgpuAdapterResponse',
    ]);
  });

  it('propagates catalog owner failure without database access', async () => {
    const exposed = await loadHiddenPreload([`${ROLE_ARGUMENT_PREFIX}embedding-host`]);
    const catalog = exposed.get('modelCatalog') as { read(): Promise<unknown> };
    invokeMock.mockResolvedValueOnce({
      error: { category: 'storage', code: 'closed', message: 'Catalog unavailable' },
      ok: false,
    });
    await expect(catalog.read()).rejects.toMatchObject({ category: 'storage', code: 'closed' });
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(exposed.has('databaseIntegrity')).toBe(false);
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
