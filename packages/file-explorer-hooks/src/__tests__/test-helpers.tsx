import type { DirectoryHandle, FileHandle, FileSystemAdapter } from '@brainstrike/file-system';
import { createStorageAdapter } from '@brainstrike/storage';
import type { IFileNode } from '@brainstrike/types';
import type { ReactNode } from 'react';
import { AdaptersProvider } from '../adapters-context';

// Mock file system adapter for tests
class MockFileSystemAdapter implements FileSystemAdapter {
  // Store mock data that tests can modify
  static mockDirectoryData: Map<string, IFileNode[]> = new Map();
  static mockErrors: Map<string, Error> = new Map();
  static mockReadFileErrors: Map<string, Error> = new Map();
  static mockFileContents: Map<string, string> = new Map();
  static mockLastFolderPath: string | null = null;
  static mockRestoreError: Error | null = null;

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

  static setMockLastFolderPath(path: string | null) {
    MockFileSystemAdapter.mockLastFolderPath = path;
  }

  static setMockRestoreError(error: Error | null) {
    MockFileSystemAdapter.mockRestoreError = error;
  }

  static clearMockData() {
    MockFileSystemAdapter.mockDirectoryData.clear();
    MockFileSystemAdapter.mockErrors.clear();
    MockFileSystemAdapter.mockReadFileErrors.clear();
    MockFileSystemAdapter.mockFileContents.clear();
    MockFileSystemAdapter.mockLastFolderPath = null;
    MockFileSystemAdapter.mockRestoreError = null;
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

  async restoreLastFolder(): Promise<DirectoryHandle | null> {
    if (MockFileSystemAdapter.mockRestoreError) {
      throw MockFileSystemAdapter.mockRestoreError;
    }

    if (!MockFileSystemAdapter.mockLastFolderPath) {
      return null;
    }

    return {
      kind: 'directory',
      name: MockFileSystemAdapter.mockLastFolderPath.split('/').pop() || 'unknown',
      path: MockFileSystemAdapter.mockLastFolderPath,
      platform: 'web',
    };
  }
}

// Create mock adapters for tests
const mockFileSystemAdapter = new MockFileSystemAdapter();
const mockStorageAdapter = createStorageAdapter('web');

// Wrapper component that provides the necessary context for tests
export function AdaptersTestWrapper({ children }: { children: ReactNode }) {
  return (
    <AdaptersProvider fileSystemAdapter={mockFileSystemAdapter} storageAdapter={mockStorageAdapter}>
      {children}
    </AdaptersProvider>
  );
}

// Export the mock adapter for test manipulation
export { MockFileSystemAdapter };
