import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import type * as React from 'react';

import { cn } from './lib/utils';

/**
 * Where the viewport's content box gets its width from.
 *
 * Radix wraps the viewport's children in a `min-width: 100%; display: table`
 * div so content can size past the viewport and scroll horizontally. A table
 * box takes its content's min-content width, so children are laid out at full
 * content width and never see a shortfall — `flex-1` has nothing to shrink and
 * `truncate` never ellipsises, leaving rows to overflow their panel.
 *
 * - `auto` (default) keeps that behaviour, for content that is meant to size
 *   itself and scroll sideways, such as diffs and wide tables.
 * - `viewport` forces the wrapper back to a block box, so the content box is
 *   the viewport's width and shrinkable children actually shrink. Radix sets
 *   `display` inline, so the override must be `!important`.
 *
 * This controls SIZING, not which axes scroll. Under `viewport` a child that
 * genuinely cannot shrink — `white-space: nowrap` without `truncate` — still
 * grows `scrollWidth` past the viewport and still scrolls horizontally, and
 * the horizontal `ScrollBar` below stays mounted for exactly that case.
 * (Measured: a `nowrap` child in a 523px viewport gives `scrollWidth` 3878 and
 * scrolls to 3355.) Use `truncate`/`break-all` on children you want to shrink;
 * this prop only gives them a width to shrink against.
 *
 * One side effect worth knowing: a block box does not isolate margins the way
 * a table box does, so under `viewport` a child's top/bottom margin can
 * collapse through the wrapper.
 */
export type ScrollAreaContentWidth = 'auto' | 'viewport';

const ScrollArea = ({
  contentWidth = 'auto',
  className,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
  contentWidth?: ScrollAreaContentWidth;
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <ScrollAreaPrimitive.Root
    className={cn('relative overflow-hidden', className)}
    data-slot="scroll-area"
    ref={ref}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport
      className={cn(
        'size-full rounded-[inherit] outline-hidden transition-[color,box-shadow] focus-visible:outline-1 focus-visible:ring-[3px] focus-visible:ring-ring/50',
        // `& > div` is the content wrapper Radix renders inside every viewport.
        contentWidth === 'viewport' && '[&>div]:!block'
      )}
      data-slot="scroll-area-viewport"
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar orientation="vertical" />
    <ScrollBar orientation="horizontal" />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
);
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = ({
  className,
  orientation = 'vertical',
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    className={cn(
      'flex touch-none select-none p-px transition-colors',
      orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent',
      orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent',
      className
    )}
    data-slot="scroll-area-scrollbar"
    orientation={orientation}
    ref={ref}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb
      className="relative flex-1 rounded-full bg-border"
      data-slot="scroll-area-thumb"
    />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
);
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
