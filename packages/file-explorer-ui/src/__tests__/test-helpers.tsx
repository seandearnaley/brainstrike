import { type ActionRegistry, createTestActionRegistry } from '@brainstrike/context-actions';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { ActionRegistryProvider, TooltipProvider } from '@brainstrike/ui';
import type { ReactNode } from 'react';
import { FileExplorerProvider } from '../shell/file-explorer-provider';

// Create default mock adapters for tests
const defaultTestFileSystemAdapter = new MockFileSystemAdapter();
const testStorageAdapter = new MemoryStorageAdapter();
// OptimizedFileTree mounts an ActionContextMenu, whose useActionRegistry
// throws without a provider — so the wrapper always supplies one. Tests that
// assert on action side effects (e.g. writtenTexts) pass their own registry.
const defaultActionRegistry = createTestActionRegistry().registry;

// Wrapper component that provides the necessary context for tests
export function FileExplorerTestWrapper({
  children,
  mockFileSystemAdapter,
  mockStorageAdapter,
  actionRegistry,
}: {
  children: ReactNode;
  mockFileSystemAdapter?: MockFileSystemAdapter;
  mockStorageAdapter?: MemoryStorageAdapter;
  actionRegistry?: ActionRegistry;
}) {
  const fileSystemAdapter = mockFileSystemAdapter || defaultTestFileSystemAdapter;
  const storageAdapter = mockStorageAdapter || testStorageAdapter;

  return (
    <ActionRegistryProvider registry={actionRegistry ?? defaultActionRegistry}>
      <TooltipProvider>
        <AdaptersProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
          <FileExplorerProvider storageAdapter={storageAdapter}>{children}</FileExplorerProvider>
        </AdaptersProvider>
      </TooltipProvider>
    </ActionRegistryProvider>
  );
}
