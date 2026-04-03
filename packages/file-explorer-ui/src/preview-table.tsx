import { useEventCallback } from '@brainstrike/hooks';
import {
  Checkbox,
  cn,
  SortableTableHeader,
  type TreeNode,
  TreeTable,
  type TreeTableColumn,
} from '@brainstrike/ui';
import { FolderOpen } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { ExtensionBadge } from './extension-badge';
import type { ColumnVisibility } from './hooks/use-preview-panel-persistence';
import { PreviewTableRow } from './preview-table-row';
import { formatTokenCount } from './use-preview-panel-state';
import type { GroupedData, GroupKey, TableRowData } from './utils/grouping-configs';
import { formatDirPathForDisplay, splitFilePath } from './utils/path-display';
import { formatPreviewFileSize } from './utils/preview-formatters';

interface PreviewTableProps {
  collapsedGroups: Set<string>;
  columnVisibility: ColumnVisibility;
  currentPageData: TableRowData[];
  groupedData: GroupedData<TableRowData>[];
  groupingConfig: string;
  handleGroupDeselectAll: (group: GroupedData<TableRowData>) => void;
  handleGroupSelectAll: (group: GroupedData<TableRowData>) => void;
  isAllSelected: (items: TableRowData[]) => boolean;
  isGroupFullySelected: (group: GroupedData<TableRowData>) => boolean;
  isGroupPartiallySelected: (group: GroupedData<TableRowData>) => boolean;
  onDeselectAll: () => void;
  onFileClick?: ((compositeKey: string) => void) | undefined;
  onSelectAllOnPage: (items: TableRowData[]) => void;
  onSort: (field: keyof TableRowData) => void;
  onToggleSelection: (compositeKey: string, checked: boolean) => void;
  pagination: { startIndex: number; endIndex: number };
  previewSelections: Set<string>;
  scrollAreaClassName?: string | undefined;
  sortDirection: 'asc' | 'desc';
  sortField: keyof TableRowData;
  toggleGroupCollapse: (groupKey: GroupKey) => void;
  visibleFilesOnPage: TableRowData[];
}

type GroupColumnId = 'rootFolderId' | 'path' | 'type' | 'tokens' | 'size';

interface GroupTreeNodeData {
  group: GroupedData<TableRowData>;
  kind: 'group';
}

interface ItemTreeNodeData {
  item: TableRowData;
  kind: 'item';
}

type PreviewTreeNodeData = GroupTreeNodeData | ItemTreeNodeData;

function resolveCheckboxState(
  isFullySelected: boolean,
  isPartiallySelected: boolean
): boolean | 'indeterminate' {
  if (isFullySelected) {
    return true;
  }
  if (isPartiallySelected) {
    return 'indeterminate';
  }
  return false;
}

const DEFAULT_GROUP_COLUMN: GroupColumnId = 'path';
const GROUP_COLUMN_ORDER: GroupColumnId[] = ['rootFolderId', 'path', 'type', 'tokens', 'size'];

interface GroupHeaderSummaryProps {
  group: GroupedData<TableRowData>;
  isFullySelected: boolean;
  isPartiallySelected: boolean;
  onSelectionChange: (checked: boolean) => void;
  showInlineCheckbox: boolean;
}

const GroupHeaderSummary = memo<GroupHeaderSummaryProps>(function GroupHeaderSummaryComponent({
  group,
  showInlineCheckbox,
  isFullySelected,
  isPartiallySelected,
  onSelectionChange,
}) {
  const checkboxState = resolveCheckboxState(isFullySelected, isPartiallySelected);

  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      {showInlineCheckbox && (
        <Checkbox
          aria-label={`Select all files in group ${group.groupLabel}`}
          checked={checkboxState}
          onCheckedChange={(checked) => onSelectionChange(checked === true)}
          onClick={(event) => event.stopPropagation()}
        />
      )}
      <div className="inline-flex min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 font-medium text-sm">
        <FolderOpen className="size-4 flex-shrink-0 text-muted-foreground" />
        <span className="truncate">
          {group.groupLabel}
          <span className="sr-only">{` (${group.count} file${group.count === 1 ? '' : 's'})`}</span>
        </span>
      </div>
      <span aria-hidden="true" className="text-muted-foreground text-xs">
        {group.count} files
      </span>
    </div>
  );
});
GroupHeaderSummary.displayName = 'GroupHeaderSummary';

interface BuildGroupedTreeNodesInput {
  collapsedGroups: Set<string>;
  groupedData: GroupedData<TableRowData>[];
  pagination: { startIndex: number; endIndex: number };
}

interface BuildGroupedTreeNodesResult {
  expandedGroupNodeIds: Set<string>;
  groupKeyByNodeId: Map<string, GroupKey>;
  nodes: TreeNode<PreviewTreeNodeData>[];
}

function areStringSetsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left === right) {
    return true;
  }
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function resolveGroupNodeId(groupKey: string): string {
  return `group:${groupKey}`;
}

function resolveItemNodeId(compositeKey: string): string {
  return `item:${compositeKey}`;
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
  const groupNodeId = resolveGroupNodeId(groupKey);
  return {
    id: groupNodeId,
    type: 'preview-group',
    depth: 0,
    parentId: null,
    hasChildren: group.items.length > 0,
    data: {
      kind: 'group',
      group,
    },
  };
}

function createItemTreeNode(item: TableRowData, parentId: string): TreeNode<PreviewTreeNodeData> {
  return {
    id: resolveItemNodeId(item.compositeKey),
    type: 'preview-item',
    depth: 1,
    parentId,
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
  groupNodeId: string,
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
    nodes.push(createItemTreeNode(item, groupNodeId));
  }

  return visibleRowIndex + group.items.length;
}

function buildGroupedTreeNodes({
  groupedData,
  collapsedGroups,
  pagination,
}: BuildGroupedTreeNodesInput): BuildGroupedTreeNodesResult {
  const nodes: TreeNode<PreviewTreeNodeData>[] = [];
  const expandedGroupNodeIds = new Set<string>();
  const groupKeyByNodeId = new Map<string, GroupKey>();
  let visibleRowIndex = 0;

  for (const group of groupedData) {
    const groupKey = group.groupKey;
    const groupKeyString = String(groupKey);
    const groupNodeId = resolveGroupNodeId(groupKeyString);
    const isCollapsed = collapsedGroups.has(groupKeyString);
    const groupVisibleRowCount = resolveGroupVisibleRowCount(group, isCollapsed);
    groupKeyByNodeId.set(groupNodeId, groupKey);
    const pageStartsInsideItems =
      !isCollapsed &&
      pagination.startIndex > visibleRowIndex &&
      pagination.startIndex < visibleRowIndex + groupVisibleRowCount;
    const shouldRenderGroupRow =
      isRowInsidePageWindow(visibleRowIndex, pagination) || pageStartsInsideItems;

    // Fast-path: skip whole groups that are fully before the requested page window.
    // This avoids O(startIndex) item-by-item scans for large grouped datasets.
    if (visibleRowIndex + groupVisibleRowCount <= pagination.startIndex) {
      visibleRowIndex += groupVisibleRowCount;
      continue;
    }

    if (hasReachedPageEnd(visibleRowIndex, pagination)) {
      break;
    }

    if (shouldRenderGroupRow) {
      nodes.push(createGroupTreeNode(group, groupKeyString));
      if (!isCollapsed && group.items.length > 0) {
        expandedGroupNodeIds.add(groupNodeId);
      }
    }
    visibleRowIndex += 1;

    if (isCollapsed) {
      if (hasReachedPageEnd(visibleRowIndex, pagination)) {
        break;
      }
      continue;
    }

    visibleRowIndex = appendVisibleGroupItems(
      nodes,
      group,
      groupNodeId,
      visibleRowIndex,
      pagination
    );

    if (hasReachedPageEnd(visibleRowIndex, pagination)) {
      break;
    }
  }

  return {
    nodes,
    expandedGroupNodeIds,
    groupKeyByNodeId,
  };
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
  field: keyof TableRowData;
  onSort: (field: keyof TableRowData) => void;
  sortDirection: 'asc' | 'desc';
  sortField: keyof TableRowData;
  title: string;
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
    scrollAreaClassName,
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
  const handleGroupSelectAllStable = useEventCallback(handleGroupSelectAll);
  const handleGroupDeselectAllStable = useEventCallback(handleGroupDeselectAll);
  const previousExpandedGroupNodeIdsRef = useRef<Set<string> | null>(null);

  // Keep refs for values read inside groupedColumns cell closures at call time.
  // This removes previewSelections, isGroupFullySelected, and isGroupPartiallySelected
  // from the groupedColumns dependency array, avoiding full column invalidation on
  // every checkbox toggle.
  const previewSelectionsRef = useRef(previewSelections);
  previewSelectionsRef.current = previewSelections;

  const isGroupFullySelectedRef = useRef(isGroupFullySelected);
  isGroupFullySelectedRef.current = isGroupFullySelected;

  const isGroupPartiallySelectedRef = useRef(isGroupPartiallySelected);
  isGroupPartiallySelectedRef.current = isGroupPartiallySelected;

  const isAllCurrentPageSelected = useMemo(
    () => isAllSelected(visibleFilesOnPage),
    [isAllSelected, visibleFilesOnPage]
  );

  const groupedTree = useMemo(
    () =>
      buildGroupedTreeNodes({
        groupedData,
        collapsedGroups,
        pagination,
      }),
    [groupedData, collapsedGroups, pagination]
  );

  const stableExpandedGroupNodeIds = useMemo(() => {
    const previousExpandedGroupNodeIds = previousExpandedGroupNodeIdsRef.current;
    if (
      previousExpandedGroupNodeIds &&
      areStringSetsEqual(previousExpandedGroupNodeIds, groupedTree.expandedGroupNodeIds)
    ) {
      return previousExpandedGroupNodeIds;
    }
    return groupedTree.expandedGroupNodeIds;
  }, [groupedTree.expandedGroupNodeIds]);

  useEffect(() => {
    previousExpandedGroupNodeIdsRef.current = stableExpandedGroupNodeIds;
  }, [stableExpandedGroupNodeIds]);

  const primaryGroupColumn = useMemo(
    () => resolvePrimaryGroupColumn(columnVisibility),
    [columnVisibility]
  );

  const renderGroupHeaderIfPrimary = useCallback(
    (group: GroupedData<TableRowData>, columnId: GroupColumnId) => {
      if (primaryGroupColumn !== columnId) {
        return null;
      }
      return (
        <GroupHeaderSummary
          group={group}
          isFullySelected={isGroupFullySelectedRef.current(group)}
          isPartiallySelected={isGroupPartiallySelectedRef.current(group)}
          onSelectionChange={(checked) => {
            if (checked) {
              handleGroupSelectAllStable(group);
              return;
            }
            handleGroupDeselectAllStable(group);
          }}
          showInlineCheckbox={!columnVisibility.checkbox}
        />
      );
    },
    [
      primaryGroupColumn,
      handleGroupSelectAllStable,
      handleGroupDeselectAllStable,
      columnVisibility.checkbox,
    ]
  );

  const onGroupedTreeToggleExpand = useEventCallback((nodeId: string) => {
    if (!nodeId.startsWith('group:')) {
      return;
    }
    const { groupKeyByNodeId } = groupedTree;
    const groupKey = groupKeyByNodeId.get(nodeId);
    if (groupKey === undefined) {
      throw new Error(
        `PreviewTable grouped toggle invariant violated: missing group key for node id "${nodeId}" (visible grouped node count: ${groupKeyByNodeId.size}).`
      );
    }
    toggleGroupCollapse(groupKey);
  });

  // Keep this memo reactive to live selection/sort/group state so headers and cells stay synchronized.
  // Grouped mode keeps column definitions reactive to live selection/sort snapshots.
  // This favors correctness (no stale group summary/header state) over memo hit rate.
  // If profiling shows this as a hotspot, split static structure from reactive cell state.
  const groupedColumns = useMemo<TreeTableColumn<PreviewTreeNodeData>[]>(() => {
    // Stable callback wrappers above keep parent callback identity churn out of this memo.
    // Remaining dependencies are stateful render inputs for cells/headers.
    const columns: TreeTableColumn<PreviewTreeNodeData>[] = [];

    if (columnVisibility.checkbox) {
      columns.push({
        id: 'checkbox',
        isTreeColumn: false,
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
            const checkedState = resolveCheckboxState(
              isGroupFullySelectedRef.current(group),
              isGroupPartiallySelectedRef.current(group)
            );

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
              checked={previewSelectionsRef.current.has(item.compositeKey)}
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
            <div className="flex min-w-0 items-center gap-1.5">
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
            if (primaryGroupColumn === 'tokens') {
              return renderGroupHeaderIfPrimary(node.data.group, 'tokens');
            }
            const { totalTokens } = node.data.group;
            if (!totalTokens) {
              return null;
            }
            return (
              <span className="whitespace-nowrap font-mono text-sm tabular-nums">
                {formatTokenCount(totalTokens)}
              </span>
            );
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
            if (primaryGroupColumn === 'size') {
              return renderGroupHeaderIfPrimary(node.data.group, 'size');
            }
            return (
              <span className="whitespace-nowrap font-mono text-sm tabular-nums">
                {formatPreviewFileSize(node.data.group.totalSize)}
              </span>
            );
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
    onDeselectAllStable,
    onFileClickStable,
    onSelectAllOnPageStable,
    onSortStable,
    onToggleSelectionStable,
    primaryGroupColumn,
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
      <div className={cn('flex-1 overflow-auto', scrollAreaClassName)}>
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

  // Group rows are modeled as parent nodes with item children for true tree semantics.
  return (
    <div className={cn('flex min-h-0 flex-1 overflow-auto', scrollAreaClassName)}>
      <TreeTable
        ariaLabel="Context explorer table"
        className="w-full"
        columns={groupedColumns}
        expandedIds={stableExpandedGroupNodeIds}
        maxHeight="none"
        nodes={groupedTree.nodes}
        onToggleExpand={onGroupedTreeToggleExpand}
        rowClassName={rowClassName}
        selectionMode="none"
        windowingStrategy="none"
      />
    </div>
  );
});

PreviewTable.displayName = 'PreviewTable';
