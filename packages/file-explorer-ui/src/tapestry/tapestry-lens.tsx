import { cn } from '@brainstrike/ui';
import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { FileTapestry } from './types';
import { getTapestryLensLineExcerpt } from './utils';

export interface TapestryLensPosition {
  clientX: number;
  clientY: number;
  lineIndex: number;
  trackHeight: number;
  trackTop: number;
}

interface TapestryLensProps {
  file: FileTapestry;
  isLineSelectable?: ((lineIndex: number) => boolean) | undefined;
  mode?: 'pinned' | 'roving';
  onClose?: (() => void) | undefined;
  onCreateRange?: ((lineIndex: number) => void) | undefined;
  onNavigate?: ((lineIndex: number) => void) | undefined;
  position: TapestryLensPosition | null;
}

const ROVING_LINE_COUNT = 9;
const PINNED_LINE_COUNT = 7;
const LENS_WIDTH = 304;
const ROVING_LENS_HEIGHT = 232;
const PINNED_LENS_HEIGHT = 248;
const LENS_POINTER_GAP = 20;
const LENS_VIEWPORT_GUTTER = 12;
const LENS_LAYOUT = {
  pinned: { height: PINNED_LENS_HEIGHT, lineCount: PINNED_LINE_COUNT },
  roving: { height: ROVING_LENS_HEIGHT, lineCount: ROVING_LINE_COUNT },
} as const;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const getLensLineActionLabel = (line: string, lineIndex: number, isSelectable: boolean): string => {
  const excerpt = getTapestryLensLineExcerpt(line);
  return isSelectable
    ? `Create clip from line ${lineIndex + 1}. ${excerpt}`
    : `Line ${lineIndex + 1} already selected. ${excerpt}`;
};

const resolveLensNavigationTarget = (
  key: string,
  currentLine: number,
  totalLines: number
): number | null => {
  switch (key) {
    case 'ArrowUp':
      return currentLine - 1;
    case 'ArrowDown':
      return currentLine + 1;
    case 'PageUp':
      return currentLine - 10;
    case 'PageDown':
      return currentLine + 10;
    case 'Home':
      return 0;
    case 'End':
      return totalLines - 1;
    default:
      return null;
  }
};

export const TapestryLens = ({
  file,
  isLineSelectable,
  mode = 'roving',
  onClose,
  onCreateRange,
  onNavigate,
  position,
}: TapestryLensProps) => {
  const isPinned = mode === 'pinned';
  const shouldFocus = isPinned && position !== null;
  const lensRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!shouldFocus) {
      return;
    }

    const focusFrame = requestAnimationFrame(() => lensRef.current?.focus());
    return () => cancelAnimationFrame(focusFrame);
  }, [shouldFocus]);

  if (!position || typeof document === 'undefined') {
    return null;
  }

  const { height: lensHeight, lineCount: lensLineCount } = LENS_LAYOUT[mode];
  const maxStartLine = Math.max(file.content.length - lensLineCount, 0);
  const previewStartLine = clamp(
    position.lineIndex - Math.floor(lensLineCount / 2),
    0,
    maxStartLine
  );
  const previewLines = file.content.slice(previewStartLine, previewStartLine + lensLineCount);
  const hasPreview = file.contentStatus === 'ready' && previewLines.length > 0;
  const activeLineSelectable = isLineSelectable?.(position.lineIndex) ?? true;
  const placeOnRight = position.clientX + LENS_POINTER_GAP + LENS_WIDTH <= window.innerWidth;
  const left = clamp(
    placeOnRight
      ? position.clientX + LENS_POINTER_GAP
      : position.clientX - LENS_POINTER_GAP - LENS_WIDTH,
    LENS_VIEWPORT_GUTTER,
    Math.max(LENS_VIEWPORT_GUTTER, window.innerWidth - LENS_WIDTH - LENS_VIEWPORT_GUTTER)
  );
  const top = clamp(
    position.clientY - lensHeight / 2,
    LENS_VIEWPORT_GUTTER,
    Math.max(LENS_VIEWPORT_GUTTER, window.innerHeight - lensHeight - LENS_VIEWPORT_GUTTER)
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isPinned) {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
      return;
    }

    const navigationTarget = resolveLensNavigationTarget(
      event.key,
      position.lineIndex,
      file.totalLines
    );
    if (navigationTarget !== null) {
      event.preventDefault();
      event.currentTarget.focus();
      onNavigate?.(clamp(navigationTarget, 0, Math.max(file.totalLines - 1, 0)));
      return;
    }

    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (activeLineSelectable) {
        onCreateRange?.(position.lineIndex);
      }
      return;
    }
  };

  return createPortal(
    <div
      aria-hidden={isPinned ? undefined : true}
      aria-label={isPinned ? `Precision line selector for ${file.name}` : 'Code lens preview'}
      className={cn(
        'fixed z-[120] flex max-h-[calc(100vh-24px)] min-h-0 max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-[2rem] border border-white/25 bg-popover/90 text-popover-foreground shadow-[0_24px_80px_-24px_rgba(0,0,0,0.65)] ring-1 ring-black/15 backdrop-blur-2xl backdrop-saturate-150 motion-safe:transition-[opacity,transform] motion-safe:duration-100 motion-reduce:transition-none dark:border-white/15 dark:bg-popover/82 forced-colors:border-[CanvasText] forced-colors:bg-[Canvas]',
        isPinned ? 'pointer-events-auto h-[248px]' : 'pointer-events-none h-[232px]'
      )}
      data-lens-mode={mode}
      data-testid="tapestry-lens"
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      ref={lensRef}
      role="dialog"
      style={{ left, top, width: LENS_WIDTH }}
      tabIndex={isPinned ? -1 : undefined}
    >
      <div className="absolute inset-x-8 top-0 h-px bg-linear-to-r from-transparent via-white/70 to-transparent" />
      <div className="flex h-10 shrink-0 items-center justify-between border-white/10 border-b bg-background/45 px-4 dark:border-white/8">
        <span className="max-w-[150px] truncate font-medium text-[11px]">{file.name}</span>
        <div className="flex items-center gap-1.5">
          <span className="rounded-full border border-border/70 bg-background/60 px-2 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
            Line {position.lineIndex + 1}
          </span>
          {isPinned ? (
            <button
              aria-label="Close precision line selector"
              className="flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onClose}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>
      <div
        className={cn(
          'relative bg-background/55 px-3 py-2 font-mono text-[11px]',
          isPinned
            ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain'
            : 'h-[192px] shrink-0 overflow-hidden leading-5'
        )}
        data-testid="tapestry-lens-lines"
      >
        {hasPreview ? (
          previewLines.map((line, index) => {
            const lineIndex = previewStartLine + index;
            const isActive = lineIndex === position.lineIndex;
            const lineSelectable = isLineSelectable?.(lineIndex) ?? true;
            const content = (
              <>
                <span className="select-none pr-2 text-right text-muted-foreground/60 tabular-nums">
                  {lineIndex + 1}
                </span>
                <span className="truncate whitespace-pre">{line || ' '}</span>
              </>
            );
            const lineClassName = cn(
              'grid w-full grid-cols-[2rem_minmax(0,1fr)] rounded-md px-1 text-left',
              isPinned &&
                'min-h-6 items-center hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent',
              isActive &&
                'bg-primary/12 text-foreground ring-1 ring-primary/25 forced-colors:outline forced-colors:outline-1'
            );

            return isPinned ? (
              <button
                aria-label={getLensLineActionLabel(line, lineIndex, lineSelectable)}
                className={lineClassName}
                data-lens-active={isActive ? 'true' : undefined}
                disabled={!lineSelectable}
                key={`${file.id}-lens-${lineIndex}`}
                onClick={() => onCreateRange?.(lineIndex)}
                type="button"
              >
                {content}
              </button>
            ) : (
              <div
                className={lineClassName}
                data-lens-active={isActive ? 'true' : undefined}
                key={`${file.id}-lens-${lineIndex}`}
              >
                {content}
              </div>
            );
          })
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
            {file.contentStatus === 'ready' ? 'Empty file' : 'Loading code lens…'}
          </div>
        )}
      </div>
      {isPinned ? (
        <div className="flex h-6 shrink-0 items-center justify-between border-white/10 border-t px-4 text-[10px] text-muted-foreground dark:border-white/8">
          <span>{activeLineSelectable ? 'Choose an exact line' : 'Already in a clip'}</span>
          <span className="font-mono">↑↓ · PgUp/PgDn</span>
        </div>
      ) : (
        <div
          className={cn(
            'absolute top-1/2 h-8 w-2 -translate-y-1/2 border-white/20 border-y bg-popover/75 shadow-sm',
            placeOnRight ? '-left-1 rounded-r-full border-r' : '-right-1 rounded-l-full border-l'
          )}
          data-testid="tapestry-lens-pointer"
        />
      )}
    </div>,
    document.body
  );
};
