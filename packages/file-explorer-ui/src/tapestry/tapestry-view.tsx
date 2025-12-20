import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Minimap } from './minimap';
import { TapestryControls } from './tapestry-controls';
import type { DragState, FileTapestry, InteractionMode, TapestryRange } from './types';
import { generateColor, generateMockFiles } from './utils';

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

/**
 * Custom hook to handle tapestry drag and drop logic.
 */
function useTapestryDrag(
  files: FileTapestry[],
  setFiles: React.Dispatch<React.SetStateAction<FileTapestry[]>>,
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

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (
        dragState.mode === 'IDLE' ||
        !dragState.fileId ||
        !dragState.rangeId ||
        !dragState.initialRange
      ) {
        return;
      }

      const { fileId, rangeId, startY, initialRange, mode } = dragState;
      const deltaLines = Math.round((e.clientY - startY) / scale);

      setFiles((prev) =>
        prev.map((f) => {
          if (f.id !== fileId) {
            return f;
          }

          const newSelections = f.selections.map((range) => {
            if (range.id !== rangeId) {
              return range;
            }

            const otherRanges = f.selections.filter((r) => r.id !== rangeId);
            const newBounds = calculateNewRange(
              range,
              initialRange,
              mode,
              deltaLines,
              f.totalLines,
              allowOverlap,
              otherRanges
            );

            return { ...range, ...newBounds };
          });

          return { ...f, selections: newSelections };
        })
      );
    },
    [dragState, scale, allowOverlap, setFiles]
  );

  const handleMouseUp = useCallback(() => {
    setDragState({ mode: 'IDLE', fileId: null, rangeId: null, startY: 0, initialRange: null });
  }, []);

  useEffect(() => {
    if (dragState.mode !== 'IDLE') {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragState.mode, handleMouseMove, handleMouseUp]);

  const startDrag = useCallback(
    (
      mode: InteractionMode,
      fileId: string,
      rangeId: string | null,
      clientY: number,
      initialRange?: TapestryRange,
      clickedLine?: number
    ) => {
      if (mode === 'CREATING' && clickedLine !== undefined) {
        if (!allowOverlap) {
          const file = files.find((f) => f.id === fileId);
          if (file?.selections.some((s) => clickedLine >= s.startLine && clickedLine < s.endLine)) {
            return;
          }
        }

        const newId = crypto.randomUUID();
        const newRange: TapestryRange = {
          id: newId,
          startLine: clickedLine,
          endLine: clickedLine + 1,
          isActive: true,
          color: generateColor(Math.floor(Math.random() * 10)),
        };

        setFiles((prev) =>
          prev.map((f) => (f.id === fileId ? { ...f, selections: [...f.selections, newRange] } : f))
        );
        setDragState({
          mode: 'RESIZING_BOTTOM',
          fileId,
          rangeId: newId,
          startY: clientY,
          initialRange: newRange,
        });
      } else {
        setDragState({
          mode,
          fileId,
          rangeId,
          startY: clientY,
          initialRange: initialRange || null,
        });
      }
    },
    [allowOverlap, files, setFiles]
  );

  return { startDrag };
}

export const TapestryView = memo(() => {
  const [files, setFiles] = useState<FileTapestry[]>([]);
  const [scale, setScale] = useState(4);
  const [allowOverlap, setAllowOverlap] = useState(false);

  const { startDrag } = useTapestryDrag(files, setFiles, scale, allowOverlap);

  useEffect(() => {
    setFiles(generateMockFiles(12));
  }, []);

  const regenerate = useCallback(() => {
    setFiles(generateMockFiles(12));
  }, []);

  const rangeIdToIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    let count = 1;
    for (const f of files) {
      const sorted = [...f.selections].sort((a, b) => a.startLine - b.startLine);
      for (const s of sorted) {
        if (s.isActive) {
          map.set(s.id, count++);
        }
      }
    }
    return map;
  }, [files]);

  const getGlobalIndex = useCallback(
    (rangeId: string) => rangeIdToIndexMap.get(rangeId) || 0,
    [rangeIdToIndexMap]
  );

  const handleToggleRange = useCallback((fileId: string, rangeId: string) => {
    setFiles((prev) =>
      prev.map((f) =>
        f.id === fileId
          ? {
              ...f,
              selections: f.selections.map((s) =>
                s.id === rangeId ? { ...s, isActive: !s.isActive } : s
              ),
            }
          : f
      )
    );
  }, []);

  const activeRangesCount = useMemo(
    () => files.reduce((acc, f) => acc + f.selections.filter((s) => s.isActive).length, 0),
    [files]
  );
  const totalLinesSelected = useMemo(
    () =>
      files.reduce(
        (acc, f) =>
          acc +
          f.selections
            .filter((s) => s.isActive)
            .reduce((sum, s) => sum + (s.endLine - s.startLine), 0),
        0
      ),
    [files]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <TapestryControls
        activeRanges={activeRangesCount}
        allowOverlap={allowOverlap}
        onReset={regenerate}
        scale={scale}
        setAllowOverlap={setAllowOverlap}
        setScale={setScale}
        totalFiles={files.length}
        totalLinesSelected={totalLinesSelected}
      />

      <div className="scrollbar-thin flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-[1600px]">
          <div
            className="grid items-start gap-6"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}
          >
            {files.map((file) => (
              <Minimap
                file={file}
                getGlobalIndex={getGlobalIndex}
                key={file.id}
                onInteractionStart={() => {}}
                onToggleRange={handleToggleRange}
                scale={scale}
                smartStart={startDrag}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-4 border-border border-t bg-muted/20 p-2 text-[10px] text-muted-foreground">
        <span>Hold drag to resize</span>
        <span>Click headers to toggle</span>
        <span>Drag body to move</span>
      </div>
    </div>
  );
});

TapestryView.displayName = 'TapestryView';
