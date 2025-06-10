import { createFileExplorerStore } from '@brainstrike/file-explorer';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { TooltipProvider } from '@brainstrike/ui';
import type { ReactNode } from 'react';
import { FileExplorerProvider } from '../file-explorer-provider';

// Create default mock adapters for tests
const defaultTestFileSystemAdapter = new MockFileSystemAdapter();
const testStorageAdapter = new MemoryStorageAdapter();
const testStore = createFileExplorerStore(testStorageAdapter);

// Wrapper component that provides the necessary context for tests
export function FileExplorerTestWrapper({
  children,
  mockFileSystemAdapter,
}: {
  children: ReactNode;
  mockFileSystemAdapter?: MockFileSystemAdapter;
}) {
  const fileSystemAdapter = mockFileSystemAdapter || defaultTestFileSystemAdapter;

  return (
    <TooltipProvider>
      <AdaptersProvider
        fileSystemAdapter={fileSystemAdapter}
        storageAdapter={testStorageAdapter}
        fileExplorerStore={testStore}
      >
        <FileExplorerProvider store={testStore}>{children}</FileExplorerProvider>
      </AdaptersProvider>
    </TooltipProvider>
  );
}
