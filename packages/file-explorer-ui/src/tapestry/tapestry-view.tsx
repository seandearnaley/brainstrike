import {
  Checkbox,
  cn,
  EmptyState,
  SELECTION_BAR_SCROLL_PADDING,
  TablePagination,
  TooltipProvider,
} from '@brainstrike/ui';
import { ChevronDown, ChevronRight, FileX2 } from 'lucide-react';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatTokenCount } from '../preview/use-preview-panel-state';
import type { GroupedData, GroupKey, TableRowData } from '../utils/grouping-configs';
import { formatPreviewFileSize } from '../utils/preview-formatters';
import { Minimap } from './minimap';
import { TapestryControls } from './tapestry-controls';
import type { DragState, FileTapestry, InteractionMode, TapestryRange } from './types';
import {
  createRangeId,
  generateColor,
  getTapestryGalleryMetrics,
  getTapestryRenderMetrics,
} from './utils';

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

/** In-flight drag state rendered locally; committed to the store on drag end. */
interface TapestryDragDraft {
  fileId: string;
  ranges: TapestryRange[];
}

function applyDragDraftToFiles(
  files: FileTapestry[],
  draft: TapestryDragDraft | null
): FileTapestry[] {
  if (!(draft && files.some((file) => file.id === draft.fileId))) {
    return files;
  }
  // Only the dragged file gets a new object — every other card keeps identity
  // so its memo bails out during drag frames.
  return files.map((file) =>
    file.id === draft.fileId ? { ...file, selections: draft.ranges } : file
  );
}

function applyDragDraftToSections(
  sections: TapestrySection[],
  draft: TapestryDragDraft | null
): TapestrySection[] {
  if (!draft) {
    return sections;
  }
  let changed = false;
  const next = sections.map((section) => {
    const items = applyDragDraftToFiles(section.items, draft);
    if (items === section.items) {
      return section;
    }
    changed = true;
    return { ...section, items };
  });
  return changed ? next : sections;
}

interface TapestryViewProps {
  activeRangesCount: number;
  groupedSections: TapestrySection[];
  groupingConfig: string;
  isAllSelected: (items: TableRowData[]) => boolean;
  isEmpty: boolean;
  isGroupFullySelected: (group: GroupedData<TableRowData>) => boolean;
  isGroupPartiallySelected: (group: GroupedData<TableRowData>) => boolean;
  /** BST-1990: asks the selected thread to add a card's folder. */
  onAddToThread?: (file: FileTapestry) => void;
  onDeselectAll: () => void;
  onGroupDeselectAll: (group: GroupedData<TableRowData>) => void;
  onGroupingChange: (value: string) => void;
  onGroupSelectAll: (group: GroupedData<TableRowData>) => void;
  onRangesChange: (fileId: string, ranges: TapestryRange[]) => void;
  onRequestFileContent?: (compositeKey: string) => void;
  onResetRanges: (fileIds: string[]) => void;
  onScaleChange: (scale: number) => void;
  onSelectAllOnPage: (items: TableRowData[]) => void;
  onSelectionControlsToggle: (enabled: boolean) => void;
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
  scale: number;
  /**
   * Floating bulk-action bar for the current multi-selection, owned by the
   * preview panel (it holds the selection actions) but rendered here so it
   * overlays the gallery scrollport and clears the pagination bar. Inherited
   * from the retired Table View, which hosted the same overlay (BST-1211).
   */
  selectionActionBar?: ReactNode;
  showSelectionControls: boolean;
  totalFiles: number;
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
      <div
        className="@container flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/40 px-2 py-2 text-sm shadow-xs"
        data-testid="tapestry-group-header"
      >
        {showSelectionControls ? (
          <Checkbox
            aria-label={`Select all items in group ${group.groupLabel}`}
            checked={checkboxState}
            className="size-6"
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
          className="flex min-w-0 flex-1 items-center gap-2 text-left font-medium text-foreground text-sm transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onToggleGroupCollapse(group.groupKey)}
          type="button"
        >
          {isCollapsed ? (
            <ChevronRight className="size-4 shrink-0" />
          ) : (
            <ChevronDown className="size-4 shrink-0" />
          )}
          <span className="min-w-0 truncate">{group.groupLabel}</span>
          <div className="ml-auto flex shrink-0 items-center gap-3 text-muted-foreground text-xs">
            <span className="@max-[280px]:hidden">{group.count} files</span>
            <span
              className="@max-[360px]:hidden font-mono tabular-nums"
              data-testid="tapestry-group-token-count"
            >
              {formatTokenCount(group.totalTokens)}
            </span>
            <span
              className="@max-[440px]:hidden font-mono tabular-nums"
              data-testid="tapestry-group-size"
            >
              {formatPreviewFileSize(group.totalSize)}
            </span>
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
  allowOverlap: boolean,
  onPreviewRanges: (draft: TapestryDragDraft | null) => void
) {
  const dragStateRef = useRef<DragState>({ ...IDLE_DRAG_STATE });
  const [isDragging, setIsDragging] = useState(false);
  const rafIdRef = useRef<number>(0);
  const activePointerIdRef = useRef<number | null>(null);
  const latestClientYRef = useRef<number>(0);
  // Per-frame drag output. Rendered via onPreviewRanges (local state in
  // TapestryView) and committed to the store ONCE on drag end — per-frame
  // store writes re-rendered the whole PreviewPanel at pointer-move cadence.
  const draftRef = useRef<TapestryDragDraft | null>(null);

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

  const discardDraft = useCallback(() => {
    if (draftRef.current !== null) {
      draftRef.current = null;
      onPreviewRanges(null);
    }
  }, [onPreviewRanges]);

  const commitDraft = useCallback(() => {
    const draft = draftRef.current;
    draftRef.current = null;
    if (draft) {
      onRangesChange(draft.fileId, draft.ranges);
    }
    onPreviewRanges(null);
  }, [onRangesChange, onPreviewRanges]);

  const resetDragState = useCallback(() => {
    // Safety net: any surviving draft at reset is DISCARDED (e.g. the
    // totalLines-changed mid-drag abort). Commit paths call commitDraft first.
    discardDraft();
    dragStateRef.current = { ...IDLE_DRAG_STATE };
    setIsDragging(false);
  }, [discardDraft]);

  const cancelScheduledFrame = useCallback((): boolean => {
    if (rafIdRef.current === 0) {
      return false;
    }
    cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = 0;
    return true;
  }, []);

  const releaseActivePointer = useCallback((pointerId?: number) => {
    const activePointerId = activePointerIdRef.current;
    activePointerIdRef.current = null;
    const releasePointerId = pointerId ?? activePointerId;
    if (releasePointerId === null || releasePointerId === undefined) {
      return;
    }
    try {
      document.documentElement.releasePointerCapture(releasePointerId);
    } catch {
      // Pointer capture may already be released.
    }
  }, []);

  const rollbackDrag = useCallback(() => {
    const current = dragStateRef.current;
    if (current.mode === 'IDLE' || !current.fileId || !current.rangeId || !current.initialRange) {
      return;
    }

    // Move/resize drags never touched the store (frames render from the
    // draft), so discarding the draft fully restores the pre-drag state. A
    // CREATING drag committed its new range on pointer-down — remove it.
    discardDraft();
    const { anchorLine, fileId, rangeId } = current;
    if (anchorLine !== undefined) {
      updateRanges(fileId, (ranges) => ranges.filter((range) => range.id !== rangeId));
    }
  }, [discardDraft, updateRanges]);

  const applyLatestDragPosition = useCallback(() => {
    // Clear the gate before applying so a synchronous state update cannot leave
    // the drag loop looking as though a stale frame is still pending.
    rafIdRef.current = 0;
    const current = dragStateRef.current;
    if (current.mode === 'IDLE' || !current.fileId || !current.rangeId || !current.initialRange) {
      return;
    }

    const file = filesRef.current.find((entry) => entry.id === current.fileId);
    if (!file) {
      return;
    }

    // Abort drag if totalLines changed mid-drag (e.g. content loaded).
    if (file.totalLines !== current.initialTotalLines) {
      resetDragState();
      return;
    }

    const { fileId, rangeId, startY, initialRange, mode } = current;
    const { lineScale } = getTapestryRenderMetrics(file.totalLines, scaleRef.current);
    const deltaLines = Math.round((latestClientYRef.current - startY) / lineScale);

    // Frames write to the local draft (rendered by TapestryView), NOT the
    // store — the store sees one commit on drag end. `file.selections` comes
    // from the drafted files, so overlap constraints see the live positions.
    const ranges = file.selections;
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

    draftRef.current = {
      fileId,
      ranges: ranges.map((range) =>
        range.id === rangeId ? { ...range, ...newBounds, userModified: true } : range
      ),
    };
    onPreviewRanges(draftRef.current);
  }, [onPreviewRanges, resetDragState]);

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

      rafIdRef.current = requestAnimationFrame(applyLatestDragPosition);
    },
    [applyLatestDragPosition]
  );

  const handlePointerUp = useCallback(
    (e: PointerEvent) => {
      // Ignore events from other pointers (e.g. multi-touch)
      if (activePointerIdRef.current !== null && e.pointerId !== activePointerIdRef.current) {
        return;
      }

      cancelScheduledFrame();
      latestClientYRef.current = e.clientY;
      applyLatestDragPosition();
      commitDraft();
      releaseActivePointer(e.pointerId);
      resetDragState();
    },
    [
      applyLatestDragPosition,
      cancelScheduledFrame,
      commitDraft,
      releaseActivePointer,
      resetDragState,
    ]
  );

  const handlePointerCancel = useCallback(
    (e: PointerEvent) => {
      if (activePointerIdRef.current !== null && e.pointerId !== activePointerIdRef.current) {
        return;
      }

      cancelScheduledFrame();
      rollbackDrag();
      releaseActivePointer(e.pointerId);
      resetDragState();
    },
    [cancelScheduledFrame, releaseActivePointer, resetDragState, rollbackDrag]
  );

  const handleWindowBlur = useCallback(() => {
    if (cancelScheduledFrame()) {
      applyLatestDragPosition();
    }
    commitDraft();
    releaseActivePointer();
    resetDragState();
  }, [
    applyLatestDragPosition,
    cancelScheduledFrame,
    commitDraft,
    releaseActivePointer,
    resetDragState,
  ]);

  // Store latest handlers in ref to avoid recreating event listeners
  const handlersRef = useRef({
    handlePointerCancel,
    handlePointerMove,
    handlePointerUp,
    handleWindowBlur,
  });

  useEffect(() => {
    handlersRef.current = {
      handlePointerCancel,
      handlePointerMove,
      handlePointerUp,
      handleWindowBlur,
    };
  }, [handlePointerCancel, handlePointerMove, handlePointerUp, handleWindowBlur]);

  // Cancel pending rAF on unmount
  useEffect(() => () => cancelAnimationFrame(rafIdRef.current), []);

  useEffect(() => {
    if (isDragging) {
      const moveHandler = (e: PointerEvent) => handlersRef.current.handlePointerMove(e);
      const upHandler = (e: PointerEvent) => handlersRef.current.handlePointerUp(e);
      const cancelHandler = (e: PointerEvent) => handlersRef.current.handlePointerCancel(e);
      const blurHandler = () => handlersRef.current.handleWindowBlur();

      window.addEventListener('pointermove', moveHandler);
      window.addEventListener('pointerup', upHandler);
      window.addEventListener('pointercancel', cancelHandler);
      window.addEventListener('blur', blurHandler);

      return () => {
        window.removeEventListener('pointermove', moveHandler);
        window.removeEventListener('pointerup', upHandler);
        window.removeEventListener('pointercancel', cancelHandler);
        window.removeEventListener('blur', blurHandler);
      };
    }
    return;
  }, [isDragging]);

  const createRange = useCallback(
    (fileId: string, clickedLine: number): TapestryRange | null => {
      const file = filesRef.current.find((entry) => entry.id === fileId);
      if (file?.contentStatus !== 'ready' || file.totalLines <= 0) {
        return null;
      }

      const line = Math.min(Math.max(clickedLine, 0), file.totalLines - 1);
      if (
        !allowOverlapRef.current &&
        file.selections.some((range) => line >= range.startLine && line < range.endLine)
      ) {
        return null;
      }

      const newRange: TapestryRange = {
        color: generateColor(file.selections.length),
        endLine: line + 1,
        id: createRangeId(),
        isActive: true,
        startLine: line,
        userModified: true,
      };
      updateRanges(fileId, (ranges) => [...ranges, newRange]);
      return newRange;
    },
    [updateRanges]
  );

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
        const newRange = createRange(fileId, clickedLine);
        if (!newRange) {
          return;
        }
        dragStateRef.current = {
          anchorLine: newRange.startLine,
          fileId,
          initialRange: newRange,
          initialTotalLines: file.totalLines,
          mode: 'RESIZING_BOTTOM',
          rangeId: newRange.id,
          startY: clientY,
        };
        setIsDragging(true);
      } else {
        const resolvedRange =
          initialRange ?? file.selections.find((range) => range.id === rangeId) ?? null;
        if (!resolvedRange || resolvedRange.origin === 'search') {
          return;
        }
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
    [createRange]
  );

  return { createRange, isDragging, startDrag };
}

export const TapestryView = memo<TapestryViewProps>(function TapestryView({
  ungroupedFiles: ungroupedFilesProp,
  groupedSections: groupedSectionsProp,
  groupingConfig,
  onToggleGroupCollapse,
  onGroupSelectAll,
  onGroupDeselectAll,
  onGroupingChange,
  isGroupFullySelected,
  isGroupPartiallySelected,
  previewSelections,
  onToggleSelection,
  onRequestFileContent,
  onAddToThread,
  visibleFilesOnPage,
  onSelectAllOnPage,
  onDeselectAll,
  isAllSelected,
  totalFiles,
  isEmpty,
  onRangesChange,
  onResetRanges,
  onScaleChange,
  activeRangesCount,
  pagination,
  selectionActionBar,
  showSelectionControls,
  onSelectionControlsToggle,
  scale,
}) {
  const [allowOverlap, setAllowOverlap] = useState(false);
  const [activePinnedLensFileId, setActivePinnedLensFileId] = useState<string | null>(null);
  const [lensEnabled, setLensEnabled] = useState(true);
  const handleLensEnabledChange = useCallback((enabled: boolean) => {
    setLensEnabled(enabled);
  }, []);

  // Drag draft: per-frame range updates render from this LOCAL state (only
  // the dragged file's object is patched, so other cards' memos bail); the
  // workspace-context store sees one onRangesChange commit at drag end.
  const [dragDraft, setDragDraft] = useState<TapestryDragDraft | null>(null);
  const ungroupedFiles = useMemo(
    () => applyDragDraftToFiles(ungroupedFilesProp, dragDraft),
    [ungroupedFilesProp, dragDraft]
  );
  const groupedSections = useMemo(
    () => applyDragDraftToSections(groupedSectionsProp, dragDraft),
    [groupedSectionsProp, dragDraft]
  );

  const files = useMemo(
    () =>
      groupingConfig === 'none'
        ? ungroupedFiles
        : groupedSections.flatMap((section) => section.items),
    [groupingConfig, groupedSections, ungroupedFiles]
  );

  const filesRef = useRef(files);
  filesRef.current = files;

  const galleryMetrics = useMemo(() => getTapestryGalleryMetrics(scale), [scale]);
  const { createRange, startDrag, isDragging } = useTapestryDrag(
    files,
    onRangesChange,
    galleryMetrics.lineDensity,
    allowOverlap,
    setDragDraft
  );

  const rangeIdToIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    let count = 1;
    for (const file of files) {
      const sorted = [...file.selections].sort((a, b) => a.startLine - b.startLine);
      for (const selection of sorted) {
        if (selection.isActive && selection.origin !== 'search') {
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
      const target = filesRef.current
        .find((file) => file.id === fileId)
        ?.selections.find((range) => range.id === rangeId);
      if (!target || target.origin === 'search') {
        return;
      }
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
      const target = filesRef.current
        .find((file) => file.id === fileId)
        ?.selections.find((range) => range.id === rangeId);
      if (!target || target.origin === 'search') {
        return;
      }
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

  const handleChangeRangeColor = useCallback(
    (fileId: string, rangeId: string, color: string) => {
      const target = filesRef.current
        .find((file) => file.id === fileId)
        ?.selections.find((range) => range.id === rangeId);
      if (!target || target.origin === 'search') {
        return;
      }
      updateRanges(fileId, (ranges) =>
        ranges.map((range) => (range.id === rangeId ? { ...range, color } : range))
      );
    },
    [updateRanges]
  );

  const handleRemoveRange = useCallback(
    (fileId: string, rangeId: string) => {
      const target = filesRef.current
        .find((file) => file.id === fileId)
        ?.selections.find((range) => range.id === rangeId);
      if (!target || target.origin === 'search') {
        return;
      }
      updateRanges(fileId, (ranges) => ranges.filter((range) => range.id !== rangeId));
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

  const handleClearManualRanges = useCallback(
    (fileId: string) => onResetRanges([fileId]),
    [onResetRanges]
  );
  const handleCreateRange = useCallback(
    (fileId: string, lineIndex: number) => createRange(fileId, lineIndex) !== null,
    [createRange]
  );

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
      <div className="@container/tapestry flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
        <TapestryControls
          activeRanges={activeRangesCount}
          allowOverlap={allowOverlap}
          groupingConfig={groupingConfig}
          lensEnabled={lensEnabled}
          onGroupingChange={onGroupingChange}
          onReset={handleResetRanges}
          onSelectionControlsToggle={onSelectionControlsToggle}
          scale={scale}
          selectionControlsEnabled={showSelectionControls}
          setAllowOverlap={setAllowOverlap}
          setLensEnabled={handleLensEnabledChange}
          setScale={onScaleChange}
          totalFiles={totalFiles}
        />

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            className={cn(
              'scrollbar-thin flex-1 overflow-y-auto p-3',
              selectionActionBar && SELECTION_BAR_SCROLL_PADDING
            )}
          >
            <div className="flex w-full flex-col gap-3">
              {showSelectionControls ? (
                <div className="flex justify-end">
                  <div className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1 text-xs shadow-xs">
                    <Checkbox
                      aria-label="Select all files on current page"
                      checked={pageCheckboxState}
                      className="size-6"
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
                  className="grid items-start"
                  data-testid="tapestry-gallery"
                  style={{
                    columnGap: galleryMetrics.gap,
                    gridAutoRows: 4,
                    gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${galleryMetrics.cardMinWidth}px), 1fr))`,
                    rowGap: 4,
                  }}
                >
                  {ungroupedFiles.map((file) => (
                    <Minimap
                      activePinnedLensFileId={activePinnedLensFileId}
                      allowOverlap={allowOverlap}
                      file={file}
                      getGlobalIndex={getGlobalIndex}
                      isDragging={isDragging}
                      isSelected={previewSelections.has(file.compositeKey)}
                      key={file.id}
                      lensEnabled={lensEnabled}
                      onChangeRangeColor={handleChangeRangeColor}
                      onClearManualRanges={handleClearManualRanges}
                      onCreateRange={handleCreateRange}
                      onLensEnabledChange={handleLensEnabledChange}
                      onMoveRange={handleMoveRange}
                      onPinnedLensChange={setActivePinnedLensFileId}
                      onRemoveRange={handleRemoveRange}
                      onToggleRange={handleToggleRange}
                      onToggleSelection={onToggleSelection}
                      scale={galleryMetrics.lineDensity}
                      showSelectionControls={showSelectionControls}
                      smartStart={startDrag}
                      {...(onRequestFileContent ? { onRequestFileContent } : {})}
                      {...(onAddToThread ? { onAddToThread } : {})}
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
                        className="grid items-start"
                        data-testid="tapestry-gallery"
                        style={{
                          columnGap: galleryMetrics.gap,
                          gridAutoRows: 4,
                          gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${galleryMetrics.cardMinWidth}px), 1fr))`,
                          rowGap: 4,
                        }}
                      >
                        {section.items.map((file) => (
                          <Minimap
                            activePinnedLensFileId={activePinnedLensFileId}
                            allowOverlap={allowOverlap}
                            file={file}
                            getGlobalIndex={getGlobalIndex}
                            isDragging={isDragging}
                            isSelected={previewSelections.has(file.compositeKey)}
                            key={file.id}
                            lensEnabled={lensEnabled}
                            onChangeRangeColor={handleChangeRangeColor}
                            onClearManualRanges={handleClearManualRanges}
                            onCreateRange={handleCreateRange}
                            onLensEnabledChange={handleLensEnabledChange}
                            onMoveRange={handleMoveRange}
                            onPinnedLensChange={setActivePinnedLensFileId}
                            onRemoveRange={handleRemoveRange}
                            onToggleRange={handleToggleRange}
                            onToggleSelection={onToggleSelection}
                            scale={galleryMetrics.lineDensity}
                            showSelectionControls={showSelectionControls}
                            smartStart={startDrag}
                            {...(onRequestFileContent ? { onRequestFileContent } : {})}
                            {...(onAddToThread ? { onAddToThread } : {})}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
          {selectionActionBar}
        </div>

        <TablePagination
          currentPage={pagination.currentPage}
          onPageChange={pagination.onPageChange}
          totalItems={pagination.totalItems}
          totalPages={pagination.totalPages}
          {...paginationInfo}
          {...(pagination.pageSize === undefined ? {} : { pageSize: pagination.pageSize })}
        />
      </div>
    </TooltipProvider>
  );
});

TapestryView.displayName = 'TapestryView';
