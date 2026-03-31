import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import type * as React from 'react';

import { cn } from './lib/utils';

const ScrollArea = ({
  className,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <ScrollAreaPrimitive.Root
    className={cn('relative overflow-hidden', className)}
    data-slot="scroll-area"
    ref={ref}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport
      className="size-full rounded-[inherit] outline-hidden transition-[color,box-shadow] focus-visible:outline-1 focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
