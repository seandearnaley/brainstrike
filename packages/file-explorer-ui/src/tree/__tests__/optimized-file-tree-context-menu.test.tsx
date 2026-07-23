import { type ActionServices, createTestActionRegistry } from '@brainstrike/context-actions';
import type { IFileNode } from '@brainstrike/types';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    children: [
      {
        depth: 1,
        handle: {} as FileSystemFileHandle,
        isVisible: true,
        name: 'file1.txt',
        path: 'src/file1.txt',
        rootFolderId: 'root',
        selectionState: 'unchecked',
        type: 'file',
      },
    ],
    depth: 0,
    handle: {} as FileSystemDirectoryHandle,
    isVisible: true,
    name: 'src',
    path: 'src',
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'directory',
  },
  {
    depth: 0,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name: 'readme.md',
    path: 'readme.md',
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
  },
  {
    depth: 0,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name: 'other.ts',
    path: 'other.ts',
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
  },
];

const desktopFileTree: IFileNode[] = [
  {
    depth: 0,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name: 'readme.md',
    path: '/workspace/readme.md',
    rootFolderId: '/workspace',
    selectionState: 'unchecked',
    type: 'file',
  },
  {
    depth: 0,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name: 'other.ts',
    path: '/workspace/other.ts',
    rootFolderId: '/workspace',
    selectionState: 'unchecked',
    type: 'file',
  },
];

function getFileRow(name: string): HTMLElement {
  const row = screen.getByText(name, { exact: true }).closest<HTMLElement>('[data-node-id]');
  if (!row) {
    throw new Error(`File tree row not found for ${name}`);
  }
  return row;
}

async function renderTree(
  options: { fileTree?: IFileNode[]; folderId?: string; services?: ActionServices } = {}
): Promise<{
  rerenderTree: (fileTree: IFileNode[]) => void;
  writtenTexts: string[];
}> {
  const fileTree = options.fileTree ?? mockFileTree;
  const folderId = options.folderId ?? 'root';
  const { registry, writtenTexts } = createTestActionRegistry({
    actions: fileEntryActions,
    ...(options.services ? { services: options.services } : {}),
  });
  let rerender: ((ui: ReactNode) => void) | undefined;
  await act(async () => {
    const result = render(
      <FileExplorerTestWrapper actionRegistry={registry}>
        <OptimizedFileTree fileTree={fileTree} folderId={folderId} loadingFiles={new Set()} />
      </FileExplorerTestWrapper>
    );
    rerender = result.rerender;
  });
  if (!rerender) {
    throw new Error('File tree test renderer was not initialized');
  }
  const rerenderView = rerender;
  return {
    rerenderTree: (nextFileTree) =>
      rerenderView(
        <FileExplorerTestWrapper actionRegistry={registry}>
          <OptimizedFileTree fileTree={nextFileTree} folderId={folderId} loadingFiles={new Set()} />
        </FileExplorerTestWrapper>
      ),
    writtenTexts,
  };
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

  it('closes immediately, restores the originating row, and permits the next interaction', async () => {
    const { writtenTexts } = await renderTree();
    const readmeRow = getFileRow('readme.md');

    fireEvent.contextMenu(readmeRow, { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy Relative Path' }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(readmeRow));
    await waitFor(() => expect(writtenTexts).toContain('readme.md'));

    fireEvent.keyDown(readmeRow, { key: 'ArrowDown' });
    const otherRow = getFileRow('other.ts');
    await waitFor(() => expect(otherRow).toHaveAttribute('data-focused', 'true'));

    fireEvent.contextMenu(otherRow, { clientX: 20, clientY: 20 });
    expect(await screen.findByRole('menuitem', { name: 'Copy Relative Path' })).toBeInTheDocument();
  });

  it('restores desktop full-path copy focus and permits another file menu', async () => {
    const { writtenTexts } = await renderTree({
      fileTree: desktopFileTree,
      folderId: '/workspace',
    });
    const readmeRow = getFileRow('readme.md');

    fireEvent.contextMenu(readmeRow, { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy Full Path' }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(readmeRow));
    await waitFor(() => expect(writtenTexts).toContain('/workspace/readme.md'));

    fireEvent.contextMenu(getFileRow('other.ts'), { clientX: 20, clientY: 20 });
    expect(await screen.findByRole('menuitem', { name: 'Copy Full Path' })).toBeInTheDocument();
  });

  it('restores the tree fallback when the originating row becomes stale', async () => {
    const { rerenderTree } = await renderTree();
    const readmeRow = getFileRow('readme.md');

    fireEvent.contextMenu(readmeRow, { clientX: 10, clientY: 10 });
    const copyItem = await screen.findByRole('menuitem', { name: 'Copy Relative Path' });
    rerenderTree(mockFileTree.filter((node) => node.path !== 'readme.md'));
    fireEvent.click(copyItem);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('treegrid', { name: 'File tree' }));
    });
  });

  it('keeps the tree usable when clipboard copy rejects', async () => {
    const clipboard = {
      writeText: vi.fn().mockResolvedValue({ error: 'clipboard locked', ok: false } as const),
    };
    await renderTree({ services: { clipboard } });
    const readmeRow = getFileRow('readme.md');

    fireEvent.contextMenu(readmeRow, { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy Relative Path' }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(readmeRow));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith('readme.md'));

    fireEvent.contextMenu(getFileRow('other.ts'), { clientX: 20, clientY: 20 });
    expect(await screen.findByRole('menuitem', { name: 'Copy Relative Path' })).toBeInTheDocument();
  });
});
