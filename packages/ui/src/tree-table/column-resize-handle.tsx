/**
 * Accessible column resize handle.
 *
 * Lives inside a `<TableHead>` as an absolutely positioned overlay near the
 * right edge of the header. Drives pointer- and keyboard-driven resize via a
 * `(columnId, nextWidth) => void` callback. Sort/header click handlers are
 * isolated via `stopPropagation`; the handle is a `<span role="separator">`
 * rather than a `<button>` so click events don't bubble through native
 * button semantics.
 */

import * as React from 'react';
import { cn } from '../lib/utils';
import type { ColumnBounds } from './use-column-sizing';
import { clampWidth } from './use-column-sizing';

const COARSE_STEP = 32;
const FINE_STEP = 8;

export interface ColumnResizeHandleProps {
  bounds: ColumnBounds;
  columnId: string;
  /** Accessible name fragment (e.g. column header text). */
  columnLabel: string;
  currentWidth: number;
  onResize: (columnId: string, nextWidth: number) => void;
}

interface DragState {
  pointerId: number;
  startClientX: number;
  startWidth: number;
}

const HANDLE_CLASS_NAME = [
  // Position the handle as a thin overlay on the right edge with a wider hit
  // target than the visible affordance for easier mouse targeting.
  'absolute top-0 right-[-3px] z-10 h-full w-2.5 cursor-col-resize',
  'select-none touch-none',
  // Inner 1px indicator (drawn via ::after) keeps the resting state
  // ultra-subtle while the wider hit zone stays mouse-friendly.
  "after:absolute after:top-1.5 after:bottom-1.5 after:right-[3px] after:w-px after:bg-border/40 after:content-[''] after:transition-colors",
  // Hover/focus elevate the indicator into a clear primary color stripe.
  'hover:after:bg-primary/70 hover:after:w-0.5',
  'focus-visible:outline-none focus-visible:after:bg-primary focus-visible:after:w-0.5',
  // Active-drag emphasis via data attribute set on pointer down.
  'data-[resizing=true]:after:bg-primary data-[resizing=true]:after:w-0.5',
].join(' ');

function stopAllPropagation(event: React.SyntheticEvent): void {
  event.stopPropagation();
  // The Radix/RTL `closest('th')[onClick]` sort path also triggers on native
  // click — make sure both phases see the stop.
  if ('nativeEvent' in event && event.nativeEvent instanceof Event) {
    event.nativeEvent.stopImmediatePropagation();
  }
}

export function ColumnResizeHandle({
  columnId,
  columnLabel,
  bounds,
  currentWidth,
  onResize,
}: ColumnResizeHandleProps): React.ReactElement | null {
  const dragStateRef = React.useRef<DragState | null>(null);
  // Holds a teardown function for any in-flight pointer drag. Stored in a ref
  // (not state) so the unmount-cleanup effect can call it without re-rendering
  // and without restarting the drag if React reconciles mid-gesture.
  const dragCleanupRef = React.useRef<(() => void) | null>(null);
  const [isResizing, setIsResizing] = React.useState(false);

  // Failsafe: if the component unmounts while a drag is still in flight, the
  // window-level pointer listeners we installed on pointerdown would never be
  // removed and would leak across remounts. This effect calls the stored
  // cleanup on unmount only — the deps array is intentionally empty.
  React.useEffect(
    () => () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    },
    []
  );

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLSpanElement>) => {
      if (event.button !== 0) {
        return;
      }
      stopAllPropagation(event);
      event.preventDefault();
      setIsResizing(true);

      const target = event.currentTarget;
      // Use setPointerCapture so pointer move/up events keep firing on the
      // handle even when the cursor moves outside the header cell.
      if (typeof target.setPointerCapture === 'function') {
        try {
          target.setPointerCapture(event.pointerId);
        } catch {
          // Some test environments (JSDOM) lack pointer-capture support.
        }
      }

      dragStateRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startWidth: currentWidth,
      };

      const handleMove = (moveEvent: PointerEvent): void => {
        const state = dragStateRef.current;
        if (!state || state.pointerId !== moveEvent.pointerId) {
          return;
        }
        const delta = moveEvent.clientX - state.startClientX;
        const next = clampWidth(state.startWidth + delta, bounds);
        onResize(columnId, next);
      };

      const detachListeners = (): void => {
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleEnd);
        window.removeEventListener('pointercancel', handleEnd);
      };

      const handleEnd = (endEvent: PointerEvent): void => {
        const state = dragStateRef.current;
        if (!state || state.pointerId !== endEvent.pointerId) {
          return;
        }
        const delta = endEvent.clientX - state.startClientX;
        const final = clampWidth(state.startWidth + delta, bounds);
        onResize(columnId, final);
        dragStateRef.current = null;
        dragCleanupRef.current = null;
        setIsResizing(false);
        detachListeners();
      };

      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleEnd);
      window.addEventListener('pointercancel', handleEnd);
      // Stash a tear-down so the unmount-cleanup effect can sever listeners
      // even if pointerup/pointercancel never fire (e.g., component unmounts
      // while the user is mid-drag).
      dragCleanupRef.current = () => {
        dragStateRef.current = null;
        detachListeners();
      };
    },
    [bounds, columnId, currentWidth, onResize]
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLSpanElement>) => {
      const step = event.shiftKey ? COARSE_STEP : FINE_STEP;
      let next: number | null = null;
      switch (event.key) {
        case 'ArrowLeft':
          next = currentWidth - step;
          break;
        case 'ArrowRight':
          next = currentWidth + step;
          break;
        case 'Home':
          next = bounds.minWidth;
          break;
        case 'End':
          next = bounds.maxWidth;
          break;
        default:
          return;
      }
      stopAllPropagation(event);
      event.preventDefault();
      onResize(columnId, clampWidth(next, bounds));
    },
    [bounds, columnId, currentWidth, onResize]
  );

  // Headers wire their click handler for sort. The handle must not bubble.
  const handleClick = React.useCallback((event: React.MouseEvent<HTMLSpanElement>) => {
    stopAllPropagation(event);
  }, []);

  // Double-click resets the column to its declared defaultWidth — a standard
  // affordance for users who have dragged a column into an unusable size and
  // want a one-gesture escape hatch. Falls back to minWidth when no default
  // is declared so the column never collapses to zero.
  const handleDoubleClick = React.useCallback(
    (event: React.MouseEvent<HTMLSpanElement>) => {
      stopAllPropagation(event);
      event.preventDefault();
      const target = bounds.defaultWidth ?? bounds.minWidth;
      onResize(columnId, clampWidth(target, bounds));
    },
    [bounds, columnId, onResize]
  );

  return (
    /* biome-ignore lint/a11y/useSemanticElements: <hr> cannot host focus, tabIndex, or pointer/keyboard handlers; the WAI-ARIA pattern for an interactive column resize affordance is span[role="separator"]. */
    <span
      aria-label={`Resize ${columnLabel} column`}
      aria-orientation="vertical"
      aria-valuemax={bounds.maxWidth}
      aria-valuemin={bounds.minWidth}
      aria-valuenow={currentWidth}
      className={cn(HANDLE_CLASS_NAME)}
      data-resizing={isResizing || undefined}
      data-testid={`tree-table-resize-handle-${columnId}`}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={handlePointerDown}
      role="separator"
      tabIndex={0}
      title={'Drag to resize • Double-click to reset • Arrow keys to nudge'}
    />
  );
}
