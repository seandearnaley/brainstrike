import type { ChangedFileEntry, ChangedFileStatus } from '@brainstrike/types';
import type { TreeTableCellProps } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CHANGED_FILES_TREE_COLUMNS } from '../ui/changed-files-tree-columns';
import type { ChangedFilesTreeNodeData } from '../ui/changed-files-tree-model';

function props(status: ChangedFileStatus): TreeTableCellProps<ChangedFilesTreeNodeData> {
  const entry: ChangedFileEntry = {
    additions: 1,
    deletions: 0,
    path: 'src/example.ts',
    repositoryRoot: '/repo',
    revertible: true,
    rootId: 'root-1',
    status,
    worktreePath: '/repo',
  };
  return {
    depth: 0,
    isExpanded: false,
    isHighlighted: false,
    isInContext: false,
    isSelected: false,
    node: {
      data: { entry, kind: 'file' },
      depth: 0,
      hasChildren: false,
      id: 'file',
      parentId: null,
      type: 'file',
    },
    rowIndex: 0,
  };
}

describe('Changes tree status accessibility', () => {
  it.each([
    ['added', 'Added file', 'text-success'],
    ['deleted', 'Deleted file', 'text-destructive'],
    ['modified', 'Modified file', 'text-warning'],
    ['renamed', 'Renamed file', 'text-info'],
    ['untracked', 'Untracked file', 'text-success'],
  ] as const)(
    'names %s independently of its single letter and color',
    (status, label, className) => {
      const Cell = CHANGED_FILES_TREE_COLUMNS.find(({ id }) => id === 'name')?.cell;
      if (!Cell) {
        throw new Error('Missing Name cell');
      }
      render(<Cell {...props(status)} />);
      expect(screen.getByRole('img', { name: label })).toHaveClass(className);
      expect(screen.getByText('src/example.ts')).toBeVisible();
    }
  );
});
