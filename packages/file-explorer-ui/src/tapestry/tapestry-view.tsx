import { Checkbox, EmptyState, TablePagination, TooltipProvider } from '@brainstrike/ui';
import { ChevronDown, ChevronRight, FileX2 } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatTokenCount } from '../preview/use-preview-panel-state';
import type { GroupedData, GroupKey, TableRowData } from '../utils/grouping-configs';
import { formatPreviewFileSize } from '../utils/preview-formatters';
import { Minimap } from './minimap';
import { TapestryControls } from './tapestry-controls';
import type { DragState, FileTapestry, InteractionMode, TapestryRange } from './types';
import { createRangeId, generateColor, getTapestryRenderMetrics } from './utils';

const EMPTY_STATE_ICON = <FileX2 />;

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
    return { endLine: start + rangeHeight, startLine: start };
  }
  if (mode === 'RESIZING_TOP') {
    let start = initialRange.startLine + deltaLines;
    if (start >= currentEnd - 1) {
      start = currentEnd - 1;
    }
    return { endLine: currentEnd, startLine: start };
  }
  if (mode === 'RESIZING_BOTTOM') {
    let end = initialRange.endLine + deltaLines;
    const start = initialRange.startLine;
    if (end <= start + 1) {
      end = start + 1;
    }
    return { endLine: end, startLine: start };
  }
  return { endLine: initialRange.endLine, startLine: initialRange.startLine };
}

/**
 * Constrains range boundaries to prevent overlap with other ranges.
 */
function findNeighborBounds(
  initialRange: TapestryRange,
  totalLines: number,
  otherRanges: TapestryRange[]
): { minLine: number; maxLine: number } {
  let prevEnd = 0;
  let nextStart = totalLines;

  for (const range of otherRanges) {
    if (range.endLine <= initialRange.startLine) {
      prevEnd = Math.max(prevEnd, range.endLine);
      continue;
    }
    if (range.startLine >= initialRange.endLine) {
      nextStart = Math.min(nextStart, range.startLine);
    }
  }

  return { maxLine: nextStart, minLine: prevEnd };
}

function clampMoveBounds(
  bounds: { startLine: number; endLine: number },
  minLine: number,
  maxLine: number
): { startLine: number; endLine: number } {
  let { startLine, endLine } = bounds;
  const height = endLine - startLine;

  if (startLine < minLine) {
    startLine = minLine;
    endLine = startLine + height;
  }
  if (endLine > maxLine) {
    endLine = maxLine;
    startLine = endLine - height;
  }

  return { endLine, startLine };
}

function clampResizeBounds(
  bounds: { startLine: number; endLine: number },
  mode: InteractionMode,
  minLine: number,
  maxLine: number
): { startLine: number; endLine: number } {
  let { startLine, endLine } = bounds;

  if (mode === 'RESIZING_TOP' && startLine < minLine) {
    startLine = minLine;
  }
  if (mode === 'RESIZING_BOTTOM' && endLine > maxLine) {
    endLine = maxLine;
  }

  return { endLine, startLine };
}

function applyOverlapConstraints(
  bounds: { startLine: number; endLine: number },
  initialRange: TapestryRange,
  mode: InteractionMode,
  totalLines: number,
  otherRanges: TapestryRange[]
): { startLine: number; endLine: number } {
  const { minLine, maxLine } = findNeighborBounds(initialRange, totalLines, otherRanges);

  if (mode === 'MOVING') {
    return clampMoveBounds(bounds, minLine, maxLine);
  }

  return clampResizeBounds(bounds, mode, minLine, maxLine);
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

  return { endLine, startLine };
}

interface TapestrySection {
  group: GroupedData<TableRowData>;
  isCollapsed: boolean;
  items: FileTapestry[];
  showHeader: boolean;
}

interface TapestryViewProps {
  activeRangesCount: number;
  groupedSections: TapestrySection[];
  groupingConfig: string;
  isAllSelected: (items: TableRowData[]) => boolean;
  isEmpty: boolean;
  isGroupFullySelected: (group: GroupedData<TableRowData>) => boolean;
  isGroupPartiallySelected: (group: GroupedData<TableRowData>) => boolean;
  onDeselectAll: () => void;
  onGroupDeselectAll: (group: GroupedData<TableRowData>) => void;
  onGroupSelectAll: (group: GroupedData<TableRowData>) => void;
  onRangesChange: (fileId: string, ranges: TapestryRange[]) => void;
  onRequestFileContent?: (compositeKey: string) => void;
  onResetRanges: (fileIds: string[]) => void;
  onSelectAllOnPage: (items: TableRowData[]) => void;
  onToggleGroupCollapse: (groupKey: GroupKey) => void;
  onToggleSelection: (compositeKey: string, checked: boolean) => void;
  pagination: {
    currentPage: number;
    totalPages: number;
    totalItems: number;
    onPageChange: (page: number) => void;
    pageInfo?: string;
    pageSize?: number;
  };
  previewSelections: Set<string>;
  showSelectionControls: boolean;
  totalFiles: number;
  totalLinesSelected: number;
  ungroupedFiles: FileTapestry[];
  visibleFilesOnPage: TableRowData[];
}

const TapestryGroupHeader = memo<{
  group: GroupedData<TableRowData>;
  isCollapsed: boolean;
  isFullySelected: boolean;
  isPartiallySelected: boolean;
  showSelectionControls: boolean;
  onToggleGroupCollapse: (groupKey: GroupKey) => void;
  onGroupSelectAll: (group: GroupedData<TableRowData>) => void;
  onGroupDeselectAll: (group: GroupedData<TableRowData>) => void;
}>(
  ({
    group,
    isCollapsed,
    isFullySelected,
    isPartiallySelected,
    showSelectionControls,
    onToggleGroupCollapse,
    onGroupSelectAll,
    onGroupDeselectAll,
  }) => {
    const checkboxState = isPartiallySelected ? 'indeterminate' : isFullySelected;

    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm shadow-xs">
        {showSelectionControls ? (
          <Checkbox
            aria-label={`Select all items in group ${group.groupLabel}`}
            checked={checkboxState}
            onCheckedChange={(checked) => {
              if (typeof checked === 'boolean') {
                if (checked) {
                  onGroupSelectAll(group);
                } else {
                  onGroupDeselectAll(group);
                }
              }
            }}
            onClick={(event) => event.stopPropagation()}
          />
        ) : null}
        <button
          aria-expanded={!isCollapsed}
          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} group ${group.groupLabel}`}
          className="flex flex-1 items-center gap-2 text-left font-medium text-foreground text-sm transition-colors hover:text-primary"
          onClick={() => onToggleGroupCollapse(group.groupKey)}
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
 * Computes range bounds when the user drags upward from the anchor point
 * during range creation.
 */
function computeUpwardCreationBounds(
  anchorLine: number,
  deltaLines: number,
  totalLines: number,
  initialRange: TapestryRange,
  otherRanges: TapestryRange[],
  allowOverlap: boolean
): { startLine: number; endLine: number } {
  let startLine = anchorLine + deltaLines;
  let endLine = anchorLine + 1;

  if (startLine < 0) {
    startLine = 0;
  }
  if (endLine > totalLines) {
    endLine = totalLines;
  }

  if (!allowOverlap && otherRanges.length > 0) {
    const { minLine } = findNeighborBounds(initialRange, totalLines, otherRanges);
    if (startLine < minLine) {
      startLine = minLine;
    }
  }

  return { endLine, startLine };
}

const IDLE_DRAG_STATE: DragState = {
  anchorLine: undefined,
  fileId: null,
  initialRange: null,
  initialTotalLines: 0,
  mode: 'IDLE',
  rangeId: null,
  startY: 0,
};

/**
 * Custom hook to handle tapestry drag and drop logic.
 *
 * Uses useRef for drag state and requestAnimationFrame throttling to avoid
 * re-renders on every mousemove. Only `isDragging` (boolean useState) triggers
 * re-renders — for attaching/detaching window listeners and disabling CSS transitions.
 */
function useTapestryDrag(
  files: FileTapestry[],
  onRangesChange: (fileId: string, ranges: TapestryRange[]) => void,
  scale: number,
  allowOverlap: boolean
) {
  const dragStateRef = useRef<DragState>({ ...IDLE_DRAG_STATE });
  const [isDragging, setIsDragging] = useState(false);
  const rafIdRef = useRef<number>(0);
  const activePointerIdRef = useRef<number | null>(null);
  const latestClientYRef = useRef<number>(0);

  // Always-fresh ref avoids stale closures when mouse events fire between renders.
  const filesRef = useRef(files);
  filesRef.current = files;

  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const allowOverlapRef = useRef(allowOverlap);
  allowOverlapRef.current = allowOverlap;

  const updateRanges = useCallback(
    (fileId: string, updater: (ranges: TapestryRange[]) => TapestryRange[]) => {
      const file = filesRef.current.find((entry) => entry.id === fileId);
      if (!file) {
        return;
      }
      onRangesChange(fileId, updater(file.selections));
    },
    [onRangesChange]
  );

  const resetDragState = useCallback(() => {
    dragStateRef.current = { ...IDLE_DRAG_STATE };
    setIsDragging(false);
  }, []);

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      // Ignore events from other pointers (e.g. multi-touch)
      if (activePointerIdRef.current !== null && e.pointerId !== activePointerIdRef.current) {
        return;
      }

      const ds = dragStateRef.current;
      if (
        ds.mode === 'IDLE' ||
        !ds.fileId ||
        !ds.rangeId ||
        !ds.initialRange ||
        scaleRef.current <= 0
      ) {
        return;
      }

      // Always capture the latest clientY — the rAF callback reads from this ref
      // so it uses the most recent position, not the first event that passed the gate.
      latestClientYRef.current = e.clientY;

      // rAF gate: skip if a frame is already pending
      if (rafIdRef.current !== 0) {
        return;
      }

      rafIdRef.current = requestAnimationFrame(() => {
        // Re-check drag state inside rAF (pointerUp may have fired between scheduling and execution)
        const current = dragStateRef.current;
        if (
          current.mode === 'IDLE' ||
          !current.fileId ||
          !current.rangeId ||
          !current.initialRange
        ) {
          rafIdRef.current = 0;
          return;
        }

        const file = filesRef.current.find((entry) => entry.id === current.fileId);
        if (!file) {
          rafIdRef.current = 0;
          return;
        }

        // Abort drag if totalLines changed mid-drag (e.g. content loaded).
        if (file.totalLines !== current.initialTotalLines) {
          rafIdRef.current = 0;
          resetDragState();
          return;
        }

        const { fileId, rangeId, startY, initialRange, mode } = current;
        const { lineScale } = getTapestryRenderMetrics(file.totalLines, scaleRef.current);
        const deltaLines = Math.round((latestClientYRef.current - startY) / lineScale);

        updateRanges(fileId, (ranges) => {
          const currentRange = ranges.find((range) => range.id === rangeId) ?? initialRange;
          const otherRanges = ranges.filter((range) => range.id !== rangeId);

          // Bidirectional range creation: if dragging upward from anchor point
          const { anchorLine } = current;
          const newBounds =
            anchorLine !== undefined && mode === 'RESIZING_BOTTOM' && deltaLines < 0
              ? computeUpwardCreationBounds(
                  anchorLine,
                  deltaLines,
                  file.totalLines,
                  initialRange,
                  otherRanges,
                  allowOverlapRef.current
                )
              : calculateNewRange(
                  currentRange,
                  initialRange,
                  mode,
                  deltaLines,
                  file.totalLines,
                  allowOverlapRef.current,
                  otherRanges
                );

          return ranges.map((range) =>
            range.id === rangeId ? { ...range, ...newBounds, userModified: true } : range
          );
        });

        // Clear rAF gate after the update — this ensures strictly one update per frame.
        rafIdRef.current = 0;
      });
    },
    [resetDragState, updateRanges]
  );

  const handlePointerUp = useCallback(
    (e?: PointerEvent) => {
      // Ignore events from other pointers (e.g. multi-touch)
      if (e && activePointerIdRef.current !== null && e.pointerId !== activePointerIdRef.current) {
        return;
      }

      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = 0;
      activePointerIdRef.current = null;
      if (e) {
        try {
          document.documentElement.releasePointerCapture(e.pointerId);
        } catch {
          // Pointer capture may already be released
        }
      }
      resetDragState();
    },
    [resetDragState]
  );

  // Store latest handlers in ref to avoid recreating event listeners
  const handlersRef = useRef({ handlePointerMove, handlePointerUp });

  useEffect(() => {
    handlersRef.current = { handlePointerMove, handlePointerUp };
  }, [handlePointerMove, handlePointerUp]);

  // Cancel pending rAF on unmount
  useEffect(() => () => cancelAnimationFrame(rafIdRef.current), []);

  useEffect(() => {
    if (isDragging) {
      const moveHandler = (e: PointerEvent) => handlersRef.current.handlePointerMove(e);
      const upHandler = (e: PointerEvent) => handlersRef.current.handlePointerUp(e);

      window.addEventListener('pointermove', moveHandler);
      window.addEventListener('pointerup', upHandler);

      return () => {
        window.removeEventListener('pointermove', moveHandler);
        window.removeEventListener('pointerup', upHandler);
      };
    }
    return;
  }, [isDragging]);

  const startDrag = useCallback(
    (
      mode: InteractionMode,
      fileId: string,
      rangeId: string | null,
      clientY: number,
      initialRange?: TapestryRange,
      clickedLine?: number,
      pointerId?: number
    ) => {
      const file = filesRef.current.find((entry) => entry.id === fileId);
      if (!file) {
        return;
      }

      if (mode === 'CREATING' && clickedLine !== undefined) {
        if (
          !allowOverlapRef.current &&
          file.selections.some((s) => clickedLine >= s.startLine && clickedLine < s.endLine)
        ) {
          return;
        }

        const newId = createRangeId();
        const newRange: TapestryRange = {
          color: generateColor(file.selections.length),
          endLine: clickedLine + 1,
          id: newId,
          isActive: true,
          startLine: clickedLine,
          userModified: true,
        };

        updateRanges(fileId, (ranges) => [...ranges, newRange]);
        dragStateRef.current = {
          anchorLine: clickedLine,
          fileId,
          initialRange: newRange,
          initialTotalLines: file.totalLines,
          mode: 'RESIZING_BOTTOM',
          rangeId: newId,
          startY: clientY,
        };
        setIsDragging(true);
      } else {
        const resolvedRange =
          initialRange ?? file.selections.find((range) => range.id === rangeId) ?? null;
        dragStateRef.current = {
          anchorLine: undefined,
          fileId,
          initialRange: resolvedRange,
          initialTotalLines: file.totalLines,
          mode,
          rangeId,
          startY: clientY,
        };
        setIsDragging(true);
      }

      // Record active pointer and capture for reliable tracking across window boundaries
      if (pointerId !== undefined) {
        activePointerIdRef.current = pointerId;
        try {
          document.documentElement.setPointerCapture(pointerId);
        } catch {
          // Pointer capture may not be supported in all environments
        }
      }
    },
    [updateRanges]
  );

  return { isDragging, startDrag };
}

export const TapestryView = memo<TapestryViewProps>(function TapestryView({
  ungroupedFiles,
  groupedSections,
  groupingConfig,
  onToggleGroupCollapse,
  onGroupSelectAll,
  onGroupDeselectAll,
  isGroupFullySelected,
  isGroupPartiallySelected,
  previewSelections,
  onToggleSelection,
  onRequestFileContent,
  visibleFilesOnPage,
  onSelectAllOnPage,
  onDeselectAll,
  isAllSelected,
  totalFiles,
  isEmpty,
  onRangesChange,
  onResetRanges,
  activeRangesCount,
  totalLinesSelected,
  pagination,
  showSelectionControls,
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

  const filesRef = useRef(files);
  filesRef.current = files;

  const { startDrag, isDragging } = useTapestryDrag(files, onRangesChange, scale, allowOverlap);

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
      const file = filesRef.current.find((entry) => entry.id === fileId);
      if (!file) {
        return;
      }
      onRangesChange(fileId, updater(file.selections));
    },
    [onRangesChange]
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
          range.id === rangeId
            ? { ...range, endLine: newEndLine, startLine: newStartLine, userModified: true }
            : range
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
          icon={EMPTY_STATE_ICON}
          title="No matching files"
        />
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
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
            {showSelectionControls ? (
              <div className="flex justify-end">
                <div className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1 text-xs shadow-xs">
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
              </div>
            ) : null}
            {groupingConfig === 'none' ? (
              <div
                className="grid items-start gap-6"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
              >
                {ungroupedFiles.map((file) => (
                  <Minimap
                    allowOverlap={allowOverlap}
                    file={file}
                    getGlobalIndex={getGlobalIndex}
                    isDragging={isDragging}
                    isSelected={previewSelections.has(file.compositeKey)}
                    key={file.id}
                    onMoveRange={handleMoveRange}
                    onToggleRange={handleToggleRange}
                    onToggleSelection={onToggleSelection}
                    scale={scale}
                    showSelectionControls={showSelectionControls}
                    smartStart={startDrag}
                    {...(onRequestFileContent ? { onRequestFileContent } : {})}
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
                      onGroupDeselectAll={onGroupDeselectAll}
                      onGroupSelectAll={onGroupSelectAll}
                      onToggleGroupCollapse={onToggleGroupCollapse}
                      showSelectionControls={showSelectionControls}
                    />
                  )}
                  {!section.isCollapsed && section.items.length > 0 && (
                    <div
                      className="grid items-start gap-6"
                      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
                    >
                      {section.items.map((file) => (
                        <Minimap
                          allowOverlap={allowOverlap}
                          file={file}
                          getGlobalIndex={getGlobalIndex}
                          isDragging={isDragging}
                          isSelected={previewSelections.has(file.compositeKey)}
                          key={file.id}
                          onMoveRange={handleMoveRange}
                          onToggleRange={handleToggleRange}
                          onToggleSelection={onToggleSelection}
                          scale={scale}
                          showSelectionControls={showSelectionControls}
                          smartStart={startDrag}
                          {...(onRequestFileContent ? { onRequestFileContent } : {})}
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
          {...(pagination.pageSize === undefined ? {} : { pageSize: pagination.pageSize })}
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
