import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Electron modules using vi.hoisted to handle CommonJS require
const { mockContextBridge, mockIpcRenderer } = vi.hoisted(() => {
  const mockContextBridge = {
    exposeInMainWorld: vi.fn(),
  };

  const mockIpcRenderer = {
    invoke: vi.fn(),
  };

  // Mock the CommonJS require for electron
  const { Module } = require('node:module');
  const originalLoad = Module._load;
  Module._load = (id: string, parent: NodeModule) => {
    if (id === 'electron') {
      return { contextBridge: mockContextBridge, ipcRenderer: mockIpcRenderer };
    }
    return originalLoad(id, parent);
  };

  return { mockContextBridge, mockIpcRenderer };
});

// Also mock the ES module import for completeness
vi.mock('electron', () => ({
  contextBridge: mockContextBridge,
  ipcRenderer: mockIpcRenderer,
}));

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
    vi.clearAllMocks();
    mockContextBridge.exposeInMainWorld.mockClear();
    mockIpcRenderer.invoke.mockClear();

    // Import the preload script which should trigger the mocked contextBridge
    await import('../preload.ts');

    // Extract the API from the mock call
    const mockCalls = mockContextBridge.exposeInMainWorld.mock.calls;
    if (mockCalls.length > 0 && mockCalls[0]) {
      api = mockCalls[0][1] as typeof api;
    }
  });

  it('should expose the expected electronAPI via contextBridge', () => {
    expect(mockContextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [key, exposed] = mockContextBridge.exposeInMainWorld.mock.calls[0] as [string, unknown];

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
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('storage:getItem', 'test-key');

    api.storage.setItem('test-key', 'test-value');
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
      'storage:setItem',
      'test-key',
      'test-value'
    );

    api.storage.removeItem('test-key');
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('storage:removeItem', 'test-key');

    api.storage.clear();
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('storage:clear');

    api.storage.getAllKeys();
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('storage:getAllKeys');
  });

  it('should call correct IPC channels for file system operations', () => {
    expect(api).toBeDefined();
    api.fileSystem.requestDirectoryAccess();
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('fs:requestDirectoryAccess');

    const mockHandle: DirectoryHandle = {
      path: '/test',
      name: 'test',
      kind: 'directory',
      platform: 'electron',
    };
    api.fileSystem.readDirectory(mockHandle);
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('fs:readDirectory', mockHandle);

    const mockFileHandle: FileHandle = {
      path: '/test/file.txt',
      name: 'file.txt',
      kind: 'file',
      platform: 'electron',
    };
    api.fileSystem.readFile(mockFileHandle);
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('fs:readFile', mockFileHandle);

    api.fileSystem.exists('/test/path');
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('fs:exists', '/test/path');
  });
});
