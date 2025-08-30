import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type { createContextBridgeMock, createIpcRendererMock } from '@brainstrike/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { contextBridgeMock, ipcRendererMock } = vi.hoisted(() => {
  return {
    contextBridgeMock: {
      exposeInMainWorld: vi.fn(),
    },
    ipcRendererMock: {
      invoke: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
      send: vi.fn(),
    },
  } as const;
});

vi.mock('electron', () => ({
  contextBridge: contextBridgeMock,
  ipcRenderer: ipcRendererMock,
}));

import { contextBridge, ipcRenderer } from 'electron';

let api: {
  storage: {
    getItem: (key: string) => unknown;
    setItem: (key: string, value: string) => unknown;
    removeItem: (key: string) => unknown;
    clear: () => unknown;
    getAllKeys: () => unknown;
  };
  fileSystem: {
    requestDirectoryAccess: () => unknown;
    readDirectory: (handle: DirectoryHandle) => unknown;
    readFile: (handle: FileHandle) => unknown;
    exists: (path: string) => unknown;
  };
};

describe('Preload Script API Structure', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    (
      contextBridge as unknown as ReturnType<typeof createContextBridgeMock>
    ).exposeInMainWorld.mockClear();
    (ipcRenderer as unknown as ReturnType<typeof createIpcRendererMock>).invoke.mockClear();

    // Ensure CommonJS require('electron') paths are also mocked for preload
    const { installElectronCjsMocks } = await import('@brainstrike/test-utils');
    installElectronCjsMocks({
      contextBridge: contextBridgeMock,
      ipcRenderer: ipcRendererMock,
    });

    // Import the preload script which should trigger the mocked contextBridge
    await import('../preload.ts');

    // Extract the API from the mock call
    const mockCalls = (contextBridge as unknown as ReturnType<typeof createContextBridgeMock>)
      .exposeInMainWorld.mock.calls;
    if (mockCalls.length > 0 && mockCalls[0]) {
      api = mockCalls[0][1] as typeof api;
    }
  });

  it('should expose the expected electronAPI via contextBridge', () => {
    expect(contextBridgeMock.exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [key, exposed] = contextBridgeMock.exposeInMainWorld.mock.calls[0] as [string, unknown];

    const expectedAPI = {
      storage: {
        getItem: expect.any(Function),
        setItem: expect.any(Function),
        removeItem: expect.any(Function),
        clear: expect.any(Function),
        getAllKeys: expect.any(Function),
      },
      fileSystem: {
        requestDirectoryAccess: expect.any(Function),
        readDirectory: expect.any(Function),
        readFile: expect.any(Function),
        exists: expect.any(Function),
      },
      getUserDataPath: expect.any(Function),
    };

    expect(key).toBe('electronAPI');
    expect(exposed).toMatchObject(expectedAPI);
  });

  it('should call correct IPC channels for storage operations', () => {
    expect(api).toBeDefined();
    api.storage.getItem('test-key');
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith('storage:getItem', 'test-key');

    api.storage.setItem('test-key', 'test-value');
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith(
      'storage:setItem',
      'test-key',
      'test-value'
    );

    api.storage.removeItem('test-key');
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith('storage:removeItem', 'test-key');

    api.storage.clear();
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith('storage:clear');

    api.storage.getAllKeys();
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith('storage:getAllKeys');
  });

  it('should call correct IPC channels for file system operations', () => {
    expect(api).toBeDefined();
    api.fileSystem.requestDirectoryAccess();
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith('fs:requestDirectoryAccess');

    const mockHandle: DirectoryHandle = {
      path: '/test',
      name: 'test',
      kind: 'directory',
      platform: 'electron',
    };
    api.fileSystem.readDirectory(mockHandle);
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith('fs:readDirectory', mockHandle);

    const mockFileHandle: FileHandle = {
      path: '/test/file.txt',
      name: 'file.txt',
      kind: 'file',
      platform: 'electron',
    };
    api.fileSystem.readFile(mockFileHandle);
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith('fs:readFile', mockFileHandle);

    api.fileSystem.exists('/test/path');
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith('fs:exists', '/test/path');
  });
});
