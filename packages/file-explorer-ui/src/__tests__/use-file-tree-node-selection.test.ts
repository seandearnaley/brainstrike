import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFileTreeNodeSelection } from '../tree/use-file-tree-node-selection';

const ROOT_FOLDER_ID = 'folder-1';

function createHandle(type: IFileNode['type'], name: string): IFileNode['handle'] {
  return {
    kind: type === 'directory' ? 'directory' : 'file',
    name,
  } as IFileNode['handle'];
}

function createFile(path: string): IFileNode {
  const name = path.split('/').at(-1) ?? path;
  return {
    depth: path.split('/').length - 1,
    handle: createHandle('file', name),
    name,
    path,
    rootFolderId: ROOT_FOLDER_ID,
    selectionState: 'unchecked',
    type: 'file',
  };
}

function createDirectory(path: string, children?: IFileNode[]): IFileNode {
  const name = path.split('/').at(-1) ?? path;
  const node: IFileNode = {
    depth: path ? path.split('/').length - 1 : 0,
    handle: createHandle('directory', name),
    name,
    path,
    rootFolderId: ROOT_FOLDER_ID,
    selectionState: 'unchecked',
    type: 'directory',
  };
  if (children) {
    // Children provided = a materialized directory; production stamps those
    // 'loaded'. Omitting children models an unloaded directory (no loadState).
    node.children = children;
    node.loadState = 'loaded';
  }
  return node;
}

function selected(path: string): string {
  return encodeFileSelection(ROOT_FOLDER_ID, path);
}

function renderSelectionHook({
  folderId = ROOT_FOLDER_ID,
  maxSelectionCount = 10,
  node,
  selectedFilePaths = new Set<string>(),
}: {
  folderId?: string;
  maxSelectionCount?: number;
  node: IFileNode;
  selectedFilePaths?: Set<string>;
}) {
  const onToggleFileSelection = vi.fn();
  const hook = renderHook(() =>
    useFileTreeNodeSelection({
      folderId,
      maxSelectionCount,
      node,
      onToggleFileSelection,
      selectedFilePaths,
    })
  );
  return { ...hook, onToggleFileSelection };
}

describe('useFileTreeNodeSelection', () => {
  it('toggles a file node and reports selected state within the active folder', () => {
    const node = createFile('src/app.ts');
    const { result, onToggleFileSelection } = renderSelectionHook({
      node,
      selectedFilePaths: new Set([selected('src/app.ts')]),
    });

    expect(result.current.checkboxState).toBe(true);
    expect(result.current.folderInfo).toBeNull();
    expect(result.current.wouldExceedLimit).toBe(false);

    act(() => {
      result.current.handleNodeSelection();
    });

    expect(onToggleFileSelection).toHaveBeenCalledWith('src/app.ts');
  });

  it('marks an unselected file as exceeding the selection cap', () => {
    const node = createFile('src/app.ts');
    const { result } = renderSelectionHook({
      maxSelectionCount: 1,
      node,
      selectedFilePaths: new Set([selected('src/other.ts')]),
    });

    expect(result.current.checkboxState).toBe(false);
    expect(result.current.wouldExceedLimit).toBe(true);
  });

  it('ignores empty directories and directories without loaded children', () => {
    const emptyDirectory = createDirectory('src', []);
    const { result, onToggleFileSelection } = renderSelectionHook({ node: emptyDirectory });

    act(() => {
      result.current.handleNodeSelection();
    });

    expect(result.current.checkboxState).toBe(false);
    expect(result.current.folderInfo).toEqual({
      count: 0,
      isComplete: true,
      selectedCount: 0,
    });
    expect(result.current.getAllFilePaths(createDirectory('unloaded'))).toEqual([]);
    expect(onToggleFileSelection).not.toHaveBeenCalled();
  });

  it('opens the selection dialog for large untouched folders', () => {
    const node = createDirectory(
      'src',
      Array.from({ length: 11 }, (_, index) => createFile(`src/file-${index}.ts`))
    );
    const { result, onToggleFileSelection } = renderSelectionHook({ node });

    act(() => {
      result.current.handleNodeSelection();
    });

    expect(result.current.showSelectionDialog).toBe(true);
    expect(onToggleFileSelection).not.toHaveBeenCalled();
  });

  it('toggles every file when a folder is already fully selected', () => {
    const node = createDirectory('src', [
      createFile('src/app.ts'),
      createDirectory('src/components', [createFile('src/components/button.tsx')]),
    ]);
    const { result, onToggleFileSelection } = renderSelectionHook({
      node,
      selectedFilePaths: new Set([selected('src/app.ts'), selected('src/components/button.tsx')]),
    });

    expect(result.current.checkboxState).toBe(true);
    expect(result.current.folderInfo).toEqual({
      count: 2,
      isComplete: true,
      selectedCount: 2,
    });

    act(() => {
      result.current.handleNodeSelection();
    });

    expect(onToggleFileSelection.mock.calls.map(([path]) => path)).toEqual([
      'src/app.ts',
      'src/components/button.tsx',
    ]);
  });

  it('selects only available unselected paths when a folder would exceed the cap', () => {
    const node = createDirectory('src', [
      createFile('src/a.ts'),
      createFile('src/b.ts'),
      createFile('src/c.ts'),
      createFile('src/d.ts'),
    ]);
    const { result, onToggleFileSelection } = renderSelectionHook({
      maxSelectionCount: 3,
      node,
      selectedFilePaths: new Set([selected('src/a.ts')]),
    });

    expect(result.current.checkboxState).toBe('indeterminate');
    expect(result.current.wouldExceedLimit).toBe(true);

    act(() => {
      result.current.handleNodeSelection();
    });

    expect(onToggleFileSelection.mock.calls.map(([path]) => path)).toEqual([
      'src/b.ts',
      'src/c.ts',
    ]);
  });

  it('treats file selection as unchecked when no folder id is available', () => {
    const node = createFile('src/app.ts');
    const { result } = renderSelectionHook({
      folderId: '',
      node,
      selectedFilePaths: new Set([selected('src/app.ts')]),
    });

    expect(result.current.checkboxState).toBe(false);
    expect(result.current.wouldExceedLimit).toBe(false);
  });
});
