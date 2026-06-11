import { createTestActionRegistry } from '@brainstrike/context-actions';
import type { IFileNode } from '@brainstrike/types';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FileExplorerTestWrapper } from '../../__tests__/test-helpers';
import { fileEntryActions } from '../../context-actions';
import OptimizedFileTree from '../optimized-file-tree';

/**
 * Web-style fixture: relative paths (no leading slash), so
 * fileNodeToTarget yields absolutePath=null and the absolute-path-gated
 * actions (Copy Full Path, Reveal in …) must not appear.
 */
const mockFileTree: IFileNode[] = [
  {
    name: 'src',
    path: 'src',
    type: 'directory',
    isVisible: true,
    handle: {} as FileSystemDirectoryHandle,
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: 'root',
    children: [
      {
        name: 'file1.txt',
        path: 'src/file1.txt',
        type: 'file',
        isVisible: true,
        handle: {} as FileSystemFileHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
      },
    ],
  },
  {
    name: 'readme.md',
    path: 'readme.md',
    type: 'file',
    isVisible: true,
    handle: {} as FileSystemFileHandle,
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: 'root',
  },
];

async function renderTree(): Promise<{ writtenTexts: string[] }> {
  const { registry, writtenTexts } = createTestActionRegistry({ actions: fileEntryActions });
  await act(async () => {
    render(
      <FileExplorerTestWrapper actionRegistry={registry}>
        <OptimizedFileTree fileTree={mockFileTree} folderId="root" loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );
  });
  return { writtenTexts };
}

/**
 * Deterministic teardown for Radix's FocusScope: its effect cleanup defers
 * focus-restore in a setTimeout(0). A test that returns with the menu still
 * open (or just closed) leaks that timer; it then fires during the NEXT test,
 * focuses body, and the new menu's onFocusOutside dismisses it mid-assertion.
 * Close the menu while still mounted, then flush the 0ms timer.
 */
async function closeMenuAndFlushFocusRestore(): Promise<void> {
  if (screen.queryByRole('menu')) {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('OptimizedFileTree context menu', () => {
  afterEach(async () => {
    // Runs BEFORE RTL auto-cleanup (vitest afterEach hooks run in reverse
    // registration order; auto-cleanup registers in the setup file), so the
    // menu is still mounted here and can be closed deterministically.
    await closeMenuAndFlushFocusRestore();
  });

  it('opens applicable file-entry actions on file row right-click and omits absolute-path actions', async () => {
    await renderTree();

    const fileLabel = await screen.findByText('readme.md');
    fireEvent.contextMenu(fileLabel, { clientX: 10, clientY: 10 });

    expect(await screen.findByRole('menuitem', { name: 'Copy Relative Path' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy Name' })).toBeInTheDocument();
    // Web-style relative paths → no absolutePath → absolute-path actions hidden.
    expect(screen.queryByRole('menuitem', { name: 'Copy Full Path' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Reveal in/ })).not.toBeInTheDocument();
  });

  it('copies the relative path of the right-clicked file', async () => {
    const { writtenTexts } = await renderTree();

    const fileLabel = await screen.findByText('readme.md');
    fireEvent.contextMenu(fileLabel, { clientX: 10, clientY: 10 });

    const copyItem = await screen.findByRole('menuitem', { name: 'Copy Relative Path' });
    fireEvent.click(copyItem);

    await waitFor(() => {
      expect(writtenTexts).toContain('readme.md');
    });
  });
});
