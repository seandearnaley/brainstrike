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

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLSpanElement>) => {
      if (event.button !== 0) {
        return;
      }
      stopAllPropagation(event);
      event.preventDefault();

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

      const handleEnd = (endEvent: PointerEvent): void => {
        const state = dragStateRef.current;
        if (!state || state.pointerId !== endEvent.pointerId) {
          return;
        }
        const delta = endEvent.clientX - state.startClientX;
        const final = clampWidth(state.startWidth + delta, bounds);
        onResize(columnId, final);
        dragStateRef.current = null;
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleEnd);
        window.removeEventListener('pointercancel', handleEnd);
      };

      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleEnd);
      window.addEventListener('pointercancel', handleEnd);
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

  return (
    /* biome-ignore lint/a11y/useSemanticElements: <hr> cannot host focus, tabIndex, or pointer/keyboard handlers; the WAI-ARIA pattern for an interactive column resize affordance is span[role="separator"]. */
    <span
      aria-label={`Resize ${columnLabel} column`}
      aria-orientation="vertical"
      aria-valuemax={bounds.maxWidth}
      aria-valuemin={bounds.minWidth}
      aria-valuenow={currentWidth}
      className={cn(
        'absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize',
        'touch-none select-none',
        'bg-transparent hover:bg-primary/40',
        'focus:outline-none focus-visible:bg-primary/60',
        'transition-colors'
      )}
      data-testid={`tree-table-resize-handle-${columnId}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={handlePointerDown}
      role="separator"
      tabIndex={0}
    />
  );
}
