import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import type { ReactNode } from 'react';
import { FileExplorerProvider } from '../file-explorer-provider';

// Create mock adapters for tests
const testFileSystemAdapter = new MockFileSystemAdapter();
const testStorageAdapter = new MemoryStorageAdapter();

// Wrapper component that provides the necessary context for tests
export function FileExplorerTestWrapper({ children }: { children: ReactNode }) {
  return (
    <AdaptersProvider fileSystemAdapter={testFileSystemAdapter} storageAdapter={testStorageAdapter}>
      <FileExplorerProvider storageAdapter={testStorageAdapter}>{children}</FileExplorerProvider>
    </AdaptersProvider>
  );
}
