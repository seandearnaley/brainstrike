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
