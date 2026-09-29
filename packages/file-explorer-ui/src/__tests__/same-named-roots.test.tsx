/**
 * Storage v5 regression: two roots with the SAME display name but different
 * RootIds must resolve distinct folder identities. This is the core collision
 * the RootId re-key kills — pre-v5, identity derived from the handle (name or
 * path), so same-named roots collided in folderStates and composite keys.
 *
 * Covered here (tree half — the store half lives in
 * packages/file-explorer/src/__tests__/use-file-explorer-store.folder-state-actions.test.ts):
 * - Each PerRootTreePane receives `folderId` = its root's RootId UUID.
 * - Both trees load content, and every loaded node satisfies the linchpin
 *   equality `fileNode.rootFolderId === folderId` for ITS root.
 */
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { createFileNode } from '@brainstrike/file-tree-test-fixtures';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import type { IFileNode } from '@brainstrike/types';
import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileExplorerSidebar from '../shell/file-explorer-sidebar';
import { FileExplorerTestWrapper } from './test-helpers';

// biome-ignore lint/suspicious/noVar: var required for vi.mock hoisting - let creates temporal dead zone
var OptimizedFileTreeMock: ReturnType<typeof vi.fn> | undefined;

vi.mock('../tree/optimized-file-tree', () => {
  OptimizedFileTreeMock = vi.fn(({ folderId }: { folderId: string }) => (
    <div data-folder-id={folderId} data-testid="optimized-file-tree" />
  ));
  return { default: OptimizedFileTreeMock };
});

const ROOT_ID_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const ROOT_ID_B = 'bbbbbbbb-0000-0000-0000-00000000000b';

// Same display name ("project"), different paths and different RootIds.
const handleA = {
  _internal: {} as FileSystemDirectoryHandle,
  kind: 'directory' as const,
  name: 'project',
  path: '/work/project',
  platform: 'web' as const,
};
const handleB = {
  _internal: {} as FileSystemDirectoryHandle,
  kind: 'directory' as const,
  name: 'project',
  path: '/personal/project',
  platform: 'web' as const,
};

describe('same-named roots resolve distinct RootId identities (storage v5)', () => {
  beforeEach(() => {
    OptimizedFileTreeMock?.mockClear();
  });

  it('gives each PerRootTreePane folderId = its RootId and stamps its nodes to match', async () => {
    // Both roots contain a file with the SAME relative layout — the classic
    // collision shape. The adapter returns per-path nodes; identity stamping
    // is the tree pipeline's job.
    const nodesA: IFileNode[] = [
      createFileNode({ name: 'index.ts', path: '/work/project/index.ts' }),
    ];
    const nodesB: IFileNode[] = [
      createFileNode({ name: 'index.ts', path: '/personal/project/index.ts' }),
    ];

    const adapter = new MockFileSystemAdapter();
    vi.spyOn(adapter, 'readDirectoryStreaming').mockImplementation(
      async (handle, onBatch, _opts) => {
        const nodes = handle.path === '/work/project' ? nodesA : nodesB;
        onBatch(nodes, { done: true, total: nodes.length });
      }
    );

    const Wrapper = composeWrappers(({ children }) => (
      <FileExplorerTestWrapper
        mockFileSystemAdapter={adapter}
        mockStorageAdapter={new MemoryStorageAdapter()}
      >
        {children}
      </FileExplorerTestWrapper>
    ));
    const renderWithProviders = makeRenderWithProviders(Wrapper);

    act(() => {
      renderWithProviders(
        <FileExplorerSidebar
          currentFolderId={ROOT_ID_A}
          filterError={null}
          isInitialLoad={false}
          isLoading={false}
          loadingFiles={new Set<string>()}
          quickFilteredTree={[]}
          rootDirectoryHandle={handleA}
          rootDirectoryHandles={[handleA, handleB]}
          rootIdByPath={
            new Map<string, string>([
              ['/work/project', ROOT_ID_A],
              ['/personal/project', ROOT_ID_B],
            ])
          }
          setFocusedRoot={vi.fn()}
          treeError={null}
        />
      );
    });

    // Both per-root trees load content (panes only render OptimizedFileTree
    // once their provider's tree is non-empty).
    await waitFor(() => {
      const mock = OptimizedFileTreeMock;
      if (!mock) {
        throw new Error('OptimizedFileTree mock not initialized');
      }
      const folderIds = new Set(
        mock.mock.calls.map((call) => (call[0] as { folderId: string }).folderId)
      );
      expect(folderIds.has(ROOT_ID_A)).toBe(true);
      expect(folderIds.has(ROOT_ID_B)).toBe(true);
    });

    const mock = OptimizedFileTreeMock;
    if (!mock) {
      throw new Error('OptimizedFileTree mock not initialized');
    }

    // Latest props per folderId — despite identical display names, the two
    // panes carry DISTINCT RootId identities.
    const latestByFolderId = new Map<string, { fileTree: IFileNode[]; folderId: string }>();
    for (const call of mock.mock.calls) {
      const props = call[0] as { fileTree: IFileNode[]; folderId: string };
      latestByFolderId.set(props.folderId, props);
    }
    expect(latestByFolderId.has(ROOT_ID_A)).toBe(true);
    expect(latestByFolderId.has(ROOT_ID_B)).toBe(true);

    // Linchpin equality holds per root: every node's rootFolderId equals the
    // folderId of the pane that renders it.
    for (const folderId of [ROOT_ID_A, ROOT_ID_B]) {
      const props = latestByFolderId.get(folderId);
      if (!props) {
        throw new Error(`Expected OptimizedFileTree props for ${folderId}`);
      }
      expect(props.fileTree.length).toBeGreaterThan(0);
      for (const node of props.fileTree) {
        expect(node.rootFolderId).toBe(folderId);
      }
    }
  });
});
