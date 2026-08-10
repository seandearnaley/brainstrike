import type { IFileNode } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FileTreeTypeCell } from '../tree/file-tree-metadata-cells';
import type { FileTreeRowData } from '../tree/optimized-file-tree-model';

function createRowData(fileNode: IFileNode): FileTreeRowData {
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

function createFileRowData(name: string): FileTreeRowData {
  return createRowData({
    depth: 0,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name,
    path: `/${name}`,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
  });
}

function createDirectoryRowData(name: string): FileTreeRowData {
  return createRowData({
    children: [],
    depth: 0,
    handle: {} as FileSystemDirectoryHandle,
    isVisible: true,
    name,
    path: `/${name}`,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'directory',
  });
}

describe('FileTreeTypeCell', () => {
  it.each(['LICENSE', '.env'])('renders a stable file label for %s', (name) => {
    render(<FileTreeTypeCell rowData={createFileRowData(name)} />);

    expect(screen.getByText('File')).toBeInTheDocument();
  });

  it('keeps rendering extension badges for files with extensions', () => {
    render(<FileTreeTypeCell rowData={createFileRowData('index.ts')} />);

    expect(screen.getByTitle('ts')).toHaveTextContent('ts');
    expect(screen.queryByText('File')).not.toBeInTheDocument();
  });

  it('keeps directory type cells empty', () => {
    const { container } = render(<FileTreeTypeCell rowData={createDirectoryRowData('src')} />);

    expect(container).toBeEmptyDOMElement();
  });
});
