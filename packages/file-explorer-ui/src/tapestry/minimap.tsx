import { Badge, Checkbox, cn, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { memo, useRef, useState } from 'react';
import { formatTokenCount } from '../use-preview-panel-state';
import { formatPreviewFileSize } from '../utils/preview-formatters';
import type { FileTapestry, InteractionMode, TapestryRange } from './types';

type MinimapProps = {
  file: FileTapestry;
  scale: number;
  onInteractionStart: (
    mode: InteractionMode,
    fileId: string,
    rangeId: string | null,
    clientY: number,
    initialRange?: TapestryRange
  ) => void;
  smartStart?: (
    mode: InteractionMode,
    fileId: string,
    rangeId: string | null,
    clientY: number,
    initialRange?: TapestryRange,
    clickedLine?: number
  ) => void;
  onToggleRange: (fileId: string, rangeId: string) => void;
  onMoveRange?: (fileId: string, rangeId: string, newStartLine: number, newEndLine: number) => void;
  getGlobalIndex: (rangeId: string) => number;
  isSelected: boolean;
  onToggleSelection: (compositeKey: string, checked: boolean) => void;
  onRequestFileContent?: (compositeKey: string) => void;
};

const RangeItem = memo(
  ({
    range,
    file,
    scale,
    handleStart,
    getGlobalIndex,
    onToggleRange,
    onMoveRange,
    hoveredRangeId,
    setHoveredRangeId,
    onPreviewHover,
  }: {
    range: TapestryRange;
    file: FileTapestry;
    scale: number;
    handleStart: (
      mode: InteractionMode,
      rangeId: string | null,
      clientY: number,
      range?: TapestryRange
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
  }) => {
    const top = range.startLine * scale;
    const height = (range.endLine - range.startLine) * scale;
    const globalIndex = getGlobalIndex(range.id);
    const isHovered = hoveredRangeId === range.id;
    const maxPreviewLines = 8;
    const isFullFileRange = range.startLine === 0 && range.endLine >= file.totalLines;
    const contentLength = file.content.length;
    const clampedStart = Math.min(range.startLine, Math.max(contentLength - 1, 0));
    const previewStartLine = isFullFileRange ? 0 : clampedStart;
    const previewEndLine = Math.min(
      previewStartLine + maxPreviewLines,
      isFullFileRange ? contentLength : Math.min(range.endLine, contentLength)
    );
    const previewLines = file.content.slice(previewStartLine, previewEndLine);
    const selectionLength = Math.max(0, range.endLine - range.startLine);
    const totalLines = Math.max(file.totalLines, file.content.length);
    const remainingLines = Math.max(0, totalLines - selectionLength);

    const handleKeyDown = (e: React.KeyboardEvent) => {
      const rangeHeight = range.endLine - range.startLine;
      let newStartLine = range.startLine;
      let handled = false;

      switch (e.key) {
        case 'ArrowUp':
          newStartLine = Math.max(0, range.startLine - 1);
          handled = true;
          break;
        case 'ArrowDown':
          newStartLine = Math.min(file.totalLines - rangeHeight, range.startLine + 1);
          handled = true;
          break;
        case 'PageUp':
          newStartLine = Math.max(0, range.startLine - 10);
          handled = true;
          break;
        case 'PageDown':
          newStartLine = Math.min(file.totalLines - rangeHeight, range.startLine + 10);
          handled = true;
          break;
        case 'Home':
          newStartLine = 0;
          handled = true;
          break;
        case 'End':
          newStartLine = Math.max(0, file.totalLines - rangeHeight);
          handled = true;
          break;
        case 'Enter':
        case ' ':
          onToggleRange(file.id, range.id);
          handled = true;
          break;
      }

      if (handled) {
        e.preventDefault();
        e.stopPropagation();

        if (newStartLine !== range.startLine && onMoveRange) {
          onMoveRange(file.id, range.id, newStartLine, newStartLine + rangeHeight);
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
              'group/range absolute right-0 left-0 transition-all duration-75 ease-out focus-visible:ring-2 focus-visible:ring-ring',
              range.isActive ? 'opacity-100' : 'opacity-40 grayscale',
              isHovered ? 'z-40' : 'z-20'
            )}
            onKeyDown={handleKeyDown}
            onMouseDown={(e) => {
              e.stopPropagation();
              if (e.button === 0 && !e.shiftKey) {
                handleStart('MOVING', range.id, e.clientY, range);
              }
            }}
            onMouseEnter={() => {
              setHoveredRangeId(range.id);
              onPreviewHover?.();
            }}
            onMouseLeave={() => setHoveredRangeId(null)}
            role="slider"
            style={{
              top,
              height: Math.max(scale, height),
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
              onMouseDown={(e) => {
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
              onMouseDown={(e) => {
                e.stopPropagation();
                handleStart('RESIZING_TOP', range.id, e.clientY, range);
              }}
              type="button"
            />

            <button
              aria-label="Resize range bottom"
              className="no-depress absolute right-4 -bottom-1 left-0 z-40 h-3 cursor-ns-resize bg-transparent transition-colors hover:bg-white/10"
              onMouseDown={(e) => {
                e.stopPropagation();
                handleStart('RESIZING_BOTTOM', range.id, e.clientY, range);
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
            <div className="whitespace-pre font-medium font-mono text-[10px] text-foreground leading-relaxed">
              {previewLines.map((line, i) => (
                <div className="flex gap-3" key={`${range.id}-line-${i}`}>
                  <span className="w-6 select-none text-right text-muted-foreground/50 opacity-50">
                    {previewStartLine + i}
                  </span>
                  <span className="opacity-90">{line || ' '}</span>
                </div>
              ))}
              {remainingLines > 0 && (
                <div className="mt-2 pl-9 text-muted-foreground italic">
                  ... {remainingLines} more lines
                </div>
              )}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }
);

RangeItem.displayName = 'RangeItem';

export const Minimap = memo(
  ({
    file,
    scale,
    onInteractionStart,
    smartStart,
    onToggleRange,
    onMoveRange,
    getGlobalIndex,
    isSelected,
    onToggleSelection,
    onRequestFileContent,
  }: MinimapProps) => {
    const containerRef = useRef<HTMLButtonElement>(null);
    const [hoveredRangeId, setHoveredRangeId] = useState<string | null>(null);

    const minHeight = Math.max(80, scale * 12);
    const totalHeight = Math.max(file.totalLines * scale, minHeight);
    const lineThickness = Math.max(1, scale * 0.6);

    const handlePreviewHover = () => {
      if (file.contentStatus === 'idle') {
        onRequestFileContent?.(file.compositeKey);
      }
    };

    const handleMouseDown = (e: React.MouseEvent) => {
      e.stopPropagation();

      // Check if we clicked background
      const target = e.target as HTMLElement;
      const isBackground = target === containerRef.current || target.id === 'minimap-bg';

      if (isBackground && containerRef.current) {
        // Calculate line number
        const rect = containerRef.current.getBoundingClientRect();
        const relativeY = e.clientY - rect.top;
        const clickedLine = Math.floor(relativeY / scale);

        if (smartStart) {
          smartStart('CREATING', file.id, null, e.clientY, undefined, clickedLine);
        } else {
          onInteractionStart('CREATING', file.id, null, e.clientY);
        }
      }
    };

    const handleStart = (
      mode: InteractionMode,
      rangeId: string | null,
      clientY: number,
      range?: TapestryRange
    ) => {
      if (smartStart) {
        smartStart(mode, file.id, rangeId, clientY, range);
      } else {
        onInteractionStart(mode, file.id, rangeId, clientY, range);
      }
    };

    const isAnyHovered = !!hoveredRangeId;

    return (
      <div
        className={cn(
          'fade-in zoom-in flex w-full animate-in flex-col gap-2 duration-300',
          isAnyHovered ? 'relative z-40' : 'relative z-0'
        )}
      >
        <div className="flex select-none flex-col gap-1 px-2 text-muted-foreground text-xs">
          <div className="flex min-w-0 items-center gap-2" title={file.path}>
            <Checkbox
              aria-label={`Select ${file.path}`}
              checked={isSelected}
              className="h-4 w-4"
              onCheckedChange={(checked) => onToggleSelection(file.compositeKey, !!checked)}
              onClick={(event) => event.stopPropagation()}
            />
            <div
              className={cn(
                'h-2 w-2 rounded-full',
                file.selections.some((s) => s.isActive) ? 'bg-indigo-500' : 'bg-muted-foreground/30'
              )}
            />
            <div className="min-w-0 flex-1">
              <span className="block truncate font-bold text-foreground">{file.name}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[10px]">
            <span className="min-w-0 truncate opacity-60">{file.rootFolderId}</span>
            <div className="flex flex-shrink-0 items-center gap-2">
              <span className="font-mono text-[10px] opacity-70">{file.totalLines}L</span>
              <Badge className="px-1.5 text-[9px]" variant="secondary">
                {file.type}
              </Badge>
              <span className="font-mono text-[10px] opacity-70">
                {formatPreviewFileSize(file.size)}
              </span>
              <span className="font-mono text-[10px] opacity-70">
                {file.tokens !== undefined ? formatTokenCount(file.tokens) : '—'}
              </span>
            </div>
          </div>
        </div>

        <div
          className="group relative w-full overflow-visible rounded-md border border-border bg-linear-to-b from-background to-muted/20 shadow-xs transition-colors hover:border-accent"
          style={{ height: totalHeight }}
        >
          {/* Background button for range creation */}
          <button
            aria-label={`Create range in ${file.name}`}
            className="no-depress absolute inset-0 z-0 h-full w-full cursor-crosshair rounded-md bg-transparent"
            onMouseDown={handleMouseDown}
            ref={containerRef}
            type="button"
          >
            <div className="absolute inset-0 overflow-hidden rounded-md" id="minimap-bg" />

            {/* Structure Visualization */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-md">
              <svg
                aria-label={`Visual structure of ${file.name}`}
                className="z-10 h-full w-full opacity-60"
                preserveAspectRatio="none"
                role="img"
              >
                <title>File structure minimap</title>
                <desc>Non-interactive overview of file structure by line density.</desc>
                {file.structure.map((line, i) => {
                  if (line.isEmpty) {
                    return null;
                  }
                  return (
                    <rect
                      className="text-muted-foreground/40"
                      fill="currentColor"
                      height={lineThickness}
                      key={`${file.id}-struct-${i}`}
                      width={`${line.width}%`}
                      x={`${line.indent * 5}%`}
                      y={i * scale}
                    />
                  );
                })}
              </svg>
            </div>
          </button>

          {/* Ranges rendered as siblings of the background button to avoid nesting */}
          {file.selections.map((range) => (
            <RangeItem
              file={file}
              getGlobalIndex={getGlobalIndex}
              handleStart={handleStart}
              hoveredRangeId={hoveredRangeId}
              key={range.id}
              onPreviewHover={handlePreviewHover}
              {...(onMoveRange ? { onMoveRange } : {})}
              onToggleRange={onToggleRange}
              range={range}
              scale={scale}
              setHoveredRangeId={setHoveredRangeId}
            />
          ))}
        </div>
      </div>
    );
  }
);

Minimap.displayName = 'Minimap';
