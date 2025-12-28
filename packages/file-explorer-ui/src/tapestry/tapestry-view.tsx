import { Button, Checkbox, EmptyState, TablePagination, TooltipProvider } from '@brainstrike/ui';
import { CheckSquare, ChevronDown, ChevronRight, FileX2 } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PreviewGroupingControls } from '../preview-grouping-controls';
import { formatTokenCount } from '../use-preview-panel-state';
import type { GroupedData, GroupKey, TableRowData } from '../utils/grouping-configs';
import { formatPreviewFileSize } from '../utils/preview-formatters';
import { Minimap } from './minimap';
import { TapestryControls } from './tapestry-controls';
import type { DragState, FileTapestry, InteractionMode, TapestryRange } from './types';
import { createRangeId, generateColor } from './utils';

/**
 * Applies basic movement and resize deltas to range boundaries.
 */
function applyDeltas(
  initialRange: TapestryRange,
  mode: InteractionMode,
  deltaLines: number,
  currentEnd: number
): { startLine: number; endLine: number } {
  if (mode === 'MOVING') {
    const rangeHeight = initialRange.endLine - initialRange.startLine;
    const start = initialRange.startLine + deltaLines;
    return { startLine: start, endLine: start + rangeHeight };
  }
  if (mode === 'RESIZING_TOP') {
    let start = initialRange.startLine + deltaLines;
    if (start >= currentEnd - 1) {
      start = currentEnd - 1;
    }
    return { startLine: start, endLine: currentEnd };
  }
  if (mode === 'RESIZING_BOTTOM') {
    let end = initialRange.endLine + deltaLines;
    const start = initialRange.startLine;
    if (end <= start + 1) {
      end = start + 1;
    }
    return { startLine: start, endLine: end };
  }
  return { startLine: initialRange.startLine, endLine: initialRange.endLine };
}

/**
 * Constrains range boundaries to prevent overlap with other ranges.
 */
function applyOverlapConstraints(
  bounds: { startLine: number; endLine: number },
  initialRange: TapestryRange,
  mode: InteractionMode,
  totalLines: number,
  otherRanges: TapestryRange[]
): { startLine: number; endLine: number } {
  const sortedOthers = [...otherRanges].sort((a, b) => a.startLine - b.startLine);
  const prevRange = sortedOthers.filter((r) => r.endLine <= initialRange.startLine).pop();
  const nextRange = sortedOthers.filter((r) => r.startLine >= initialRange.endLine).shift();
  const minLine = prevRange ? prevRange.endLine : 0;
  const maxLine = nextRange ? nextRange.startLine : totalLines;

  let { startLine, endLine } = bounds;

  if (mode === 'MOVING') {
    const height = endLine - startLine;
    if (startLine < minLine) {
      startLine = minLine;
      endLine = startLine + height;
    }
    if (endLine > maxLine) {
      endLine = maxLine;
      startLine = endLine - height;
    }
  } else if (mode === 'RESIZING_TOP') {
    if (startLine < minLine) {
      startLine = minLine;
    }
  } else if (mode === 'RESIZING_BOTTOM' && endLine > maxLine) {
    endLine = maxLine;
  }

  return { startLine, endLine };
}

/**
 * Calculates new range boundaries based on movement/resize and constraints.
 */
function calculateNewRange(
  range: TapestryRange,
  initialRange: TapestryRange,
  mode: InteractionMode,
  deltaLines: number,
  totalLines: number,
  allowOverlap: boolean,
  otherRanges: TapestryRange[]
): { startLine: number; endLine: number } {
  let bounds = applyDeltas(initialRange, mode, deltaLines, range.endLine);

  if (!allowOverlap) {
    bounds = applyOverlapConstraints(bounds, initialRange, mode, totalLines, otherRanges);
  }

  // Boundary clamping
  let { startLine, endLine } = bounds;
  if (startLine < 0) {
    if (mode === 'MOVING') {
      endLine += 0 - startLine;
    }
    startLine = 0;
  }
  if (endLine > totalLines) {
    if (mode === 'MOVING') {
      startLine -= endLine - totalLines;
    }
    endLine = totalLines;
  }

  // Final sanity check
  if (startLine < 0) {
    startLine = 0;
  }
  if (endLine > totalLines) {
    endLine = totalLines;
  }

  return { startLine, endLine };
}

type TapestrySection = {
  group: GroupedData<TableRowData>;
  isCollapsed: boolean;
  showHeader: boolean;
  items: FileTapestry[];
};

type TapestryViewProps = {
  ungroupedFiles: FileTapestry[];
  groupedSections: TapestrySection[];
  groupedData: GroupedData<TableRowData>[];
  groupingConfig: string;
  onGroupingChange: (value: string) => void;
  onExpandAllGroups: () => void;
  onCollapseAllGroups: () => void;
  onToggleGroupCollapse: (groupKey: GroupKey) => void;
  onGroupSelectAll: (group: GroupedData<TableRowData>) => void;
  onGroupDeselectAll: (group: GroupedData<TableRowData>) => void;
  isGroupFullySelected: (group: GroupedData<TableRowData>) => boolean;
  isGroupPartiallySelected: (group: GroupedData<TableRowData>) => boolean;
  previewSelections: Set<string>;
  onToggleSelection: (compositeKey: string, checked: boolean) => void;
  visibleFilesOnPage: TableRowData[];
  onSelectAllOnPage: (items: TableRowData[]) => void;
  onDeselectAll: () => void;
  onSelectAllFiles: () => void;
  isAllSelected: (items: TableRowData[]) => boolean;
  allFilesSelected: boolean;
  totalFiles: number;
  isEmpty: boolean;
  onRangesChange: (fileId: string, ranges: TapestryRange[]) => void;
  onResetRanges: (fileIds: string[]) => void;
  activeRangesCount: number;
  totalLinesSelected: number;
  pagination: {
    currentPage: number;
    totalPages: number;
    totalItems: number;
    onPageChange: (page: number) => void;
    pageInfo?: string;
  };
};

const TapestryGroupHeader = memo<{
  group: GroupedData<TableRowData>;
  isCollapsed: boolean;
  isFullySelected: boolean;
  isPartiallySelected: boolean;
  onToggleCollapse: () => void;
  onSelectionChange: (selected: boolean) => void;
}>(
  ({
    group,
    isCollapsed,
    isFullySelected,
    isPartiallySelected,
    onToggleCollapse,
    onSelectionChange,
  }) => {
    const checkboxState = isPartiallySelected ? 'indeterminate' : isFullySelected;

    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm shadow-xs">
        <Checkbox
          aria-label={`Select all items in group ${group.groupLabel}`}
          checked={checkboxState}
          onCheckedChange={(checked) => {
            if (typeof checked === 'boolean') {
              onSelectionChange(checked);
            }
          }}
          onClick={(event) => event.stopPropagation()}
        />
        <button
          aria-expanded={!isCollapsed}
          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} group ${group.groupLabel}`}
          className="flex flex-1 items-center gap-2 text-left font-medium text-foreground text-sm transition-colors hover:text-primary"
          onClick={onToggleCollapse}
          type="button"
        >
          {isCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
          <span>{group.groupLabel}</span>
          <div className="ml-auto flex items-center gap-4 text-muted-foreground text-xs">
            <span>{group.count} files</span>
            <span className="font-mono tabular-nums">{formatTokenCount(group.totalTokens)}</span>
            <span className="font-mono tabular-nums">{formatPreviewFileSize(group.totalSize)}</span>
          </div>
        </button>
      </div>
    );
  }
);

TapestryGroupHeader.displayName = 'TapestryGroupHeader';

/**
 * Custom hook to handle tapestry drag and drop logic.
 */
function useTapestryDrag(
  files: FileTapestry[],
  onRangesChange: (fileId: string, ranges: TapestryRange[]) => void,
  scale: number,
  allowOverlap: boolean
) {
  const [dragState, setDragState] = useState<DragState>({
    mode: 'IDLE',
    fileId: null,
    rangeId: null,
    startY: 0,
    initialRange: null,
  });

  const updateRanges = useCallback(
    (fileId: string, updater: (ranges: TapestryRange[]) => TapestryRange[]) => {
      const file = files.find((entry) => entry.id === fileId);
      if (!file) {
        return;
      }
      onRangesChange(fileId, updater(file.selections));
    },
    [files, onRangesChange]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (
        dragState.mode === 'IDLE' ||
        !dragState.fileId ||
        !dragState.rangeId ||
        !dragState.initialRange ||
        scale <= 0
      ) {
        return;
      }

      const file = files.find((entry) => entry.id === dragState.fileId);
      if (!file) {
        return;
      }

      const { fileId, rangeId, startY, initialRange, mode } = dragState;
      const deltaLines = Math.round((e.clientY - startY) / scale);

      updateRanges(fileId, (ranges) => {
        const currentRange = ranges.find((range) => range.id === rangeId) ?? initialRange;
        const otherRanges = ranges.filter((range) => range.id !== rangeId);
        const newBounds = calculateNewRange(
          currentRange,
          initialRange,
          mode,
          deltaLines,
          file.totalLines,
          allowOverlap,
          otherRanges
        );

        return ranges.map((range) => (range.id === rangeId ? { ...range, ...newBounds } : range));
      });
    },
    [allowOverlap, dragState, files, scale, updateRanges]
  );

  const handleMouseUp = useCallback(() => {
    setDragState({ mode: 'IDLE', fileId: null, rangeId: null, startY: 0, initialRange: null });
  }, []);

  // Store latest handlers in ref to avoid recreating event listeners
  const handlersRef = useRef({ handleMouseMove, handleMouseUp });

  useEffect(() => {
    handlersRef.current = { handleMouseMove, handleMouseUp };
  }, [handleMouseMove, handleMouseUp]);

  useEffect(() => {
    if (dragState.mode !== 'IDLE') {
      const moveHandler = (e: MouseEvent) => handlersRef.current.handleMouseMove(e);
      const upHandler = () => handlersRef.current.handleMouseUp();

      window.addEventListener('mousemove', moveHandler);
      window.addEventListener('mouseup', upHandler);

      return () => {
        window.removeEventListener('mousemove', moveHandler);
        window.removeEventListener('mouseup', upHandler);
      };
    }
    return;
  }, [dragState.mode]);

  const startDrag = useCallback(
    (
      mode: InteractionMode,
      fileId: string,
      rangeId: string | null,
      clientY: number,
      initialRange?: TapestryRange,
      clickedLine?: number
    ) => {
      const file = files.find((entry) => entry.id === fileId);
      if (!file) {
        return;
      }

      if (mode === 'CREATING' && clickedLine !== undefined) {
        if (
          !allowOverlap &&
          file.selections.some((s) => clickedLine >= s.startLine && clickedLine < s.endLine)
        ) {
          return;
        }

        const newId = createRangeId();
        const newRange: TapestryRange = {
          id: newId,
          startLine: clickedLine,
          endLine: clickedLine + 1,
          isActive: true,
          color: generateColor(file.selections.length),
        };

        updateRanges(fileId, (ranges) => [...ranges, newRange]);
        setDragState({
          mode: 'RESIZING_BOTTOM',
          fileId,
          rangeId: newId,
          startY: clientY,
          initialRange: newRange,
        });
      } else {
        const resolvedRange =
          initialRange ?? file.selections.find((range) => range.id === rangeId) ?? null;
        setDragState({
          mode,
          fileId,
          rangeId,
          startY: clientY,
          initialRange: resolvedRange,
        });
      }
    },
    [allowOverlap, files, updateRanges]
  );

  return { startDrag };
}

export const TapestryView = memo<TapestryViewProps>(function TapestryView({
  ungroupedFiles,
  groupedSections,
  groupedData,
  groupingConfig,
  onGroupingChange,
  onExpandAllGroups,
  onCollapseAllGroups,
  onToggleGroupCollapse,
  onGroupSelectAll,
  onGroupDeselectAll,
  isGroupFullySelected,
  isGroupPartiallySelected,
  previewSelections,
  onToggleSelection,
  visibleFilesOnPage,
  onSelectAllOnPage,
  onDeselectAll,
  onSelectAllFiles,
  isAllSelected,
  allFilesSelected,
  totalFiles,
  isEmpty,
  onRangesChange,
  onResetRanges,
  activeRangesCount,
  totalLinesSelected,
  pagination,
}) {
  const [scale, setScale] = useState(4);
  const [allowOverlap, setAllowOverlap] = useState(false);

  const files = useMemo(
    () =>
      groupingConfig === 'none'
        ? ungroupedFiles
        : groupedSections.flatMap((section) => section.items),
    [groupingConfig, groupedSections, ungroupedFiles]
  );

  const { startDrag } = useTapestryDrag(files, onRangesChange, scale, allowOverlap);

  const rangeIdToIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    let count = 1;
    for (const file of files) {
      const sorted = [...file.selections].sort((a, b) => a.startLine - b.startLine);
      for (const selection of sorted) {
        if (selection.isActive) {
          map.set(selection.id, count);
          count += 1;
        }
      }
    }
    return map;
  }, [files]);

  const getGlobalIndex = useCallback(
    (rangeId: string) => rangeIdToIndexMap.get(rangeId) || 0,
    [rangeIdToIndexMap]
  );

  const updateRanges = useCallback(
    (fileId: string, updater: (ranges: TapestryRange[]) => TapestryRange[]) => {
      const file = files.find((entry) => entry.id === fileId);
      if (!file) {
        return;
      }
      onRangesChange(fileId, updater(file.selections));
    },
    [files, onRangesChange]
  );

  const handleToggleRange = useCallback(
    (fileId: string, rangeId: string) => {
      updateRanges(fileId, (ranges) =>
        ranges.map((range) =>
          range.id === rangeId ? { ...range, isActive: !range.isActive } : range
        )
      );
    },
    [updateRanges]
  );

  const handleMoveRange = useCallback(
    (fileId: string, rangeId: string, newStartLine: number, newEndLine: number) => {
      updateRanges(fileId, (ranges) =>
        ranges.map((range) =>
          range.id === rangeId ? { ...range, startLine: newStartLine, endLine: newEndLine } : range
        )
      );
    },
    [updateRanges]
  );

  const isAllCurrentPageSelected = useMemo(
    () => isAllSelected(visibleFilesOnPage),
    [isAllSelected, visibleFilesOnPage]
  );

  const isAnySelectedOnPage = useMemo(
    () => visibleFilesOnPage.some((item) => previewSelections.has(item.compositeKey)),
    [previewSelections, visibleFilesOnPage]
  );

  const pageCheckboxState = isAllCurrentPageSelected
    ? true
    : isAnySelectedOnPage
      ? 'indeterminate'
      : false;

  const handleResetRanges = useCallback(() => {
    onResetRanges(files.map((file) => file.id));
  }, [files, onResetRanges]);

  const paginationInfo = pagination.pageInfo ? { pageInfo: pagination.pageInfo } : {};

  if (isEmpty) {
    return (
      <div className="flex flex-1 flex-col">
        <EmptyState
          description="Try adjusting your filters or selecting more files"
          icon={<FileX2 />}
          title="No matching files"
        />
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
        <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-background p-3">
          <PreviewGroupingControls
            groupedData={groupedData}
            groupingConfig={groupingConfig}
            onCollapseAllGroups={onCollapseAllGroups}
            onExpandAllGroups={onExpandAllGroups}
            onGroupingChange={onGroupingChange}
          />
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1 text-xs">
              <Checkbox
                aria-label="Select all files on current page"
                checked={pageCheckboxState}
                onCheckedChange={(checked) =>
                  checked ? onSelectAllOnPage(visibleFilesOnPage) : onDeselectAll()
                }
                onClick={(event) => event.stopPropagation()}
              />
              <span className="text-muted-foreground">Page</span>
            </div>
            <Button
              aria-label={`Select all ${totalFiles} files`}
              className="@[600px]:h-9 h-8 @[600px]:px-3 px-2"
              data-testid="select-all-button"
              disabled={allFilesSelected}
              onClick={onSelectAllFiles}
              size="sm"
              variant="outline"
            >
              <CheckSquare className="@[600px]:mr-2 size-3.5" />
              <span className="@[750px]:inline hidden">Select All ({totalFiles})</span>
              <span className="@[550px]:inline @[750px]:hidden hidden">Select All</span>
            </Button>
          </div>
        </div>

        <TapestryControls
          activeRanges={activeRangesCount}
          allowOverlap={allowOverlap}
          onReset={handleResetRanges}
          scale={scale}
          setAllowOverlap={setAllowOverlap}
          setScale={setScale}
          totalFiles={totalFiles}
          totalLinesSelected={totalLinesSelected}
        />

        <div className="scrollbar-thin flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex max-w-[1600px] flex-col gap-6">
            {groupingConfig === 'none' ? (
              <div
                className="grid items-start gap-6"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}
              >
                {ungroupedFiles.map((file) => (
                  <Minimap
                    file={file}
                    getGlobalIndex={getGlobalIndex}
                    isSelected={previewSelections.has(file.compositeKey)}
                    key={file.id}
                    onInteractionStart={() => {}}
                    onMoveRange={handleMoveRange}
                    onToggleRange={handleToggleRange}
                    onToggleSelection={onToggleSelection}
                    scale={scale}
                    smartStart={startDrag}
                  />
                ))}
              </div>
            ) : (
              groupedSections.map((section) => (
                <div className="flex flex-col gap-4" key={String(section.group.groupKey)}>
                  {section.showHeader && (
                    <TapestryGroupHeader
                      group={section.group}
                      isCollapsed={section.isCollapsed}
                      isFullySelected={isGroupFullySelected(section.group)}
                      isPartiallySelected={isGroupPartiallySelected(section.group)}
                      onSelectionChange={(selected) =>
                        selected
                          ? onGroupSelectAll(section.group)
                          : onGroupDeselectAll(section.group)
                      }
                      onToggleCollapse={() => onToggleGroupCollapse(section.group.groupKey)}
                    />
                  )}
                  {!section.isCollapsed && section.items.length > 0 && (
                    <div
                      className="grid items-start gap-6"
                      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}
                    >
                      {section.items.map((file) => (
                        <Minimap
                          file={file}
                          getGlobalIndex={getGlobalIndex}
                          isSelected={previewSelections.has(file.compositeKey)}
                          key={file.id}
                          onInteractionStart={() => {}}
                          onMoveRange={handleMoveRange}
                          onToggleRange={handleToggleRange}
                          onToggleSelection={onToggleSelection}
                          scale={scale}
                          smartStart={startDrag}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <TablePagination
          currentPage={pagination.currentPage}
          onPageChange={pagination.onPageChange}
          totalItems={pagination.totalItems}
          totalPages={pagination.totalPages}
          {...paginationInfo}
        />

        <div className="flex justify-end gap-4 border-border border-t bg-muted/20 p-2 text-[10px] text-muted-foreground">
          <span>Hold drag to resize</span>
          <span>Click headers to toggle</span>
          <span>Drag body to move</span>
        </div>
      </div>
    </TooltipProvider>
  );
});

TapestryView.displayName = 'TapestryView';
