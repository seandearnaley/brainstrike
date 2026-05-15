import { Checkbox, cn, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExtensionBadge } from '../extension-badge';
import { formatTokenCount } from '../use-preview-panel-state';
import { getRootFolderDisplayName } from '../utils/path-display';
import { formatPreviewFileSize } from '../utils/preview-formatters';
import type { FileTapestry, InteractionMode, TapestryRange } from './types';
import { getTapestryRenderMetrics } from './utils';

interface MinimapProps {
  allowOverlap?: boolean;
  file: FileTapestry;
  getGlobalIndex: (rangeId: string) => number;
  isDragging?: boolean;
  isSelected: boolean;
  onMoveRange?: (fileId: string, rangeId: string, newStartLine: number, newEndLine: number) => void;
  onRequestFileContent?: (compositeKey: string) => void;
  onToggleRange: (fileId: string, rangeId: string) => void;
  onToggleSelection: (compositeKey: string, checked: boolean) => void;
  scale: number;
  showSelectionControls?: boolean;
  smartStart: (
    mode: InteractionMode,
    fileId: string,
    rangeId: string | null,
    clientY: number,
    initialRange?: TapestryRange,
    clickedLine?: number,
    pointerId?: number
  ) => void;
}

type RangeKeyAction = { type: 'noop' } | { type: 'toggle' } | { type: 'move'; startLine: number };

interface PreviewState {
  hasPreviewLines: boolean;
  previewLines: string[];
  previewStartLine: number;
  remainingLines: number;
  showLoadingState: boolean;
  showRemainingLines: boolean;
}

const MAX_PREVIEW_LINES = 8;

const resolveRangeKeyAction = (args: {
  key: string;
  range: TapestryRange;
  totalLines: number;
}): RangeKeyAction => {
  const { key, range, totalLines } = args;
  const rangeHeight = range.endLine - range.startLine;

  switch (key) {
    case 'ArrowUp':
      return { type: 'move', startLine: Math.max(0, range.startLine - 1) };
    case 'ArrowDown':
      return { type: 'move', startLine: Math.min(totalLines - rangeHeight, range.startLine + 1) };
    case 'PageUp':
      return { type: 'move', startLine: Math.max(0, range.startLine - 10) };
    case 'PageDown':
      return {
        type: 'move',
        startLine: Math.min(totalLines - rangeHeight, range.startLine + 10),
      };
    case 'Home':
      return { type: 'move', startLine: 0 };
    case 'End':
      return { type: 'move', startLine: Math.max(0, totalLines - rangeHeight) };
    case 'Enter':
    case ' ':
      return { type: 'toggle' };
    default:
      return { type: 'noop' };
  }
};

/**
 * Clamps a keyboard-driven range move to avoid overlapping with sibling ranges.
 * Returns the adjusted startLine/endLine, or null if the move should be aborted.
 */
const clampKeyboardMove = (
  newStartLine: number,
  rangeHeight: number,
  currentStartLine: number,
  otherRanges: TapestryRange[]
): { startLine: number; endLine: number } | null => {
  let startLine = newStartLine;
  let endLine = startLine + rangeHeight;
  const movingDown = startLine > currentStartLine;

  for (const other of otherRanges) {
    if (movingDown && endLine > other.startLine && startLine < other.endLine) {
      endLine = other.startLine;
      startLine = endLine - rangeHeight;
    } else if (!movingDown && startLine < other.endLine && endLine > other.startLine) {
      startLine = other.endLine;
      endLine = startLine + rangeHeight;
    }
  }

  // Abort if still at original position after clamping
  if (startLine === currentStartLine) {
    return null;
  }

  return { startLine, endLine };
};

const buildRangePreview = (range: TapestryRange, file: FileTapestry): PreviewState => {
  const contentLength = file.content.length;
  const hasContent = file.contentStatus === 'ready' && contentLength > 0;
  const totalLines = hasContent ? contentLength : file.totalLines;
  const clampedEndLine = Math.min(range.endLine, totalLines);
  const isFullFileRange = range.startLine <= 0 && clampedEndLine >= Math.max(totalLines - 1, 0);
  const previewLimit = hasContent
    ? isFullFileRange
      ? contentLength
      : Math.min(range.endLine, contentLength)
    : 0;
  const safeLimit = Math.max(previewLimit - 1, 0);
  const previewStartLine = isFullFileRange ? 0 : Math.min(range.startLine, safeLimit);
  const previewEndLine = Math.min(previewStartLine + MAX_PREVIEW_LINES, previewLimit);
  const previewLines = hasContent ? file.content.slice(previewStartLine, previewEndLine) : [];
  const remainingLines = hasContent
    ? Math.max(0, contentLength - Math.min(range.endLine, contentLength))
    : 0;
  const hasPreviewLines = previewLines.length > 0;
  const showLoadingState = !hasPreviewLines && file.contentStatus !== 'ready';
  const showRemainingLines = hasContent && remainingLines > 0;

  return {
    previewStartLine,
    previewLines,
    remainingLines,
    hasPreviewLines,
    showLoadingState,
    showRemainingLines,
  };
};

const RangeItem = memo(
  ({
    range,
    file,
    lineScale,
    handleStart,
    getGlobalIndex,
    onToggleRange,
    onMoveRange,
    hoveredRangeId,
    setHoveredRangeId,
    onPreviewHover,
    isDragging,
    allowOverlap,
  }: {
    range: TapestryRange;
    file: FileTapestry;
    lineScale: number;
    handleStart: (
      mode: InteractionMode,
      rangeId: string | null,
      clientY: number,
      range?: TapestryRange,
      pointerId?: number
    ) => void;
    getGlobalIndex: (rangeId: string) => number;
    onToggleRange: (fileId: string, rangeId: string) => void;
    onMoveRange?: (
      fileId: string,
      rangeId: string,
      newStartLine: number,
      newEndLine: number
    ) => void;
    hoveredRangeId: string | null;
    setHoveredRangeId: (id: string | null) => void;
    onPreviewHover?: () => void;
    isDragging?: boolean | undefined;
    allowOverlap?: boolean | undefined;
  }) => {
    const top = range.startLine * lineScale;
    const height = (range.endLine - range.startLine) * lineScale;
    const globalIndex = getGlobalIndex(range.id);
    const isHovered = hoveredRangeId === range.id;
    const {
      previewStartLine,
      previewLines,
      remainingLines,
      hasPreviewLines,
      showLoadingState,
      showRemainingLines,
    } = buildRangePreview(range, file);

    const handleKeyDown = (e: React.KeyboardEvent) => {
      const action = resolveRangeKeyAction({
        key: e.key,
        range,
        totalLines: file.totalLines,
      });

      if (action.type === 'toggle') {
        e.preventDefault();
        e.stopPropagation();
        onToggleRange(file.id, range.id);
        return;
      }

      if (action.type === 'move') {
        e.preventDefault();
        e.stopPropagation();
        if (action.startLine !== range.startLine && onMoveRange) {
          const rangeHeight = range.endLine - range.startLine;
          const siblings = allowOverlap ? [] : file.selections.filter((s) => s.id !== range.id);
          const bounds =
            siblings.length > 0
              ? clampKeyboardMove(action.startLine, rangeHeight, range.startLine, siblings)
              : { startLine: action.startLine, endLine: action.startLine + rangeHeight };
          if (bounds) {
            onMoveRange(file.id, range.id, bounds.startLine, bounds.endLine);
          }
        }
      }
    };

    return (
      <Tooltip open={isHovered}>
        <TooltipTrigger asChild>
          <div
            aria-label={`Range ${range.startLine} to ${range.endLine} in ${file.name}`}
            aria-valuemax={file.totalLines}
            aria-valuemin={0}
            aria-valuenow={range.startLine}
            className={cn(
              'group/range absolute right-0 left-0 focus-visible:ring-2 focus-visible:ring-ring',
              !isDragging && 'transition-all duration-75 ease-out',
              range.isActive ? 'opacity-100' : 'opacity-40 grayscale',
              isHovered ? 'z-40' : 'z-20'
            )}
            onKeyDown={handleKeyDown}
            onMouseEnter={() => {
              setHoveredRangeId(range.id);
              onPreviewHover?.();
            }}
            onMouseLeave={() => setHoveredRangeId(null)}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (e.button === 0 && !e.shiftKey) {
                handleStart('MOVING', range.id, e.clientY, range, e.pointerId);
              }
            }}
            role="slider"
            style={{
              top,
              height: Math.max(lineScale, height),
              backgroundColor: `${range.color}20`,
              borderLeft: `3px solid ${range.color}`,
              boxShadow: range.isActive ? `inset 0 0 20px -10px ${range.color}` : 'none',
            }}
            tabIndex={0}
          >
            {/* Header bar for dragging/info */}
            <div
              className="absolute top-0 left-0 h-[1px] w-full opacity-50"
              style={{ backgroundColor: range.color }}
            />

            {/* Active Toggle */}
            <button
              aria-label={range.isActive ? 'Deactivate range' : 'Activate range'}
              className={cn(
                'no-depress absolute -top-1.5 -right-1.5 z-40 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border shadow-xs transition-all',
                range.isActive ? 'scale-100 bg-background' : 'scale-90 bg-muted hover:scale-110'
              )}
              onPointerDown={(e) => {
                e.stopPropagation();
                onToggleRange(file.id, range.id);
              }}
              style={{ borderColor: range.color }}
              type="button"
            >
              <div
                className={cn(
                  'h-2 w-2 rounded-full transition-colors',
                  !range.isActive && 'bg-muted-foreground'
                )}
                style={{ backgroundColor: range.isActive ? range.color : undefined }}
              />
            </button>

            {/* Index Badge */}
            {range.isActive && (
              <div
                className="pointer-events-none absolute -top-2 right-4 z-40 select-none rounded border border-border bg-background px-1 font-mono text-[9px] shadow-xs"
                style={{ color: range.color, borderColor: range.color }}
              >
                #{globalIndex}
              </div>
            )}

            {/* Resize Handles */}
            <button
              aria-label="Resize range top"
              className="no-depress absolute -top-1 right-4 left-0 z-40 h-3 cursor-ns-resize bg-transparent transition-colors hover:bg-white/10"
              onPointerDown={(e) => {
                e.stopPropagation();
                handleStart('RESIZING_TOP', range.id, e.clientY, range, e.pointerId);
              }}
              type="button"
            />

            <button
              aria-label="Resize range bottom"
              className="no-depress absolute right-4 -bottom-1 left-0 z-40 h-3 cursor-ns-resize bg-transparent transition-colors hover:bg-white/10"
              onPointerDown={(e) => {
                e.stopPropagation();
                handleStart('RESIZING_BOTTOM', range.id, e.clientY, range, e.pointerId);
              }}
              type="button"
            />

            {/* Line Numbers Overlay */}
            {height > 12 && (
              <div
                className="pointer-events-none absolute top-0.5 left-1.5 flex select-none flex-col font-bold font-mono text-[9px] leading-none"
                style={{ color: range.color }}
              >
                <span>{range.startLine}</span>
              </div>
            )}
            {height > 24 && (
              <div
                className="pointer-events-none absolute bottom-0.5 left-1.5 flex select-none flex-col font-bold font-mono text-[9px] leading-none opacity-70"
                style={{ color: range.color }}
              >
                <span>{range.endLine}</span>
              </div>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent
          align="start"
          className="pointer-events-none z-[100] w-72 border-border p-0 shadow-2xl ring-1 ring-border"
          collisionPadding={8}
          side="right"
          sideOffset={16}
        >
          <div className="flex items-center justify-between border-border border-b bg-muted p-2">
            <span className="font-bold text-[10px] text-foreground">{file.name}</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              Lines {range.startLine}-{range.endLine}
            </span>
          </div>
          <div
            className="relative overflow-hidden bg-background p-3"
            style={{ minHeight: '100px' }}
          >
            {hasPreviewLines ? (
              <div className="whitespace-pre font-medium font-mono text-[10px] text-foreground leading-relaxed">
                {previewLines.map((line, i) => {
                  const lineNumber = previewStartLine + i;
                  return (
                    <div className="flex gap-3" key={`${range.id}-line-${lineNumber}`}>
                      <span className="w-6 select-none text-right text-muted-foreground/50 opacity-50">
                        {lineNumber}
                      </span>
                      <span className="opacity-90">{line || ' '}</span>
                    </div>
                  );
                })}
                {showRemainingLines && (
                  <div className="mt-2 pl-9 text-muted-foreground italic">
                    ... {remainingLines} more lines
                  </div>
                )}
              </div>
            ) : (
              <div className="flex min-h-[88px] items-center justify-center text-muted-foreground text-xs">
                {showLoadingState ? 'Loading preview...' : 'Empty file'}
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }
);

RangeItem.displayName = 'RangeItem';

export const Minimap = memo(
  ({
    allowOverlap,
    file,
    scale,
    smartStart,
    onToggleRange,
    onMoveRange,
    getGlobalIndex,
    isSelected,
    isDragging,
    onToggleSelection,
    onRequestFileContent,
    showSelectionControls = true,
  }: MinimapProps) => {
    const containerRef = useRef<HTMLButtonElement>(null);
    const [hoveredRangeId, setHoveredRangeId] = useState<string | null>(null);
    const prevScaleRef = useRef(scale);

    const { totalHeight, lineScale, lineThickness } = getTapestryRenderMetrics(
      file.totalLines,
      scale
    );

    // Synchronous: animate height only when totalLines changed (content load),
    // not when the user moved the density slider.
    const animateHeight = prevScaleRef.current === scale;

    useEffect(() => {
      prevScaleRef.current = scale;
    }, [scale]);

    useEffect(() => {
      if (file.contentStatus !== 'idle') {
        return;
      }
      onRequestFileContent?.(file.compositeKey);
    }, [file.contentStatus, file.compositeKey, onRequestFileContent]);

    const handlePreviewHover = useCallback(() => {
      if (file.contentStatus === 'idle') {
        onRequestFileContent?.(file.compositeKey);
      }
    }, [file.contentStatus, file.compositeKey, onRequestFileContent]);

    const handlePointerDown = (e: React.PointerEvent) => {
      e.stopPropagation();

      const target = e.target as HTMLElement;
      const isBackground = target === containerRef.current || target.id === 'minimap-bg';

      if (isBackground && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const relativeY = e.clientY - rect.top;
        const clickedLine = Math.floor(relativeY / lineScale);
        const maxLine = Math.max(file.totalLines - 1, 0);
        const clampedLine = Math.min(Math.max(clickedLine, 0), maxLine);
        smartStart('CREATING', file.id, null, e.clientY, undefined, clampedLine, e.pointerId);
      }
    };

    const handleStart = useCallback(
      (
        mode: InteractionMode,
        rangeId: string | null,
        clientY: number,
        range?: TapestryRange,
        pointerId?: number
      ) => {
        smartStart(mode, file.id, rangeId, clientY, range, undefined, pointerId);
      },
      [smartStart, file.id]
    );

    const isAnyHovered = !!hoveredRangeId;
    const displayRootFolder = getRootFolderDisplayName(file.rootFolderId);

    // Memoize SVG rects to avoid recreating hundreds of React elements per render.
    const structureRects = useMemo(
      () =>
        file.structure.map((line, i) => {
          if (line.isEmpty) {
            return null;
          }
          const lineKey = `${file.id}-ln${i}-w${line.width}-d${line.indent}`;
          return (
            <rect
              className="text-muted-foreground/40"
              fill="currentColor"
              height={lineThickness}
              key={lineKey}
              width={`${line.width}%`}
              x={`${line.indent * 5}%`}
              y={i * lineScale}
            />
          );
        }),
      [file.structure, file.id, lineScale, lineThickness]
    );

    return (
      <div
        className={cn(
          'flex w-full flex-col gap-2',
          isAnyHovered ? 'relative z-40' : 'relative z-0'
        )}
      >
        <div className="flex select-none flex-col gap-1 px-2 text-muted-foreground text-xs">
          <div className="flex min-w-0 items-start gap-2" title={file.path}>
            {showSelectionControls ? (
              <Checkbox
                aria-label={`Select ${file.path}`}
                checked={isSelected}
                className="mt-0.5 h-4 w-4"
                onCheckedChange={(checked) => onToggleSelection(file.compositeKey, !!checked)}
                onClick={(event) => event.stopPropagation()}
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <span className="line-clamp-2 block font-bold text-foreground leading-tight">
                {file.name}
              </span>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-[10px]">
                <div className="flex min-w-0 items-center gap-1 text-muted-foreground/70">
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full',
                      file.selections.some((s) => s.isActive)
                        ? 'bg-indigo-500'
                        : 'bg-muted-foreground/30'
                    )}
                  />
                  <span className="truncate">{displayRootFolder}</span>
                </div>
                <span className="font-mono text-[10px] opacity-70">{file.totalLines}L</span>
                <ExtensionBadge extension={file.type} size="compact" />
                {file.size === undefined ? (
                  file.contentStatus === 'loading' ? (
                    <span className="inline-block h-3 w-10 animate-pulse rounded bg-muted" />
                  ) : (
                    <span className="font-mono text-[10px] opacity-70">—</span>
                  )
                ) : (
                  <span className="font-mono text-[10px] opacity-70">
                    {formatPreviewFileSize(file.size)}
                  </span>
                )}
                {file.tokens === undefined ? (
                  file.contentStatus === 'loading' ? (
                    <span className="inline-block h-3 w-12 animate-pulse rounded bg-muted" />
                  ) : (
                    <span className="font-mono text-[10px] opacity-70">—</span>
                  )
                ) : (
                  <span className="font-mono text-[10px] opacity-70">
                    {formatTokenCount(file.tokens)}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div
          className={cn(
            'group relative w-full overflow-visible rounded-md border bg-linear-to-b from-background to-muted/20 shadow-xs hover:border-accent',
            file.contentStatus === 'loading' ? 'border-indigo-500/30' : 'border-border'
          )}
          style={{
            height: totalHeight,
            transition: animateHeight
              ? 'height 200ms ease-out, border-color 150ms, color 150ms'
              : 'border-color 150ms, color 150ms',
          }}
        >
          {file.contentStatus === 'loading' && (
            <div className="absolute top-0 right-0 left-0 z-30 h-0.5 overflow-hidden rounded-t-md bg-muted">
              <div
                className="h-full w-1/3 rounded-full bg-indigo-500/60"
                style={{ animation: 'tapestry-shimmer 1.5s ease-in-out infinite' }}
              />
            </div>
          )}

          {/* Background button for range creation */}
          <button
            aria-label={`Create range in ${file.name}`}
            className="no-depress absolute inset-0 z-0 h-full w-full cursor-crosshair rounded-md bg-transparent"
            onPointerDown={handlePointerDown}
            ref={containerRef}
            type="button"
          >
            <div className="absolute inset-0 overflow-hidden rounded-md" id="minimap-bg" />

            {/* Structure Visualization */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-md">
              <svg
                aria-label={`Visual structure of ${file.name}`}
                className={cn(
                  'z-10 h-full w-full transition-opacity duration-500',
                  file.contentStatus === 'ready' ? 'opacity-60' : 'opacity-25'
                )}
                preserveAspectRatio="none"
                role="img"
              >
                <title>File structure minimap</title>
                <desc>Non-interactive overview of file structure by line density.</desc>
                {structureRects}
              </svg>
            </div>
          </button>

          {/* Ranges rendered as siblings of the background button to avoid nesting */}
          {file.selections.map((range) => (
            <RangeItem
              allowOverlap={allowOverlap}
              file={file}
              getGlobalIndex={getGlobalIndex}
              handleStart={handleStart}
              hoveredRangeId={hoveredRangeId}
              isDragging={isDragging}
              key={range.id}
              lineScale={lineScale}
              onPreviewHover={handlePreviewHover}
              {...(onMoveRange ? { onMoveRange } : {})}
              onToggleRange={onToggleRange}
              range={range}
              setHoveredRangeId={setHoveredRangeId}
            />
          ))}
        </div>
      </div>
    );
  }
);

Minimap.displayName = 'Minimap';
