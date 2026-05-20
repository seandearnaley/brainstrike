import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { TooltipProvider } from '@brainstrike/ui';
import type { ReactNode } from 'react';
import { FileExplorerProvider } from '../shell/file-explorer-provider';

// Create default mock adapters for tests
const defaultTestFileSystemAdapter = new MockFileSystemAdapter();
const testStorageAdapter = new MemoryStorageAdapter();

// Wrapper component that provides the necessary context for tests
export function FileExplorerTestWrapper({
  children,
  mockFileSystemAdapter,
  mockStorageAdapter,
}: {
  children: ReactNode;
  mockFileSystemAdapter?: MockFileSystemAdapter;
  mockStorageAdapter?: MemoryStorageAdapter;
}) {
  const fileSystemAdapter = mockFileSystemAdapter || defaultTestFileSystemAdapter;
  const storageAdapter = mockStorageAdapter || testStorageAdapter;

  return (
    <TooltipProvider>
      <AdaptersProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
        <FileExplorerProvider storageAdapter={storageAdapter}>{children}</FileExplorerProvider>
      </AdaptersProvider>
    </TooltipProvider>
  );
}
