import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { IFileNode } from '@brainstrike/types';
import { act, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  createExplorerThreadStatusStore,
  type ExplorerThreadFileStatus,
  ExplorerThreadStatusContext,
  type ExplorerThreadStatusStore,
} from '../shell/explorer-thread-status';
import {
  FileTreeSelectionContext,
  type FileTreeSelectionContextValue,
} from '../tree/file-tree-selection-context';
import { FileTreeThreadCell } from '../tree/file-tree-thread-cell';
import type { FileTreeRowData } from '../tree/optimized-file-tree-model';

const SELECTION = { folderId: 'root' } as FileTreeSelectionContextValue;
const FILE_KEY = encodeFileSelection('root', '/w/src/a.ts');
const FOLDER_KEY = encodeFileSelection('root', '/w/src');

function row(type: 'directory' | 'file', path: string): FileTreeRowData {
  const base = {
    depth: 1,
    isVisible: true,
    name: path.split('/').at(-1) ?? path,
    path,
    rootFolderId: 'root',
    selectionState: 'unchecked' as const,
  };
  const fileNode: IFileNode =
    type === 'directory'
      ? { ...base, children: [], handle: {} as FileSystemDirectoryHandle, type: 'directory' }
      : { ...base, handle: {} as FileSystemFileHandle, type: 'file' };
  return {
    directoryTotalFiles: 0,
    fileNode,
    hasIncompleteDescendants: false,
    hasUnloadedDirectoryChildren: false,
    immediateChildren: [],
    isChildrenLoading: false,
    isFileLoading: false,
    isLoadingForSelection: false,
  };
}

function publish(store: ExplorerThreadStatusStore, status: ExplorerThreadFileStatus): void {
  store.publish({
    directories: new Map([[FOLDER_KEY, 2]]),
    files: new Map([[FILE_KEY, status]]),
    touchedPaths: ['/w/src', '/w/src/a.ts'],
  });
}

function Cell({
  rowData,
  store,
}: {
  rowData: FileTreeRowData;
  store: ExplorerThreadStatusStore;
}): ReactElement {
  return (
    <FileTreeSelectionContext.Provider value={SELECTION}>
      <ExplorerThreadStatusContext.Provider value={store}>
        <FileTreeThreadCell rowData={rowData} />
      </ExplorerThreadStatusContext.Provider>
    </FileTreeSelectionContext.Provider>
  );
}

describe('FileTreeThreadCell', () => {
  it("names how the thread's model received a file, and its signals", () => {
    const store = createExplorerThreadStatusStore();
    publish(store, {
      editedWithoutRead: true,
      freshness: 'changed',
      gone: false,
      kinds: ['edit', 'read'],
    });
    render(<Cell rowData={row('file', '/w/src/a.ts')} store={store} />);

    const cell = screen.getByTestId('explorer-thread-file');
    expect(cell).toHaveAttribute('data-freshness', 'changed');
    expect(cell).toHaveAccessibleName(
      'This thread: Edited, Read; changed since read; edited without reading'
    );
  });

  it('says freshness nobody checked is not checked, never unchanged', () => {
    const store = createExplorerThreadStatusStore();
    publish(store, { editedWithoutRead: false, freshness: 'unknown', gone: true, kinds: ['grep'] });
    render(<Cell rowData={row('file', '/w/src/a.ts')} store={store} />);
    expect(screen.getByTestId('explorer-thread-file')).toHaveAccessibleName(
      'This thread: Grep hit; not checked for changes; no longer in the window'
    );
  });

  it('asks for freshness only while a touched file is shown', () => {
    const store = createExplorerThreadStatusStore();
    const { unmount } = render(<Cell rowData={row('file', '/w/src/a.ts')} store={store} />);
    expect(store.getWatchedKeys().size).toBe(0);
    act(() => {
      publish(store, {
        editedWithoutRead: false,
        freshness: 'unknown',
        gone: false,
        kinds: ['read'],
      });
    });
    expect(store.getWatchedKeys()).toEqual(new Set([FILE_KEY]));
    unmount();
    expect(store.getWatchedKeys().size).toBe(0);
  });

  it('counts the touched files under a folder, and shows nothing for untouched rows', () => {
    const store = createExplorerThreadStatusStore();
    publish(store, {
      editedWithoutRead: false,
      freshness: 'unknown',
      gone: false,
      kinds: ['read'],
    });
    const { container, rerender } = render(
      <Cell rowData={row('directory', '/w/src')} store={store} />
    );
    expect(screen.getByTestId('explorer-thread-folder')).toHaveTextContent(
      '2 This thread touched 2 files here'
    );
    rerender(<Cell rowData={row('file', '/w/src/b.ts')} store={store} />);
    expect(container).toBeEmptyDOMElement();
  });
});
