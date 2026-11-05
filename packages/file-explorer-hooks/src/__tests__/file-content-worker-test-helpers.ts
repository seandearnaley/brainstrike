import type { DirectoryHandle, FileHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';

// Mock file system adapter for tests
export class MockFileSystemAdapter implements FileSystemAdapter {
  // Store mock data that tests can modify
  static mockDirectoryData: Map<string, IFileNode[]> = new Map();
  static mockErrors: Map<string, Error> = new Map();
  static mockReadFileErrors: Map<string, Error> = new Map();
  static mockFileContents: Map<string, string> = new Map();

  static setMockDirectoryData(path: string, entries: IFileNode[]) {
    MockFileSystemAdapter.mockDirectoryData.set(path, entries);
  }

  static setMockDirectoryError(path: string, error: Error) {
    MockFileSystemAdapter.mockErrors.set(path, error);
  }

  static setMockReadFileError(filePath: string, error: Error) {
    MockFileSystemAdapter.mockReadFileErrors.set(filePath, error);
  }

  static setMockFileContent(filePath: string, content: string) {
    MockFileSystemAdapter.mockFileContents.set(filePath, content);
  }

  static clearMockData() {
    MockFileSystemAdapter.mockDirectoryData.clear();
    MockFileSystemAdapter.mockErrors.clear();
    MockFileSystemAdapter.mockReadFileErrors.clear();
    MockFileSystemAdapter.mockFileContents.clear();
  }

  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    return {
      kind: 'directory',
      name: 'mock-root',
      path: 'mock-root',
      platform: 'web',
    };
  }

  async readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
    const path = handle.path || handle.name;

    // Check if there's a mock error for this directory
    const error = MockFileSystemAdapter.mockErrors.get(path);
    if (error) {
      throw error;
    }

    const mockData = MockFileSystemAdapter.mockDirectoryData.get(path);
    if (mockData) {
      // Create a new array to avoid mutation issues
      return mockData.map((entry) => ({ ...entry }));
    }
    return [];
  }

  async readFile(handle: FileHandle): Promise<string> {
    const path = handle.path || handle.name;

    // Check if there's a mock error for this file
    const error = MockFileSystemAdapter.mockReadFileErrors.get(path);
    if (error) {
      throw error;
    }

    // Return custom content if set, otherwise default
    const customContent = MockFileSystemAdapter.mockFileContents.get(path);
    return customContent || 'test content';
  }

  async exists(_path: string): Promise<boolean> {
    return true;
  }
}
