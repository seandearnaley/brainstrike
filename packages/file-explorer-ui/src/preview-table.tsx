import { Checkbox, SortableTableHeader, TableGroupHeader } from '@brainstrike/ui';
import { FolderOpen } from 'lucide-react';
import { memo, useMemo } from 'react';
import type { ColumnVisibility } from './hooks/use-preview-panel-persistence';
import { PreviewTableRow } from './preview-table-row';
import { formatTokenCount } from './use-preview-panel-state';
import type { GroupedData, GroupKey, TableRowData } from './utils/grouping-configs';

type PreviewTableProps = {
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
};

type PushGroupItemsInput = {
  group: GroupedData<TableRowData>;
  itemCount: number;
  columnVisibility: ColumnVisibility;
  previewSelections: Set<string>;
  onToggleSelection: (compositeKey: string, checked: boolean) => void;
  onFileClick?: ((compositeKey: string) => void) | undefined;
  startIndex: number;
  endIndex: number;
  elements: React.ReactNode[];
};

function pushGroupItemsForPage(input: PushGroupItemsInput): number {
  let currentItemCount = input.itemCount;

  for (const item of input.group.items) {
    if (currentItemCount >= input.endIndex) {
      break;
    }

    if (currentItemCount >= input.startIndex) {
      input.elements.push(
        <PreviewTableRow
          columnVisibility={input.columnVisibility}
          isSelected={input.previewSelections.has(item.compositeKey)}
          item={item}
          key={`item-${item.compositeKey}`}
          onFileClick={input.onFileClick}
          onToggleSelection={input.onToggleSelection}
        />
      );
    }

    currentItemCount += 1;
  }

  return currentItemCount;
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
    visibleFilesOnPage,
    collapsedGroups,
    toggleGroupCollapse,
    isGroupFullySelected,
    isGroupPartiallySelected,
    handleGroupSelectAll,
    handleGroupDeselectAll,
    pagination,
  } = props;

  const totalVisibleColumns = useMemo(
    () => Object.values(columnVisibility).filter(Boolean).length,
    [columnVisibility]
  );

  const isAllCurrentPageSelected = useMemo(
    () => isAllSelected(visibleFilesOnPage),
    [isAllSelected, visibleFilesOnPage]
  );

  const GroupHeaderWrapper = memo(({ group }: { group: GroupedData<TableRowData> }) => {
    const handleSelectionChange = (checked: boolean) => {
      if (checked) {
        handleGroupSelectAll(group);
      } else {
        handleGroupDeselectAll(group);
      }
    };

    return (
      <TableGroupHeader
        colSpan={totalVisibleColumns - 1}
        groupKey={group.groupKey}
        groupLabel={group.groupLabel}
        icon={<FolderOpen className="size-4 text-muted-foreground" />}
        isCollapsed={collapsedGroups.has(String(group.groupKey))}
        isFullySelected={isGroupFullySelected(group)}
        isPartiallySelected={isGroupPartiallySelected(group)}
        onSelectionChange={handleSelectionChange}
        onToggleCollapse={() => toggleGroupCollapse(group.groupKey)}
        stats={
          <>
            <span>{group.count} files</span>
            <span className="whitespace-nowrap tabular-nums">
              {formatTokenCount(group.totalTokens)}
            </span>
            <span className="whitespace-nowrap tabular-nums">
              {(group.totalSize / 1024).toFixed(1)} KB
            </span>
          </>
        }
      />
    );
  });

  const GroupedTableBody = memo(() => {
    const elements: React.ReactNode[] = [];
    let itemCount = 0;

    for (const group of groupedData) {
      const isCollapsed = collapsedGroups.has(String(group.groupKey));

      if (itemCount >= pagination.startIndex && itemCount < pagination.endIndex) {
        elements.push(<GroupHeaderWrapper group={group} key={`group-${group.groupKey}`} />);
      }
      itemCount += 1;

      if (!isCollapsed) {
        itemCount = pushGroupItemsForPage({
          columnVisibility,
          elements,
          endIndex: pagination.endIndex,
          group,
          itemCount,
          onFileClick,
          onToggleSelection,
          previewSelections,
          startIndex: pagination.startIndex,
        });
      }

      if (itemCount >= pagination.endIndex) {
        break;
      }
    }

    return <>{elements}</>;
  });

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
                  className="w-20"
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
            {groupingConfig === 'none' ? (
              currentPageData.map((item) => (
                <PreviewTableRow
                  columnVisibility={columnVisibility}
                  isSelected={previewSelections.has(item.compositeKey)}
                  item={item}
                  key={item.compositeKey}
                  onFileClick={onFileClick}
                  onToggleSelection={onToggleSelection}
                />
              ))
            ) : (
              <GroupedTableBody />
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
});

PreviewTable.displayName = 'PreviewTable';
