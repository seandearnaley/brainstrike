import { type ActionRegistry, createTestActionRegistry } from '@brainstrike/context-actions';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { ActionRegistryProvider, TooltipProvider } from '@brainstrike/ui';
import type { ReactNode } from 'react';
import { FileExplorerProvider } from '../shell/file-explorer-provider';
import { type DeleteRootData, RootDataDeletionProvider } from '../shell/root-data-deletion-context';

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
  // Optional so callers may nest children as createElement's third argument
  // instead of a children prop (react-doctor/no-children-prop).
  children?: ReactNode;
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

/**
 * Factory for a FileExplorerTestWrapper that optionally nests a
 * RootDataDeletionProvider, reading `deleteRootData` fresh on every render
 * via `getDeleteRootData` (a plain closure getter, not a React value) —
 * this lets a test swap the callback between renders (e.g. to prove a
 * consumer's memoization picks up the new identity instead of a stale
 * closure) without needing the wrapper component itself to accept props
 * from `rerender`, which RTL's `renderHook` does not thread through.
 * `children` stays optional (matching FileExplorerTestWrapper above) purely
 * for its own sake — real JSX here needs no createElement workaround either
 * way.
 */
export function createDeletionTestWrapper(
  storageAdapter: MemoryStorageAdapter,
  getDeleteRootData: () => DeleteRootData | undefined
) {
  return function DeletionTestWrapper({ children }: { children?: ReactNode }) {
    const deleteRootData = getDeleteRootData();
    return (
      <FileExplorerTestWrapper mockStorageAdapter={storageAdapter}>
        {deleteRootData ? (
          <RootDataDeletionProvider deleteRootData={deleteRootData}>
            {children}
          </RootDataDeletionProvider>
        ) : (
          children
        )}
      </FileExplorerTestWrapper>
    );
  };
}
