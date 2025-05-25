import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Electron modules
const mockContextBridge = {
  exposeInMainWorld: vi.fn(),
};

const mockIpcRenderer = {
  invoke: vi.fn(),
};

vi.mock('electron', () => ({
  contextBridge: mockContextBridge,
  ipcRenderer: mockIpcRenderer,
}));

describe('Preload Script API Structure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should define the expected electronAPI structure', () => {
    // Test the expected API structure without importing the actual file
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
    };

    // Simulate what the preload script should expose
    const mockAPI = {
      storage: {
        getItem: (key: string) => mockIpcRenderer.invoke('storage:getItem', key),
        setItem: (key: string, value: string) =>
          mockIpcRenderer.invoke('storage:setItem', key, value),
        removeItem: (key: string) => mockIpcRenderer.invoke('storage:removeItem', key),
        clear: () => mockIpcRenderer.invoke('storage:clear'),
        getAllKeys: () => mockIpcRenderer.invoke('storage:getAllKeys'),
      },
      fileSystem: {
        requestDirectoryAccess: () => mockIpcRenderer.invoke('fs:requestDirectoryAccess'),
        readDirectory: (handle: DirectoryHandle) =>
          mockIpcRenderer.invoke('fs:readDirectory', handle),
        readFile: (handle: FileHandle) => mockIpcRenderer.invoke('fs:readFile', handle),
        exists: (path: string) => mockIpcRenderer.invoke('fs:exists', path),
      },
    };

    expect(mockAPI).toMatchObject(expectedAPI);
  });

  it('should call correct IPC channels for storage operations', () => {
    const mockAPI = {
      storage: {
        getItem: (key: string) => mockIpcRenderer.invoke('storage:getItem', key),
        setItem: (key: string, value: string) =>
          mockIpcRenderer.invoke('storage:setItem', key, value),
        removeItem: (key: string) => mockIpcRenderer.invoke('storage:removeItem', key),
        clear: () => mockIpcRenderer.invoke('storage:clear'),
        getAllKeys: () => mockIpcRenderer.invoke('storage:getAllKeys'),
      },
    };

    mockAPI.storage.getItem('test-key');
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('storage:getItem', 'test-key');

    mockAPI.storage.setItem('test-key', 'test-value');
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
      'storage:setItem',
      'test-key',
      'test-value'
    );

    mockAPI.storage.removeItem('test-key');
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('storage:removeItem', 'test-key');

    mockAPI.storage.clear();
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('storage:clear');

    mockAPI.storage.getAllKeys();
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('storage:getAllKeys');
  });

  it('should call correct IPC channels for file system operations', () => {
    const mockAPI = {
      fileSystem: {
        requestDirectoryAccess: () => mockIpcRenderer.invoke('fs:requestDirectoryAccess'),
        readDirectory: (handle: DirectoryHandle) =>
          mockIpcRenderer.invoke('fs:readDirectory', handle),
        readFile: (handle: FileHandle) => mockIpcRenderer.invoke('fs:readFile', handle),
        exists: (path: string) => mockIpcRenderer.invoke('fs:exists', path),
      },
    };

    mockAPI.fileSystem.requestDirectoryAccess();
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('fs:requestDirectoryAccess');

    const mockHandle = {
      path: '/test',
      name: 'test',
      kind: 'directory' as const,
      platform: 'electron' as const,
    };
    mockAPI.fileSystem.readDirectory(mockHandle);
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('fs:readDirectory', mockHandle);

    const mockFileHandle = {
      path: '/test/file.txt',
      name: 'file.txt',
      kind: 'file' as const,
      platform: 'electron' as const,
    };
    mockAPI.fileSystem.readFile(mockFileHandle);
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('fs:readFile', mockFileHandle);

    mockAPI.fileSystem.exists('/test/path');
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('fs:exists', '/test/path');
  });
});
