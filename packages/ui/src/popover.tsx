import * as PopoverPrimitive from '@radix-ui/react-popover';
import type * as React from 'react';

import { cn } from './lib/utils';

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

type PopoverContentProps = React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
  ref?: React.RefObject<HTMLDivElement | null>;
  /**
   * Render in-tree instead of through Radix's Portal. Use this when the popover
   * is nested inside a modal Dialog: the dialog's RemoveScroll allow-list only
   * covers its own subtree, so a portaled popover loses wheel-scroll. Popper
   * still uses position:fixed, so the content still escapes ancestor overflow.
   * @default true
   */
  portal?: boolean;
};

const PopoverContent = ({
  className,
  align = 'center',
  sideOffset = 4,
  ref,
  portal = true,
  ...props
}: PopoverContentProps) => {
  const content = (
    <PopoverPrimitive.Content
      align={align}
      className={cn(
        'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-[state=closed]:animate-out data-[state=open]:animate-in',
        className
      )}
      data-slot="popover-content"
      ref={ref}
      sideOffset={sideOffset}
      {...props}
    />
  );
  return portal ? <PopoverPrimitive.Portal>{content}</PopoverPrimitive.Portal> : content;
};
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverContent, PopoverTrigger };
