/**
 * TreeTable Module
 *
 * A virtualized hierarchical table component for displaying tree-structured data.
 * Supports expand/collapse, selection, keyboard navigation, and search highlighting.
 *
 * @example
 * ```tsx
 * import { TreeTable, type TreeNode, type TreeTableColumn } from '@brainstrike/ui';
 *
 * interface FileData {
 *   name: string;
 *   size: number;
 * }
 *
 * const nodes: TreeNode<FileData>[] = [
 *   { id: '1', type: 'file', depth: 0, data: { name: 'doc.md', size: 1024 }, parentId: null, hasChildren: false }
 * ];
 *
 * const columns: TreeTableColumn<FileData>[] = [
 *   { id: 'name', header: 'Name', cell: ({ node }) => node.data.name },
 *   { id: 'size', header: 'Size', cell: ({ node }) => `${node.data.size} bytes` },
 * ];
 *
 * <TreeTable
 *   nodes={nodes}
 *   columns={columns}
 *   expandedIds={expandedIds}
 *   onToggleExpand={handleToggle}
 * />
 * ```
 */

// Main component
export { default, TreeTable } from './tree-table';

// Row component
export {
  DEFAULT_ROW_HEIGHTS,
  getEstimatedRowHeight,
  isTreeTableRowProps,
  TreeTableRow,
} from './tree-table-row';
// Utilities
export {
  buildTreeFromFlatNodes,
  computeCheckboxState,
  createChildrenGetter,
  DEFAULT_ARIA,
  expandToNode,
  filterTreeNodes,
  findNodeById,
  flattenTree,
  flattenTreeRecursive,
  getAncestorIds,
  getDescendantIds,
  getFirstChildNodeId,
  getNextVisibleNodeId,
  getNodePath,
  getParentNodeId,
  getRangeSelection,
  getVisibleNodeCount,
} from './tree-utils';
// Types
export type {
  CheckboxState,
  FlattenedRow,
  FlattenOptions,
  FlattenResult,
  KeyboardNavigationActions,
  KeyboardNavigationState,
  RowHeightConfig,
  SelectionMode,
  SortDirection,
  SortState,
  TreeNode,
  TreeRowAriaAttributes,
  TreeTableAutoWindowingContext,
  TreeTableCellProps,
  TreeTableCheckboxNextState,
  TreeTableCheckboxRenderState,
  TreeTableColumn,
  TreeTablePaginationOptions,
  TreeTableProps,
  TreeTableRowProps,
  TreeTableWindowingStrategy,
  UseTreeKeyboardResult,
} from './types';
// Hooks
export { type UseTreeKeyboardOptions, useTreeKeyboard } from './use-tree-keyboard';
