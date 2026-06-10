import { useEventCallback } from '@brainstrike/hooks';
// Subpath import avoids pulling the full @brainstrike/preferences barrel
// (and its transitive log-viewer / Select dependency tree) into render-time
// graphs that other test files mock at the package boundary.
import { useContextPreviewColumnSizesStore } from '@brainstrike/preferences/stores/context-preview-column-sizes-store';
import { Checkbox, cn, type TreeNode, TreeTable, type TreeTableColumn } from '@brainstrike/ui';
import { FolderOpen } from 'lucide-react';
import {
  type MutableRefObject,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { ExtensionBadge } from '../extension-badge';
import type { GroupedData, GroupKey, TableRowData } from '../utils/grouping-configs';
import {
  formatFilePathSubtitle,
  getRootFolderDisplayName,
  splitFilePath,
} from '../utils/path-display';
import { formatPreviewFileSize } from '../utils/preview-formatters';
import type { ColumnVisibility } from './use-preview-panel-persistence';
import { formatTokenCount } from './use-preview-panel-state';

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

const PREVIEW_CHECKBOX_COLUMN_WIDTH = 32;
const PREVIEW_CHECKBOX_CELL_CLASS = 'w-8 px-0 py-2';
const PREVIEW_CHECKBOX_HEADER_CLASS = 'h-10 w-8 bg-background px-0 py-2';
const PREVIEW_STANDARD_HEADER_CLASS = 'h-10 px-4 py-2';
const PREVIEW_TREE_HEADER_CLASS = 'h-10 pr-4 pl-[38px] py-2';
const EMPTY_EXPANDED_NODE_IDS = new Set<string>();
const UNGROUPED_SORTABLE_COLUMN_IDS = new Set<string>([
  'rootFolderId',
  'path',
  'type',
  'tokens',
  'size',
]);

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
const GROUP_COLUMN_ORDER: GroupColumnId[] = ['path', 'rootFolderId', 'type', 'tokens', 'size'];
const NON_FOLDER_GROUP_COLUMN_ORDER: GroupColumnId[] = [
  'rootFolderId',
  'path',
  'type',
  'tokens',
  'size',
];

interface GroupHeaderSummaryProps {
  group: GroupedData<TableRowData>;
}

const GroupHeaderSummary = memo<GroupHeaderSummaryProps>(function GroupHeaderSummaryComponent({
  group,
}) {
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      <div className="inline-flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-sm px-1 py-0.5 font-medium text-sm">
        <FolderOpen className="size-4 flex-shrink-0 text-muted-foreground" />
        <span className="truncate">
          {group.groupLabel}
          <span className="sr-only">{` (${group.count} file${group.count === 1 ? '' : 's'})`}</span>
        </span>
      </div>
      <span
        aria-hidden="true"
        className="inline-flex h-5 flex-shrink-0 items-center rounded-full border border-border/60 bg-muted/40 px-1.5 font-medium text-[11px] text-muted-foreground tabular-nums"
        title={`${group.count} files`}
      >
        {group.count}
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

function createItemTreeNode(
  item: TableRowData,
  parentId: string | null,
  depth: number
): TreeNode<PreviewTreeNodeData> {
  return {
    id: resolveItemNodeId(item.compositeKey),
    type: 'preview-item',
    depth,
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
    nodes.push(createItemTreeNode(item, groupNodeId, 1));
  }

  return visibleRowIndex + group.items.length;
}

function buildUngroupedTreeNodes(items: TableRowData[]): TreeNode<PreviewTreeNodeData>[] {
  return items.map((item) => createItemTreeNode(item, null, 0));
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

function getPreferredGroupColumnOrder(groupingConfig: string): readonly GroupColumnId[] {
  if (
    groupingConfig === 'fileType' ||
    groupingConfig === 'sizeSteps' ||
    groupingConfig === 'tokenSteps'
  ) {
    return NON_FOLDER_GROUP_COLUMN_ORDER;
  }
  return GROUP_COLUMN_ORDER;
}

function resolvePrimaryGroupColumn(
  columnVisibility: ColumnVisibility,
  groupingConfig: string
): GroupColumnId {
  for (const column of getPreferredGroupColumnOrder(groupingConfig)) {
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

// External store so HeaderSelectionCheckbox can subscribe via
// useSyncExternalStore without adding selection state to the groupedColumns
// memo deps. setSnapshot is render-safe (pure mutation); notify fires from
// an effect to satisfy React's no-setState-during-render rule.
interface HeaderSelectionStore {
  getSnapshot: () => boolean;
  notify: () => void;
  setSnapshot: (next: boolean) => void;
  subscribe: (listener: () => void) => () => void;
}

function createHeaderSelectionStore(initial: boolean): HeaderSelectionStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    notify: () => {
      // Snapshot listeners before iteration — if a listener synchronously
      // triggers a React state update that unmounts a sibling subscriber,
      // the underlying Set would mutate mid-loop. Matches the pattern used
      // in Zustand/Redux internals.
      for (const listener of [...listeners]) {
        listener();
      }
    },
    setSnapshot: (next) => {
      state = next;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

interface HeaderSelectionCheckboxProps {
  label: string;
  onDeselectAll: () => void;
  onSelectAll: () => void;
  store: HeaderSelectionStore;
}

// memo so re-renders of the parent don't cascade through the checkbox when
// none of its props changed — defense-in-depth in case a future refactor
// moves the callsite outside the memoized column definition.
const HeaderSelectionCheckbox = memo(function HeaderSelectionCheckbox({
  label,
  onDeselectAll,
  onSelectAll,
  store,
}: HeaderSelectionCheckboxProps) {
  const isComplete = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <div className="flex h-full items-center justify-center">
      <Checkbox
        aria-label={label}
        checked={isComplete}
        onCheckedChange={(checked) => (checked ? onSelectAll() : onDeselectAll())}
        title={label}
      />
    </div>
  );
});

interface GroupedColumnBuilderArgs {
  columnVisibility: ColumnVisibility;
  groupedTreeColumnId: GroupColumnId | null;
  handleGroupDeselectAllStable: (group: GroupedData<TableRowData>) => void;
  handleGroupSelectAllStable: (group: GroupedData<TableRowData>) => void;
  headerSelectableFilesRef: MutableRefObject<TableRowData[]>;
  headerSelectionLabel: string;
  headerSelectionStore: HeaderSelectionStore;
  isGroupFullySelectedRef: MutableRefObject<(group: GroupedData<TableRowData>) => boolean>;
  isGroupPartiallySelectedRef: MutableRefObject<(group: GroupedData<TableRowData>) => boolean>;
  onDeselectAllStable: () => void;
  onFileClickStable: (compositeKey: string) => void;
  onSelectAllOnPageStable: (items: TableRowData[]) => void;
  onSortStable: (field: keyof TableRowData) => void;
  onToggleSelectionStable: (compositeKey: string, checked: boolean) => void;
  previewSelectionsRef: MutableRefObject<Set<string>>;
  primaryGroupColumn: GroupColumnId;
  renderGroupHeaderIfPrimary: (
    group: GroupedData<TableRowData>,
    columnId: GroupColumnId
  ) => ReactNode;
  sortDirection: 'asc' | 'desc';
  sortField: keyof TableRowData;
}

// Column widths are owned by TreeTable's <colgroup> + table-fixed layout
// (see packages/ui/src/tree-table/tree-table.tsx). The widthClassName
// parameter that used to live here was dead weight under table-fixed and
// confused readers — removed in BST-549.
function resolveGroupedHeaderClassName(isTreeColumn: boolean): string {
  return cn(isTreeColumn ? PREVIEW_TREE_HEADER_CLASS : PREVIEW_STANDARD_HEADER_CLASS);
}

function createGroupedCheckboxColumn({
  handleGroupDeselectAllStable,
  handleGroupSelectAllStable,
  headerSelectionLabel,
  headerSelectableFilesRef,
  headerSelectionStore,
  isGroupFullySelectedRef,
  isGroupPartiallySelectedRef,
  onDeselectAllStable,
  onSelectAllOnPageStable,
  onToggleSelectionStable,
  previewSelectionsRef,
}: Pick<
  GroupedColumnBuilderArgs,
  | 'handleGroupDeselectAllStable'
  | 'handleGroupSelectAllStable'
  | 'headerSelectionLabel'
  | 'headerSelectableFilesRef'
  | 'headerSelectionStore'
  | 'isGroupFullySelectedRef'
  | 'isGroupPartiallySelectedRef'
  | 'onDeselectAllStable'
  | 'onSelectAllOnPageStable'
  | 'onToggleSelectionStable'
  | 'previewSelectionsRef'
>): TreeTableColumn<PreviewTreeNodeData> {
  return {
    id: 'checkbox',
    isTreeColumn: false,
    // Pinned width=min=max so TreeTable treats this as non-resizable and
    // suppresses the handle. The checkbox is a fixed utility column.
    width: PREVIEW_CHECKBOX_COLUMN_WIDTH,
    minWidth: PREVIEW_CHECKBOX_COLUMN_WIDTH,
    maxWidth: PREVIEW_CHECKBOX_COLUMN_WIDTH,
    resizable: false,
    header: (
      <HeaderSelectionCheckbox
        label={headerSelectionLabel}
        onDeselectAll={onDeselectAllStable}
        onSelectAll={() => onSelectAllOnPageStable(headerSelectableFilesRef.current)}
        store={headerSelectionStore}
      />
    ),
    className: PREVIEW_CHECKBOX_CELL_CLASS,
    headerClassName: PREVIEW_CHECKBOX_HEADER_CLASS,
    headerContentClassName: 'w-full justify-center',
    cell: ({ node }) => {
      if (node.data.kind === 'group') {
        const group = node.data.group;
        const checkedState = resolveCheckboxState(
          isGroupFullySelectedRef.current(group),
          isGroupPartiallySelectedRef.current(group)
        );

        return (
          <div className="flex h-full items-center justify-center">
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
          </div>
        );
      }

      const item = node.data.item;
      return (
        <div className="flex h-full items-center justify-center">
          <Checkbox
            aria-label={`Select ${item.path}`}
            checked={previewSelectionsRef.current.has(item.compositeKey)}
            onCheckedChange={(checked) =>
              onToggleSelectionStable(item.compositeKey, checked === true)
            }
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      );
    },
  };
}

function createGroupedRootFolderColumn({
  columnVisibility,
  groupedTreeColumnId,
  onSortStable,
  primaryGroupColumn,
  renderGroupHeaderIfPrimary,
  sortDirection,
  sortField,
}: Pick<
  GroupedColumnBuilderArgs,
  | 'columnVisibility'
  | 'groupedTreeColumnId'
  | 'onSortStable'
  | 'primaryGroupColumn'
  | 'renderGroupHeaderIfPrimary'
  | 'sortDirection'
  | 'sortField'
>): TreeTableColumn<PreviewTreeNodeData> {
  const isTreeColumn = groupedTreeColumnId === 'rootFolderId';
  return {
    id: 'rootFolderId',
    indentWidth: 8,
    isTreeColumn,
    header: (
      <SortHeaderButton
        field="rootFolderId"
        onSort={onSortStable}
        sortDirection={sortDirection}
        sortField={sortField}
        title="Folder"
      />
    ),
    defaultWidth: 176,
    minWidth: 100,
    maxWidth: 360,
    className: isTreeColumn ? 'pr-4 pl-0 py-2' : 'px-4 py-2',
    colSpan: ({ node }) =>
      node.data.kind === 'group' && primaryGroupColumn === 'rootFolderId' && columnVisibility.path
        ? 2
        : 1,
    headerClassName: resolveGroupedHeaderClassName(isTreeColumn),
    cell: ({ node }) => {
      if (node.data.kind === 'group') {
        return renderGroupHeaderIfPrimary(node.data.group, 'rootFolderId');
      }

      const item = node.data.item;
      const displayRootFolder = getRootFolderDisplayName(item.rootFolderId);
      return (
        <div className="flex min-w-0 items-center gap-1.5">
          <FolderOpen className="size-4 flex-shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-mono text-sm" title={item.rootFolderId}>
            {displayRootFolder}
          </span>
        </div>
      );
    },
  };
}

function createGroupedPathColumn({
  groupedTreeColumnId,
  onFileClickStable,
  onSortStable,
  renderGroupHeaderIfPrimary,
  sortDirection,
  sortField,
}: Pick<
  GroupedColumnBuilderArgs,
  | 'groupedTreeColumnId'
  | 'onFileClickStable'
  | 'onSortStable'
  | 'renderGroupHeaderIfPrimary'
  | 'sortDirection'
  | 'sortField'
>): TreeTableColumn<PreviewTreeNodeData> {
  const isTreeColumn = groupedTreeColumnId === 'path';
  return {
    id: 'path',
    indentWidth: 8,
    isTreeColumn,
    header: (
      <SortHeaderButton
        field="path"
        onSort={onSortStable}
        sortDirection={sortDirection}
        sortField={sortField}
        title="File Path"
      />
    ),
    defaultWidth: 360,
    minWidth: 160,
    maxWidth: 900,
    className: isTreeColumn ? 'pr-4 pl-0 py-2' : 'px-4 py-2',
    headerClassName: resolveGroupedHeaderClassName(isTreeColumn),
    cell: ({ node }) => {
      if (node.data.kind === 'group') {
        return renderGroupHeaderIfPrimary(node.data.group, 'path');
      }

      const item = node.data.item;
      const { fileName } = splitFilePath(item.path);
      const displayDirPath = formatFilePathSubtitle({
        filePath: item.path,
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
            <div className="truncate font-mono text-muted-foreground text-xs" title={item.path}>
              {displayDirPath}
            </div>
          )}
        </button>
      );
    },
  };
}

function createGroupedTypeColumn({
  groupedTreeColumnId,
  onSortStable,
  renderGroupHeaderIfPrimary,
  sortDirection,
  sortField,
}: Pick<
  GroupedColumnBuilderArgs,
  | 'groupedTreeColumnId'
  | 'onSortStable'
  | 'renderGroupHeaderIfPrimary'
  | 'sortDirection'
  | 'sortField'
>): TreeTableColumn<PreviewTreeNodeData> {
  const isTreeColumn = groupedTreeColumnId === 'type';
  return {
    id: 'type',
    isTreeColumn,
    header: (
      <SortHeaderButton
        field="type"
        onSort={onSortStable}
        sortDirection={sortDirection}
        sortField={sortField}
        title="Type"
      />
    ),
    defaultWidth: 96,
    minWidth: 72,
    maxWidth: 180,
    className: isTreeColumn ? 'pr-4 pl-0 py-2' : 'px-4 py-2',
    headerClassName: resolveGroupedHeaderClassName(isTreeColumn),
    cell: ({ node }) => {
      if (node.data.kind === 'group') {
        return renderGroupHeaderIfPrimary(node.data.group, 'type');
      }

      return <ExtensionBadge extension={node.data.item.type} />;
    },
  };
}

function createGroupedTokensColumn({
  groupedTreeColumnId,
  onSortStable,
  primaryGroupColumn,
  renderGroupHeaderIfPrimary,
  sortDirection,
  sortField,
}: Pick<
  GroupedColumnBuilderArgs,
  | 'groupedTreeColumnId'
  | 'onSortStable'
  | 'primaryGroupColumn'
  | 'renderGroupHeaderIfPrimary'
  | 'sortDirection'
  | 'sortField'
>): TreeTableColumn<PreviewTreeNodeData> {
  const isTreeColumn = groupedTreeColumnId === 'tokens';
  return {
    id: 'tokens',
    isTreeColumn,
    header: (
      <SortHeaderButton
        field="tokens"
        onSort={onSortStable}
        sortDirection={sortDirection}
        sortField={sortField}
        title="Tokens"
      />
    ),
    defaultWidth: 96,
    minWidth: 72,
    maxWidth: 180,
    className: isTreeColumn
      ? 'whitespace-nowrap pr-4 pl-0 py-2 text-right tabular-nums'
      : 'whitespace-nowrap px-4 py-2 text-right tabular-nums',
    headerClassName: resolveGroupedHeaderClassName(isTreeColumn),
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
      if (tokens === undefined) {
        return <span className="text-muted-foreground text-sm">—</span>;
      }
      return (
        <span className="whitespace-nowrap font-mono text-sm tabular-nums">
          {formatTokenCount(tokens)}
        </span>
      );
    },
  };
}

function createGroupedSizeColumn({
  groupedTreeColumnId,
  onSortStable,
  primaryGroupColumn,
  renderGroupHeaderIfPrimary,
  sortDirection,
  sortField,
}: Pick<
  GroupedColumnBuilderArgs,
  | 'groupedTreeColumnId'
  | 'onSortStable'
  | 'primaryGroupColumn'
  | 'renderGroupHeaderIfPrimary'
  | 'sortDirection'
  | 'sortField'
>): TreeTableColumn<PreviewTreeNodeData> {
  const isTreeColumn = groupedTreeColumnId === 'size';
  return {
    id: 'size',
    isTreeColumn,
    header: (
      <SortHeaderButton
        field="size"
        onSort={onSortStable}
        sortDirection={sortDirection}
        sortField={sortField}
        title="Size"
      />
    ),
    defaultWidth: 96,
    minWidth: 72,
    maxWidth: 180,
    className: isTreeColumn
      ? 'whitespace-nowrap pr-4 pl-0 py-2 text-right tabular-nums'
      : 'whitespace-nowrap px-4 py-2 text-right tabular-nums',
    headerClassName: resolveGroupedHeaderClassName(isTreeColumn),
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
  };
}

function buildPreviewColumns(
  args: GroupedColumnBuilderArgs
): TreeTableColumn<PreviewTreeNodeData>[] {
  const columns: TreeTableColumn<PreviewTreeNodeData>[] = [];

  if (args.columnVisibility.checkbox) {
    columns.push(createGroupedCheckboxColumn(args));
  }
  if (args.columnVisibility.rootFolderId) {
    columns.push(createGroupedRootFolderColumn(args));
  }
  if (args.columnVisibility.path) {
    columns.push(createGroupedPathColumn(args));
  }
  if (args.columnVisibility.type) {
    columns.push(createGroupedTypeColumn(args));
  }
  if (args.columnVisibility.tokens) {
    columns.push(createGroupedTokensColumn(args));
  }
  if (args.columnVisibility.size) {
    columns.push(createGroupedSizeColumn(args));
  }

  return columns;
}

function markUngroupedSortableColumns(
  columns: TreeTableColumn<PreviewTreeNodeData>[]
): TreeTableColumn<PreviewTreeNodeData>[] {
  return columns.map((column) => {
    if (!UNGROUPED_SORTABLE_COLUMN_IDS.has(column.id)) {
      return column;
    }
    return { ...column, showSortIndicator: false, sortable: true };
  });
}

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

  // The empty-array case must be `false` — otherwise the pre-selection state
  // (currentPageData = []) would satisfy the contract before any data exists.
  // Scope is intentionally narrow (size only) — `tokens` may never resolve for
  // non-text files, which would make a token-inclusive gate uncloseable.
  const rowsReady = useMemo(
    () =>
      currentPageData.length > 0 && currentPageData.every((row) => typeof row.size === 'number'),
    [currentPageData]
  );
  const rowsReadyAttr = rowsReady ? 'true' : 'false';

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

  // Stable per-component store so HeaderSelectionCheckbox can subscribe via
  // useSyncExternalStore — lets the header reflect selection changes
  // without invalidating the groupedColumns memo.
  const headerSelectionStore = useMemo(() => createHeaderSelectionStore(false), []);
  const headerSelectableFilesRef = useRef<TableRowData[]>([]);

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
    () => resolvePrimaryGroupColumn(columnVisibility, groupingConfig),
    [columnVisibility, groupingConfig]
  );

  const renderGroupHeaderIfPrimary = useCallback(
    (group: GroupedData<TableRowData>, columnId: GroupColumnId) => {
      if (primaryGroupColumn !== columnId) {
        return null;
      }
      return <GroupHeaderSummary group={group} />;
    },
    [primaryGroupColumn]
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

  const groupedTreeColumnId = useMemo<GroupColumnId | null>(() => {
    if (groupingConfig === 'none') {
      return null;
    }
    for (const columnId of getPreferredGroupColumnOrder(groupingConfig)) {
      if (columnVisibility[columnId]) {
        return columnId;
      }
    }
    return null;
  }, [columnVisibility, groupingConfig]);

  const allGroupedFiles = useMemo(() => groupedData.flatMap((group) => group.items), [groupedData]);

  // Grouped mode intentionally promotes header select-all to the full grouped dataset.
  // The compact header label distinguishes that behavior from ungrouped page-scoped selection.
  const headerSelectableFiles = groupingConfig === 'none' ? visibleFilesOnPage : allGroupedFiles;
  const headerSelectionLabel =
    groupingConfig === 'none'
      ? 'Select all files on current page'
      : 'Select all files in grouped results';
  headerSelectableFilesRef.current = headerSelectableFiles;
  const isHeaderSelectionComplete = isAllSelected(headerSelectableFiles);
  // Sync the latest snapshot during render (safe — closure-state mutation,
  // no listener calls) so useSyncExternalStore reads the correct value on
  // the immediately-following HeaderSelectionCheckbox render. Listener
  // notification happens in the post-commit effect below to satisfy
  // React's "no setState while rendering another component" rule.
  headerSelectionStore.setSnapshot(isHeaderSelectionComplete);
  useEffect(() => {
    headerSelectionStore.notify();
  }, [headerSelectionStore, isHeaderSelectionComplete]);

  // Selection-driven state flows through refs + a useSyncExternalStore-backed
  // header checkbox, so this memo stays stable across pure-selection re-renders.
  // Only structural deltas (columnVisibility, sort/group config, etc.) rebuild
  // the columns array.
  const previewColumns = useMemo<TreeTableColumn<PreviewTreeNodeData>[]>(
    () =>
      buildPreviewColumns({
        columnVisibility,
        groupedTreeColumnId,
        handleGroupDeselectAllStable,
        handleGroupSelectAllStable,
        headerSelectionLabel,
        headerSelectableFilesRef,
        headerSelectionStore,
        isGroupFullySelectedRef,
        isGroupPartiallySelectedRef,
        onDeselectAllStable,
        onFileClickStable,
        onSelectAllOnPageStable,
        onSortStable,
        onToggleSelectionStable,
        previewSelectionsRef,
        primaryGroupColumn,
        renderGroupHeaderIfPrimary,
        sortDirection,
        sortField,
      }),
    [
      columnVisibility,
      groupedTreeColumnId,
      handleGroupDeselectAllStable,
      handleGroupSelectAllStable,
      headerSelectionLabel,
      headerSelectionStore,
      onDeselectAllStable,
      onFileClickStable,
      onSelectAllOnPageStable,
      onSortStable,
      onToggleSelectionStable,
      primaryGroupColumn,
      renderGroupHeaderIfPrimary,
      sortDirection,
      sortField,
    ]
  );
  const ungroupedPreviewColumns = useMemo(
    () => markUngroupedSortableColumns(previewColumns),
    [previewColumns]
  );
  const ungroupedSortState = useMemo(
    () => ({ columnId: String(sortField), direction: sortDirection }),
    [sortDirection, sortField]
  );

  const ungroupedTreeNodes = useMemo(
    () => buildUngroupedTreeNodes(currentPageData),
    [currentPageData]
  );

  const rowClassName = useCallback((node: TreeNode<PreviewTreeNodeData>) => {
    if (node.data.kind === 'group') {
      return 'bg-muted/40 hover:bg-muted/60';
    }
    return '';
  }, []);

  // Subscribe to persisted column widths for the grouped TreeTable path.
  // Subscribed at the component level so resizes during a paint cycle are
  // applied to the next render via TreeTable's controlled-sizing prop.
  const columnSizes = useContextPreviewColumnSizesStore(
    (state: { sizes: Record<string, number> }) => state.sizes
  );
  const setColumnSizes = useContextPreviewColumnSizesStore(
    (state: { setAll: (next: Record<string, number>) => void }) => state.setAll
  );
  const onUngroupedTreeToggleExpand = useCallback((nodeId: string) => {
    throw new Error(
      `PreviewTable ungrouped toggle invariant violated: "${nodeId}" is not expandable.`
    );
  }, []);

  if (groupingConfig === 'none') {
    return (
      <div
        className={cn('flex min-h-0 flex-1 overflow-auto', scrollAreaClassName)}
        data-rows-ready={rowsReadyAttr}
        data-testid="preview-table"
      >
        <TreeTable
          ariaLabel="Context explorer table"
          className="w-full"
          columnSizes={columnSizes}
          columns={ungroupedPreviewColumns}
          expandedIds={EMPTY_EXPANDED_NODE_IDS}
          maxHeight="none"
          nodes={ungroupedTreeNodes}
          onColumnSizesChange={setColumnSizes}
          onToggleExpand={onUngroupedTreeToggleExpand}
          rowClassName={rowClassName}
          selectionMode="none"
          sortState={ungroupedSortState}
          windowingStrategy="none"
        />
      </div>
    );
  }

  // Group rows are modeled as parent nodes with item children for true tree semantics.
  return (
    <div
      className={cn('flex min-h-0 flex-1 overflow-auto', scrollAreaClassName)}
      data-rows-ready={rowsReadyAttr}
      data-testid="preview-table"
    >
      <TreeTable
        ariaLabel="Context explorer table"
        className="w-full"
        columnSizes={columnSizes}
        columns={previewColumns}
        expandedIds={stableExpandedGroupNodeIds}
        maxHeight="none"
        nodes={groupedTree.nodes}
        onColumnSizesChange={setColumnSizes}
        onToggleExpand={onGroupedTreeToggleExpand}
        rowClassName={rowClassName}
        selectionMode="none"
        windowingStrategy="none"
      />
    </div>
  );
});

PreviewTable.displayName = 'PreviewTable';
