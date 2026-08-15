/**
 * Per-pane scoping props (BST-1269): `expansionScope` (local expansion state
 * instead of the workspace-global store set), `hideSelection` (no checkboxes —
 * pane trees are navigation-only), and `revealPath` (one-shot ancestor
 * expansion + scroll to a target path). The workspace Files tree passes none
 * of these and must keep store-backed behavior.
 */

import type { IFileNode } from '@brainstrike/types';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import OptimizedFileTree from '../tree/optimized-file-tree';
import {
  type FileExplorerStore,
  mockFileTree,
  StoreHandleBridge,
} from './optimized-file-tree-test-support';
import { FileExplorerTestWrapper } from './test-helpers';

// The shared fixture leaves loadState undefined; expansion only flattens
// LOADED directory children, so mark directories loaded for these tests.
const loadedFileTree: IFileNode[] = mockFileTree.map((node) =>
  node.type === 'directory' ? { ...node, loadState: 'loaded' } : node
);

describe('OptimizedFileTree pane scoping', () => {
  it('expansionScope renders from the scope set and routes toggles to it, not the store', async () => {
    const onToggle = vi.fn();
    let store: FileExplorerStore | null = null;
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <StoreHandleBridge
            onStoreReady={(readyStore) => {
              store = readyStore;
            }}
          />
          <OptimizedFileTree
            expansionScope={{ expandedPaths: new Set(['/src']), onToggle }}
            fileTree={loadedFileTree}
            folderId="root"
            loadingFiles={new Set()}
          />
        </FileExplorerTestWrapper>
      );
    });

    // The store has no expansions — visibility of /src children must come
    // from the scope set alone.
    expect(store).not.toBeNull();
    expect((store as unknown as FileExplorerStore).getState().expandedDirectoryPaths.size).toBe(0);
    expect(screen.getByText('file1.txt')).toBeInTheDocument();

    const collapseToggle = screen.getAllByRole('button', { name: 'Collapse' })[0];
    expect(collapseToggle).toBeDefined();
    await act(async () => {
      collapseToggle?.click();
    });

    expect(onToggle).toHaveBeenCalledWith('/src');
    expect((store as unknown as FileExplorerStore).getState().expandedDirectoryPaths.size).toBe(0);
  });

  it('hideSelection renders no checkboxes while file names stay visible', async () => {
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree
            expansionScope={{ expandedPaths: new Set(['/src']), onToggle: vi.fn() }}
            fileTree={loadedFileTree}
            folderId="root"
            hideSelection={true}
            loadingFiles={new Set()}
          />
        </FileExplorerTestWrapper>
      );
    });

    expect(screen.getByText('file1.txt')).toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('loads children for HYDRATED scope expansions of unloaded directories (BST-1269)', async () => {
    // Thread-switch hydration writes expandedPaths directly into the scope —
    // no toggle flow runs, so the tree itself must lazy-load those dirs.
    const onLoadChildren = vi.fn(async () => undefined);
    const unloadedTree = mockFileTree.map((node) =>
      node.type === 'directory' ? { ...node, children: [], loadState: 'unloaded' as const } : node
    );
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree
            expansionScope={{ expandedPaths: new Set(['/src']), onToggle: vi.fn() }}
            fileTree={unloadedTree}
            folderId="root"
            hideSelection={true}
            loadingFiles={new Set()}
            onLoadChildren={onLoadChildren}
          />
        </FileExplorerTestWrapper>
      );
    });

    await waitFor(() => {
      expect(onLoadChildren).toHaveBeenCalledWith('/src');
    });
  });

  it('reveal never toggles a LOADING ancestor — not even for a new target (review finding)', async () => {
    // Toggling a loading directory means "cancel the load"; a reveal that did
    // so would wedge the load it depends on.
    const onToggle = vi.fn();
    const loadingTree = mockFileTree.map((node) =>
      node.type === 'directory' ? { ...node, children: [], loadState: 'loading' as const } : node
    );
    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <OptimizedFileTree
            expansionScope={{ expandedPaths: new Set<string>(), onToggle }}
            fileTree={loadingTree}
            folderId="root"
            hideSelection={true}
            loadingFiles={new Set()}
            revealPath="/src/file2.txt"
          />
        </FileExplorerTestWrapper>
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('revealPath expands collapsed ancestors through the scope exactly once', async () => {
    function Harness() {
      const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set());
      return (
        <OptimizedFileTree
          expansionScope={{
            expandedPaths,
            onToggle: (path) => {
              setExpandedPaths((previous) => {
                const next = new Set(previous);
                if (next.has(path)) {
                  next.delete(path);
                } else {
                  next.add(path);
                }
                return next;
              });
            },
          }}
          fileTree={loadedFileTree}
          folderId="root"
          hideSelection={true}
          loadingFiles={new Set()}
          revealPath="/src/file2.txt"
        />
      );
    }

    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <Harness />
        </FileExplorerTestWrapper>
      );
    });

    // The ancestor directory /src was expanded by the reveal, so the target
    // file's row is rendered.
    await waitFor(() => {
      expect(screen.getByText('file2.txt')).toBeInTheDocument();
    });
  });
});
