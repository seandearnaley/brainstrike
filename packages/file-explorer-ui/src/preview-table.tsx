import {
  Checkbox,
  SortableTableHeader,
  type TreeNode,
  TreeTable,
  type TreeTableColumn,
} from '@brainstrike/ui';
import { ChevronDown, ChevronRight, FolderOpen } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import { ExtensionBadge } from './extension-badge';
import { useEventCallback } from './hooks/use-event-callback';
import type { ColumnVisibility } from './hooks/use-preview-panel-persistence';
import { PreviewTableRow } from './preview-table-row';
import { formatTokenCount } from './use-preview-panel-state';
import type { GroupedData, GroupKey, TableRowData } from './utils/grouping-configs';
import { formatDirPathForDisplay, splitFilePath } from './utils/path-display';
import { formatPreviewFileSize } from './utils/preview-formatters';

interface PreviewTableProps {
  columnVisibility: ColumnVisibility;
  sortField: keyof TableRowData;
  sortDirection: 'asc' | 'desc';
  groupingConfig: string;
  groupedData: GroupedData<TableRowData>[];
  currentPageData: TableRowData[];
  collapsedGroups: Set<string>;
  previewSelections: Set<string>;
  visibleFilesOnPage: TableRowData[];
  onSort: (field: keyof TableRowData) => void;
  onToggleSelection: (compositeKey: string, checked: boolean) => void;
  onSelectAllOnPage: (items: TableRowData[]) => void;
  onDeselectAll: () => void;
  isAllSelected: (items: TableRowData[]) => boolean;
  onFileClick?: ((compositeKey: string) => void) | undefined;
  toggleGroupCollapse: (groupKey: GroupKey) => void;
  isGroupFullySelected: (group: GroupedData<TableRowData>) => boolean;
  isGroupPartiallySelected: (group: GroupedData<TableRowData>) => boolean;
  handleGroupSelectAll: (group: GroupedData<TableRowData>) => void;
  handleGroupDeselectAll: (group: GroupedData<TableRowData>) => void;
  pagination: { startIndex: number; endIndex: number };
}

type GroupColumnId = 'rootFolderId' | 'path' | 'type' | 'tokens' | 'size';

interface GroupTreeNodeData {
  kind: 'group';
  group: GroupedData<TableRowData>;
}

interface ItemTreeNodeData {
  kind: 'item';
  item: TableRowData;
}

type PreviewTreeNodeData = GroupTreeNodeData | ItemTreeNodeData;

const DEFAULT_GROUP_COLUMN: GroupColumnId = 'path';
const GROUP_COLUMN_ORDER: GroupColumnId[] = ['rootFolderId', 'path', 'type', 'tokens', 'size'];
const EMPTY_EXPANDED_IDS = new Set<string>();
const NOOP_TOGGLE_EXPAND = (): void => {};

interface GroupHeaderSummaryProps {
  group: GroupedData<TableRowData>;
  isCollapsed: boolean;
  showInlineCheckbox: boolean;
  isFullySelected: boolean;
  isPartiallySelected: boolean;
  onSelectionChange: (checked: boolean) => void;
  onToggleCollapse: () => void;
}

const GroupHeaderSummary = memo<GroupHeaderSummaryProps>(function GroupHeaderSummaryComponent({
  group,
  isCollapsed,
  showInlineCheckbox,
  isFullySelected,
  isPartiallySelected,
  onSelectionChange,
  onToggleCollapse,
}) {
  const checkboxState: boolean | 'indeterminate' = isFullySelected
    ? true
    : isPartiallySelected
      ? 'indeterminate'
      : false;

  return (
    <div className="flex min-w-0 items-center gap-2">
      {showInlineCheckbox && (
        <Checkbox
          aria-label={`Select all files in group ${group.groupLabel}`}
          checked={checkboxState}
          onCheckedChange={(checked) => onSelectionChange(checked === true)}
          onClick={(event) => event.stopPropagation()}
        />
      )}
      <button
        aria-expanded={!isCollapsed}
        aria-label={`${isCollapsed ? 'Expand group' : 'Collapse group'} ${group.groupLabel}`}
        className="inline-flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-left font-medium text-sm transition-colors hover:bg-muted"
        onClick={(event) => {
          event.stopPropagation();
          onToggleCollapse();
        }}
        type="button"
      >
        {isCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
        <FolderOpen className="size-4 text-muted-foreground" />
        <span className="truncate">{group.groupLabel}</span>
      </button>
      <span className="text-muted-foreground text-xs">{group.count} files</span>
      <span className="whitespace-nowrap text-muted-foreground text-xs tabular-nums">
        {formatTokenCount(group.totalTokens)}
      </span>
      <span className="whitespace-nowrap text-muted-foreground text-xs tabular-nums">
        {(group.totalSize / 1024).toFixed(1)} KB
      </span>
    </div>
  );
});
GroupHeaderSummary.displayName = 'GroupHeaderSummary';

interface BuildGroupedTreeNodesInput {
  groupedData: GroupedData<TableRowData>[];
  collapsedGroups: Set<string>;
  pagination: { startIndex: number; endIndex: number };
}

function isRowInsidePageWindow(
  rowIndex: number,
  pagination: { startIndex: number; endIndex: number }
): boolean {
  return rowIndex >= pagination.startIndex && rowIndex < pagination.endIndex;
}

function hasReachedPageEnd(
  rowIndex: number,
  pagination: { startIndex: number; endIndex: number }
): boolean {
  return rowIndex >= pagination.endIndex;
}

function resolveGroupVisibleRowCount(
  group: GroupedData<TableRowData>,
  isCollapsed: boolean
): number {
  return 1 + (isCollapsed ? 0 : group.items.length);
}

function createGroupTreeNode(
  group: GroupedData<TableRowData>,
  groupKey: string
): TreeNode<PreviewTreeNodeData> {
  // Group headers own expand/collapse semantics via GroupHeaderSummary button aria-expanded.
  // Rows stay non-hierarchical (`hasChildren: false`) in this flat migration projection.
  // This intentionally leaves row-level aria-expanded/parent-child semantics incomplete
  // until BST-312 models grouped rows as true tree parent/child nodes.
  return {
    id: `group:${groupKey}`,
    type: 'preview-group',
    depth: 0,
    parentId: null,
    hasChildren: false,
    data: {
      kind: 'group',
      group,
    },
  };
}

function createItemTreeNode(item: TableRowData): TreeNode<PreviewTreeNodeData> {
  return {
    id: `item:${item.compositeKey}`,
    type: 'preview-item',
    depth: 0,
    parentId: null,
    hasChildren: false,
    data: {
      kind: 'item',
      item,
    },
  };
}

function appendVisibleGroupItems(
  nodes: TreeNode<PreviewTreeNodeData>[],
  group: GroupedData<TableRowData>,
  visibleRowIndex: number,
  pagination: { startIndex: number; endIndex: number }
): number {
  const firstVisibleItemIndex = Math.max(0, pagination.startIndex - visibleRowIndex);
  const maxVisibleItemCount = Math.max(0, pagination.endIndex - visibleRowIndex);
  const lastVisibleItemIndex = Math.min(
    group.items.length,
    firstVisibleItemIndex + maxVisibleItemCount
  );

  for (let itemIndex = firstVisibleItemIndex; itemIndex < lastVisibleItemIndex; itemIndex += 1) {
    const item = group.items[itemIndex];
    if (!item) {
      continue;
    }
    nodes.push(createItemTreeNode(item));
  }

  return visibleRowIndex + group.items.length;
}

function buildGroupedTreeNodes({
  groupedData,
  collapsedGroups,
  pagination,
}: BuildGroupedTreeNodesInput): TreeNode<PreviewTreeNodeData>[] {
  // TODO(BST-312): model grouped rows as parent/child tree nodes instead of a flat projection.
  // Current migration keeps grouped rows in a flat projection for shared table styling.
  // This means group and item rows both render at depth 0 until hierarchical tree rows are introduced.
  // PreviewTable therefore renders `ariaRole="grid"` (not `treegrid`) to avoid implying tree semantics.
  // Trade-off: assistive tech reads groups/items as peer rows until parent/child rows are modeled.
  const nodes: TreeNode<PreviewTreeNodeData>[] = [];
  let visibleRowIndex = 0;

  for (const group of groupedData) {
    const groupKey = String(group.groupKey);
    const isCollapsed = collapsedGroups.has(groupKey);
    const groupVisibleRowCount = resolveGroupVisibleRowCount(group, isCollapsed);

    // Fast-path: skip whole groups that are fully before the requested page window.
    // This avoids O(startIndex) item-by-item scans for large grouped datasets.
    if (visibleRowIndex + groupVisibleRowCount <= pagination.startIndex) {
      visibleRowIndex += groupVisibleRowCount;
      continue;
    }

    if (hasReachedPageEnd(visibleRowIndex, pagination)) {
      break;
    }

    if (isRowInsidePageWindow(visibleRowIndex, pagination)) {
      nodes.push(createGroupTreeNode(group, groupKey));
    }
    visibleRowIndex += 1;

    if (isCollapsed) {
      if (hasReachedPageEnd(visibleRowIndex, pagination)) {
        break;
      }
      continue;
    }

    visibleRowIndex = appendVisibleGroupItems(nodes, group, visibleRowIndex, pagination);

    if (hasReachedPageEnd(visibleRowIndex, pagination)) {
      break;
    }
  }

  return nodes;
}

function resolvePrimaryGroupColumn(columnVisibility: ColumnVisibility): GroupColumnId {
  for (const column of GROUP_COLUMN_ORDER) {
    if (columnVisibility[column]) {
      return column;
    }
  }
  return DEFAULT_GROUP_COLUMN;
}

function getSortIndicator(
  field: keyof TableRowData,
  sortField: keyof TableRowData,
  sortDirection: 'asc' | 'desc'
): string {
  if (field !== sortField) {
    return '';
  }
  return sortDirection === 'asc' ? '\u2191' : '\u2193';
}

interface SortHeaderButtonProps {
  title: string;
  field: keyof TableRowData;
  sortField: keyof TableRowData;
  sortDirection: 'asc' | 'desc';
  onSort: (field: keyof TableRowData) => void;
}

const SortHeaderButton = memo<SortHeaderButtonProps>(function SortHeaderButtonComponent({
  title,
  field,
  sortField,
  sortDirection,
  onSort,
}) {
  const indicator = getSortIndicator(field, sortField, sortDirection);
  return (
    <button
      aria-label={`Sort by ${title}`}
      className="flex w-full items-center justify-between gap-1 text-left font-medium"
      onClick={(event) => {
        event.preventDefault();
        onSort(field);
      }}
      type="button"
    >
      <span>{title}</span>
      <span aria-hidden="true" className="text-xs">
        {indicator}
      </span>
    </button>
  );
});
SortHeaderButton.displayName = 'SortHeaderButton';

export const PreviewTable = memo<PreviewTableProps>(function PreviewTableComponent(props) {
  const {
    columnVisibility,
    sortField,
    sortDirection,
    groupingConfig,
    groupedData,
    currentPageData,
    onSort,
    onSelectAllOnPage,
    onDeselectAll,
    isAllSelected,
    onFileClick,
    onToggleSelection,
    previewSelections,
    visibleFilesOnPage,
    collapsedGroups,
    toggleGroupCollapse,
    isGroupFullySelected,
    isGroupPartiallySelected,
    handleGroupSelectAll,
    handleGroupDeselectAll,
    pagination,
  } = props;

  const onSortStable = useEventCallback(onSort);
  const onSelectAllOnPageStable = useEventCallback(onSelectAllOnPage);
  const onDeselectAllStable = useEventCallback(onDeselectAll);
  const onToggleSelectionStable = useEventCallback(onToggleSelection);
  const onFileClickStable = useEventCallback((compositeKey: string) => {
    onFileClick?.(compositeKey);
  });
  const toggleGroupCollapseStable = useEventCallback(toggleGroupCollapse);
  const handleGroupSelectAllStable = useEventCallback(handleGroupSelectAll);
  const handleGroupDeselectAllStable = useEventCallback(handleGroupDeselectAll);

  const isAllCurrentPageSelected = useMemo(
    () => isAllSelected(visibleFilesOnPage),
    [isAllSelected, visibleFilesOnPage]
  );

  const groupedTreeNodes = useMemo(
    () =>
      buildGroupedTreeNodes({
        groupedData,
        collapsedGroups,
        pagination,
      }),
    [groupedData, collapsedGroups, pagination]
  );

  const primaryGroupColumn = useMemo(
    () => resolvePrimaryGroupColumn(columnVisibility),
    [columnVisibility]
  );

  const renderGroupHeaderIfPrimary = useCallback(
    (group: GroupedData<TableRowData>, columnId: GroupColumnId) => {
      if (primaryGroupColumn !== columnId) {
        return null;
      }

      const isCollapsed = collapsedGroups.has(String(group.groupKey));
      return (
        <GroupHeaderSummary
          group={group}
          isCollapsed={isCollapsed}
          isFullySelected={isGroupFullySelected(group)}
          isPartiallySelected={isGroupPartiallySelected(group)}
          onSelectionChange={(checked) => {
            if (checked) {
              handleGroupSelectAllStable(group);
              return;
            }
            handleGroupDeselectAllStable(group);
          }}
          onToggleCollapse={() => toggleGroupCollapseStable(group.groupKey)}
          showInlineCheckbox={!columnVisibility.checkbox}
        />
      );
    },
    [
      primaryGroupColumn,
      collapsedGroups,
      isGroupFullySelected,
      isGroupPartiallySelected,
      handleGroupSelectAllStable,
      handleGroupDeselectAllStable,
      toggleGroupCollapseStable,
      columnVisibility.checkbox,
    ]
  );

  // Keep this memo reactive to live selection/sort/group state so headers and cells stay synchronized.
  const groupedColumns = useMemo<TreeTableColumn<PreviewTreeNodeData>[]>(() => {
    // Stable callback wrappers above keep parent callback identity churn out of this memo.
    // Remaining dependencies are stateful render inputs for cells/headers.
    const columns: TreeTableColumn<PreviewTreeNodeData>[] = [];

    if (columnVisibility.checkbox) {
      columns.push({
        id: 'checkbox',
        header: (
          <Checkbox
            aria-label="Select all files on current page"
            checked={isAllCurrentPageSelected}
            onCheckedChange={(checked) =>
              checked ? onSelectAllOnPageStable(visibleFilesOnPage) : onDeselectAllStable()
            }
            title="Select all files on current page"
          />
        ),
        width: 48,
        className: 'w-12 px-4 py-2',
        cell: ({ node }) => {
          if (node.data.kind === 'group') {
            const group = node.data.group;
            const isFullySelected = isGroupFullySelected(group);
            const isPartiallySelected = isGroupPartiallySelected(group);
            const checkedState: boolean | 'indeterminate' = isFullySelected
              ? true
              : isPartiallySelected
                ? 'indeterminate'
                : false;

            return (
              <Checkbox
                aria-label={`Select all files in group ${group.groupLabel}`}
                checked={checkedState}
                onCheckedChange={(checked) => {
                  if (checked) {
                    handleGroupSelectAllStable(group);
                    return;
                  }
                  handleGroupDeselectAllStable(group);
                }}
                onClick={(event) => event.stopPropagation()}
              />
            );
          }

          const item = node.data.item;
          return (
            <Checkbox
              aria-label={`Select ${item.path}`}
              checked={previewSelections.has(item.compositeKey)}
              onCheckedChange={(checked) =>
                onToggleSelectionStable(item.compositeKey, checked === true)
              }
              onClick={(event) => event.stopPropagation()}
            />
          );
        },
      });
    }

    if (columnVisibility.rootFolderId) {
      columns.push({
        id: 'rootFolderId',
        header: (
          <SortHeaderButton
            field="rootFolderId"
            onSort={onSortStable}
            sortDirection={sortDirection}
            sortField={sortField}
            title="Folder"
          />
        ),
        width: 176,
        className: 'px-4 py-2',
        headerClassName: 'w-44',
        cell: ({ node }) => {
          if (node.data.kind === 'group') {
            return renderGroupHeaderIfPrimary(node.data.group, 'rootFolderId');
          }

          const item = node.data.item;
          return (
            <div className="flex min-w-0 items-center gap-2">
              <FolderOpen className="size-4 flex-shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-mono text-sm" title={item.rootFolderId}>
                {item.rootFolderId}
              </span>
            </div>
          );
        },
      });
    }

    if (columnVisibility.path) {
      columns.push({
        id: 'path',
        header: (
          <SortHeaderButton
            field="path"
            onSort={onSortStable}
            sortDirection={sortDirection}
            sortField={sortField}
            title="File Path"
          />
        ),
        className: 'px-4 py-2',
        cell: ({ node }) => {
          if (node.data.kind === 'group') {
            return renderGroupHeaderIfPrimary(node.data.group, 'path');
          }

          const item = node.data.item;
          const { fileName, dirPath } = splitFilePath(item.path);
          const displayDirPath = formatDirPathForDisplay({
            dirPath,
            rootFolderId: item.rootFolderId,
          });

          return (
            <button
              aria-label={fileName}
              className="block w-full min-w-0 overflow-hidden text-left transition-colors hover:text-primary"
              onClick={(event) => {
                event.preventDefault();
                onFileClickStable(item.compositeKey);
              }}
              title={item.path}
              type="button"
            >
              <div className="truncate font-medium text-sm" title={fileName}>
                {fileName}
              </div>
              {displayDirPath && (
                <div className="truncate font-mono text-muted-foreground text-xs" title={dirPath}>
                  {displayDirPath}
                </div>
              )}
            </button>
          );
        },
      });
    }

    if (columnVisibility.type) {
      columns.push({
        id: 'type',
        header: (
          <SortHeaderButton
            field="type"
            onSort={onSortStable}
            sortDirection={sortDirection}
            sortField={sortField}
            title="Type"
          />
        ),
        width: 96,
        className: 'w-24 px-4 py-2',
        headerClassName: 'w-24',
        cell: ({ node }) => {
          if (node.data.kind === 'group') {
            return renderGroupHeaderIfPrimary(node.data.group, 'type');
          }

          return <ExtensionBadge extension={node.data.item.type} />;
        },
      });
    }

    if (columnVisibility.tokens) {
      columns.push({
        id: 'tokens',
        header: (
          <SortHeaderButton
            field="tokens"
            onSort={onSortStable}
            sortDirection={sortDirection}
            sortField={sortField}
            title="Tokens"
          />
        ),
        width: 96,
        className: 'w-24 whitespace-nowrap px-4 py-2 text-right tabular-nums',
        headerClassName: 'w-24',
        cell: ({ node }) => {
          if (node.data.kind === 'group') {
            return renderGroupHeaderIfPrimary(node.data.group, 'tokens');
          }

          const tokens = node.data.item.tokens;
          if (!tokens) {
            return <span className="text-muted-foreground text-sm">—</span>;
          }
          return (
            <span className="whitespace-nowrap font-mono text-sm tabular-nums">
              {formatTokenCount(tokens)}
            </span>
          );
        },
      });
    }

    if (columnVisibility.size) {
      columns.push({
        id: 'size',
        header: (
          <SortHeaderButton
            field="size"
            onSort={onSortStable}
            sortDirection={sortDirection}
            sortField={sortField}
            title="Size"
          />
        ),
        width: 96,
        className: 'w-24 whitespace-nowrap px-4 py-2 text-right tabular-nums',
        headerClassName: 'w-24',
        cell: ({ node }) => {
          if (node.data.kind === 'group') {
            return renderGroupHeaderIfPrimary(node.data.group, 'size');
          }

          const size = node.data.item.size;
          return (
            <span
              className={
                size === undefined
                  ? 'text-muted-foreground text-sm'
                  : 'whitespace-nowrap font-mono text-sm tabular-nums'
              }
            >
              {formatPreviewFileSize(size)}
            </span>
          );
        },
      });
    }

    return columns;
  }, [
    columnVisibility,
    handleGroupDeselectAllStable,
    handleGroupSelectAllStable,
    isAllCurrentPageSelected,
    isGroupFullySelected,
    isGroupPartiallySelected,
    onDeselectAllStable,
    onFileClickStable,
    onSelectAllOnPageStable,
    onSortStable,
    onToggleSelectionStable,
    previewSelections,
    renderGroupHeaderIfPrimary,
    sortDirection,
    sortField,
    visibleFilesOnPage,
  ]);

  const rowClassName = useCallback((node: TreeNode<PreviewTreeNodeData>) => {
    if (node.data.kind === 'group') {
      return 'bg-muted/40 hover:bg-muted/60';
    }
    return '';
  }, []);

  if (groupingConfig === 'none') {
    // TODO(BST-312): converge the ungrouped path onto TreeTable once parity and
    // migration-risk constraints for ungrouped headers/rows are fully closed.
    return (
      <div className="flex-1 overflow-auto">
        <div className="min-w-full">
          <table className="w-full min-w-full table-fixed border-collapse">
            <thead className="sticky top-0 z-10 border-b bg-background">
              <tr>
                {columnVisibility.checkbox && (
                  <th className="w-12 bg-background px-4 py-2" scope="col">
                    <Checkbox
                      aria-label="Select all files on current page"
                      checked={isAllCurrentPageSelected}
                      onCheckedChange={(checked) =>
                        checked ? onSelectAllOnPage(visibleFilesOnPage) : onDeselectAll()
                      }
                      title="Select all files on current page"
                    />
                  </th>
                )}
                {columnVisibility.rootFolderId && (
                  <SortableTableHeader
                    className="w-44"
                    field="rootFolderId"
                    onSort={onSort}
                    sortDirection={sortDirection}
                    sortField={sortField}
                    title="Folder"
                  />
                )}
                {columnVisibility.path && (
                  <SortableTableHeader
                    field="path"
                    onSort={onSort}
                    sortDirection={sortDirection}
                    sortField={sortField}
                    title="File Path"
                  />
                )}
                {columnVisibility.type && (
                  <SortableTableHeader
                    className="w-24"
                    field="type"
                    onSort={onSort}
                    sortDirection={sortDirection}
                    sortField={sortField}
                    title="Type"
                  />
                )}
                {columnVisibility.tokens && (
                  <SortableTableHeader
                    className="w-24"
                    field="tokens"
                    onSort={onSort}
                    sortDirection={sortDirection}
                    sortField={sortField}
                    title="Tokens"
                  />
                )}
                {columnVisibility.size && (
                  <SortableTableHeader
                    className="w-24"
                    field="size"
                    onSort={onSort}
                    sortDirection={sortDirection}
                    sortField={sortField}
                    title="Size"
                  />
                )}
              </tr>
            </thead>
            <tbody>
              {currentPageData.map((item) => (
                <PreviewTableRow
                  columnVisibility={columnVisibility}
                  isSelected={previewSelections.has(item.compositeKey)}
                  item={item}
                  key={item.compositeKey}
                  onFileClick={onFileClick}
                  onToggleSelection={onToggleSelection}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Group rows are flattened and always visible in this mode; expansion is intentionally disabled.
  // Render as `grid` instead of `treegrid` to avoid implying a hierarchical ARIA model.
  return (
    <div className="flex min-h-0 flex-1 overflow-auto">
      <TreeTable
        ariaLabel="Context explorer table"
        ariaRole="grid"
        className="min-w-full"
        columns={groupedColumns}
        expandedIds={EMPTY_EXPANDED_IDS}
        maxHeight="none"
        nodes={groupedTreeNodes}
        onToggleExpand={NOOP_TOGGLE_EXPAND}
        rowClassName={rowClassName}
        selectionMode="none"
        windowingStrategy="none"
      />
    </div>
  );
});

PreviewTable.displayName = 'PreviewTable';
