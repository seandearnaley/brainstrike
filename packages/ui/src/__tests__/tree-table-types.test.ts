import { describe, expect, it } from 'vitest';
import type {
  CheckboxState,
  SelectionMode,
  SortState,
  TreeNode,
  TreeTableCheckboxNextState,
  TreeTableColumn,
  TreeTableProps,
} from '../tree-table/types';

describe('tree-table types', () => {
  describe('TreeNode', () => {
    it('can create a basic tree node', () => {
      const node: TreeNode<{ name: string }> = {
        data: { name: 'Test Node' },
        depth: 0,
        hasChildren: false,
        id: 'node-1',
        parentId: null,
        type: 'file',
      };

      expect(node.id).toBe('node-1');
      expect(node.type).toBe('file');
      expect(node.depth).toBe(0);
      expect(node.data.name).toBe('Test Node');
      expect(node.parentId).toBeNull();
      expect(node.hasChildren).toBe(false);
    });

    it('can create a parent node with children', () => {
      const parent: TreeNode<{ name: string }> = {
        data: { name: 'Parent' },
        depth: 0,
        hasChildren: true,
        id: 'parent-1',
        parentId: null,
        type: 'folder',
      };

      expect(parent.hasChildren).toBe(true);
    });

    it('can create a child node', () => {
      const child: TreeNode<{ name: string }> = {
        data: { name: 'Child' },
        depth: 1,
        hasChildren: false,
        id: 'child-1',
        parentId: 'parent-1',
        type: 'file',
      };

      expect(child.parentId).toBe('parent-1');
      expect(child.depth).toBe(1);
    });
  });

  describe('TreeTableColumn', () => {
    it('can create a basic column', () => {
      const column: TreeTableColumn<{ name: string }> = {
        cell: ({ node }) => node.data.name,
        header: 'Name',
        id: 'name',
      };

      expect(column.id).toBe('name');
      expect(column.header).toBe('Name');
      expect(typeof column.cell).toBe('function');
    });

    it('can create a column with custom width', () => {
      const column: TreeTableColumn<{ value: number }> = {
        cell: ({ node }) => String(node.data.value),
        header: 'Value',
        id: 'value',
        width: 100,
      };

      expect(column.width).toBe(100);
    });
  });

  describe('SortState', () => {
    it('can create ascending sort state', () => {
      const sort: SortState = {
        columnId: 'name',
        direction: 'asc',
      };

      expect(sort.columnId).toBe('name');
      expect(sort.direction).toBe('asc');
    });

    it('can create descending sort state', () => {
      const sort: SortState = {
        columnId: 'date',
        direction: 'desc',
      };

      expect(sort.direction).toBe('desc');
    });
  });

  describe('SelectionMode', () => {
    it('supports none mode', () => {
      const mode: SelectionMode = 'none';
      expect(mode).toBe('none');
    });

    it('supports single mode', () => {
      const mode: SelectionMode = 'single';
      expect(mode).toBe('single');
    });

    it('supports multi mode', () => {
      const mode: SelectionMode = 'multi';
      expect(mode).toBe('multi');
    });
  });

  describe('pluggable checkbox API types', () => {
    it('accepts CheckboxState and hidden/undefined from getCheckboxState', () => {
      const checked: CheckboxState = 'checked';
      const indeterminate: CheckboxState = 'indeterminate';
      const unchecked: CheckboxState = 'unchecked';
      expect(checked).toBe('checked');
      expect(indeterminate).toBe('indeterminate');
      expect(unchecked).toBe('unchecked');

      const getCheckboxState: NonNullable<TreeTableProps<{ name: string }>['getCheckboxState']> = (
        node
      ) => {
        if (node.type === 'match') {
          return 'hidden';
        }
        if (node.type === 'skip') {
          return;
        }
        return 'checked';
      };

      expect(
        getCheckboxState({
          data: { name: 'm' },
          depth: 1,
          hasChildren: false,
          id: 'm',
          parentId: 'f',
          type: 'match',
        })
      ).toBe('hidden');
      expect(
        getCheckboxState({
          data: { name: 's' },
          depth: 0,
          hasChildren: false,
          id: 's',
          parentId: null,
          type: 'skip',
        })
      ).toBeUndefined();
    });

    it('types onCheckboxChange nextState as checked | unchecked', () => {
      const next: TreeTableCheckboxNextState = 'checked';
      const onCheckboxChange: NonNullable<TreeTableProps<{ name: string }>['onCheckboxChange']> = (
        node,
        nextState
      ) => {
        expect(node.id).toBeTruthy();
        expect(nextState === 'checked' || nextState === 'unchecked').toBe(true);
      };
      onCheckboxChange(
        {
          data: { name: 'a' },
          depth: 0,
          hasChildren: false,
          id: 'a',
          parentId: null,
          type: 'file',
        },
        next
      );
    });
  });
});
