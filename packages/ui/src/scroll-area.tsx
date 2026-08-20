import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import type * as React from 'react';

import { cn } from './lib/utils';

/**
 * Which axes the viewport's content is allowed to size along.
 *
 * Radix wraps the viewport's children in a `min-width: 100%; display: table`
 * div so content can grow past the viewport and scroll horizontally. A table
 * box takes its content's min-content width, so children are laid out at full
 * content width and never see a shortfall — `flex-1` has nothing to shrink and
 * `truncate` never ellipsises, leaving rows to overflow the panel instead.
 *
 * - `both` (default) keeps that behaviour for content that genuinely scrolls
 *   sideways, such as diffs and wide tables.
 * - `vertical` forces the wrapper back to a block box, constraining content to
 *   the viewport width. Radix sets `display` inline, so `!important` is the
 *   only way to override it.
 */
export type ScrollAreaAxis = 'both' | 'vertical';

const ScrollArea = ({
  axis = 'both',
  className,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
  axis?: ScrollAreaAxis;
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
        axis === 'vertical' && '[&>div]:!block'
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
