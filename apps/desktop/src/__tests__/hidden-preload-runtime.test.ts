import Module from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    ['embedding-host', ['electronAPI', 'embeddingHost', 'logging', 'power']],
    ['llm-host', ['llmHost', 'logging']],
  ] as const)('exposes only the %s capability manifest', async (role, expectedGlobals) => {
    const exposed = await loadHiddenPreload([`${ROLE_ARGUMENT_PREFIX}${role}`]);

    expect([...exposed.keys()].sort()).toEqual([...expectedGlobals].sort());
    expect(exposed.has('secrets')).toBe(false);
    expect(exposed.has('assistant')).toBe(false);
  });

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
