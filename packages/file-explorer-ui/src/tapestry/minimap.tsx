import { cn } from '@brainstrike/ui';
import { memo, useRef, useState } from 'react';
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
  }) => {
    const top = range.startLine * scale;
    const height = (range.endLine - range.startLine) * scale;
    const globalIndex = getGlobalIndex(range.id);
    const isHovered = hoveredRangeId === range.id;

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
        onMouseEnter={() => setHoveredRangeId(range.id)}
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
            '-top-1.5 -right-1.5 no-depress absolute z-40 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border shadow-xs transition-all',
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
            className="-top-2 pointer-events-none absolute right-4 z-40 select-none rounded border border-border bg-background px-1 font-mono text-[9px] shadow-xs"
            style={{ color: range.color, borderColor: range.color }}
          >
            #{globalIndex}
          </div>
        )}

        {/* Peek Tooltip */}
        {isHovered && (
          <div
            className="fade-in slide-in-from-left-2 pointer-events-none absolute top-0 left-full z-[100] ml-4 w-72 animate-in overflow-hidden rounded-lg border border-border bg-popover p-0 shadow-2xl ring-1 ring-border duration-150"
            style={{ minHeight: '100px' }}
          >
            <div className="flex items-center justify-between border-border border-b bg-muted p-2">
              <span className="font-bold text-[10px] text-foreground">{file.name}</span>
              <span className="font-mono text-[10px] text-muted-foreground">
                Lines {range.startLine}-{range.endLine}
              </span>
            </div>
            <div className="relative overflow-hidden bg-background p-3">
              <div className="whitespace-pre font-medium font-mono text-[10px] text-foreground leading-relaxed">
                {file.content
                  .slice(range.startLine, Math.min(range.startLine + 8, range.endLine))
                  .map((line, i) => (
                    <div className="flex gap-3" key={`${range.id}-line-${i}`}>
                      <span className="w-6 select-none text-right text-muted-foreground/50 opacity-50">
                        {range.startLine + i}
                      </span>
                      <span className="opacity-90">{line || ' '}</span>
                    </div>
                  ))}
                {range.endLine - range.startLine > 8 && (
                  <div className="mt-2 pl-9 text-muted-foreground italic">
                    ... {range.endLine - range.startLine - 8} more lines
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Resize Handles */}
        <button
          aria-label="Resize range top"
          className="-top-1 no-depress absolute right-4 left-0 z-40 h-3 cursor-ns-resize bg-transparent transition-colors hover:bg-white/10"
          onMouseDown={(e) => {
            e.stopPropagation();
            handleStart('RESIZING_TOP', range.id, e.clientY, range);
          }}
          type="button"
        />

        <button
          aria-label="Resize range bottom"
          className="-bottom-1 no-depress absolute right-4 left-0 z-40 h-3 cursor-ns-resize bg-transparent transition-colors hover:bg-white/10"
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
  }: MinimapProps) => {
    const containerRef = useRef<HTMLButtonElement>(null);
    const [hoveredRangeId, setHoveredRangeId] = useState<string | null>(null);

    const totalHeight = file.totalLines * scale;
    const lineThickness = Math.max(1, scale * 0.6);

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
        <div className="flex select-none items-center justify-between px-2 text-muted-foreground text-xs">
          <div className="flex items-center gap-2 truncate" title={file.name}>
            <div
              className={cn(
                'h-2 w-2 rounded-full',
                file.selections.some((s) => s.isActive) ? 'bg-indigo-500' : 'bg-muted-foreground/30'
              )}
            />
            <span className="max-w-[100px] truncate font-bold text-foreground">{file.name}</span>
            <span className="text-[10px] opacity-50">{file.totalLines}L</span>
          </div>
        </div>

        <button
          aria-label={`Create range in ${file.name}`}
          className="group no-depress relative w-full cursor-crosshair overflow-visible rounded-md border border-border bg-muted/30 shadow-xs transition-colors hover:border-accent"
          onMouseDown={handleMouseDown}
          ref={containerRef}
          style={{ height: totalHeight }}
          type="button"
        >
          <div className="absolute inset-0 z-0 overflow-hidden rounded-md" id="minimap-bg" />

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

          {file.selections.map((range) => (
            <RangeItem
              file={file}
              getGlobalIndex={getGlobalIndex}
              handleStart={handleStart}
              hoveredRangeId={hoveredRangeId}
              key={range.id}
              {...(onMoveRange ? { onMoveRange } : {})}
              onToggleRange={onToggleRange}
              range={range}
              scale={scale}
              setHoveredRangeId={setHoveredRangeId}
            />
          ))}
        </button>
      </div>
    );
  }
);

Minimap.displayName = 'Minimap';
