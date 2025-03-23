import { TextDecoder } from 'node:util';

// Add TextDecoder to global scope if not already defined
if (typeof global.TextDecoder === 'undefined') {
  (global as { TextDecoder: typeof TextDecoder }).TextDecoder = TextDecoder;
}

// Mock FileSystemHandle implementation
export class MockFileSystemHandle implements FileSystemHandle {
  public readonly kind: 'file' | 'directory';
  public readonly name: string;
  protected _mockIsSameEntry?: (other: FileSystemHandle) => Promise<boolean>;
  protected _mockGetParent?: () => Promise<FileSystemHandle | null>;

  constructor(
    name: string,
    kind: 'file' | 'directory' = 'file',
    mockIsSameEntry?: (other: FileSystemHandle) => Promise<boolean>,
    mockGetParent?: () => Promise<FileSystemHandle | null>
  ) {
    this.name = name;
    this.kind = kind;
    this._mockIsSameEntry = mockIsSameEntry;
    this._mockGetParent = mockGetParent;
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    if (this._mockIsSameEntry) {
      return this._mockIsSameEntry(other);
    }
    // Default implementation compares name and kind
    return this.name === other.name && this.kind === other.kind;
  }

  async getParent(): Promise<FileSystemHandle | null> {
    if (this._mockGetParent) {
      return this._mockGetParent();
    }
    // Default implementation returns null (root directory)
    return null;
  }

  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }

  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }

  setMockIsSameEntry(mock: (other: FileSystemHandle) => Promise<boolean>) {
    this._mockIsSameEntry = mock;
  }

  setMockGetParent(mock: () => Promise<FileSystemHandle | null>) {
    this._mockGetParent = mock;
  }
}

// Create self-referential mocks using a factory function
export function createSelfReferencingHandle(name: string): MockFileSystemHandle {
  const handle = new MockFileSystemHandle(
    name,
    'directory',
    async (other: FileSystemHandle): Promise<boolean> => other === handle
  );
  return handle;
}

// Create circular references using a factory function
export function createCircularHandles(): [MockFileSystemHandle, MockFileSystemHandle] {
  // Create handles first
  const handle1 = new MockFileSystemHandle('dir1', 'directory');
  const handle2 = new MockFileSystemHandle('dir2', 'directory');

  // Then set up circular references
  handle1.setMockIsSameEntry(
    async (other: FileSystemHandle): Promise<boolean> => other === handle1
  );
  handle2.setMockIsSameEntry(
    async (other: FileSystemHandle): Promise<boolean> => other === handle2
  );

  return [handle1, handle2];
}

// Common mock implementations
export const mockFileHandle = {
  getFile: jest.fn().mockResolvedValue({
    text: jest.fn().mockResolvedValue('test content'),
  }),
  kind: 'file' as const,
  name: 'test.txt',
};

export const mockDirectoryHandle = {
  kind: 'directory' as const,
  name: 'test-directory',
};
