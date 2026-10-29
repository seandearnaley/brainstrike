import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type * as React from 'react';

import { POPUP_LAYER_CLASS } from './layers';
import { cn } from './lib/utils';

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipPortal = TooltipPrimitive.Portal;

const TooltipContent = ({
  className,
  sideOffset = 4,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <TooltipPortal>
    <TooltipPrimitive.Content
      className={cn(
        'fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 animate-in bg-foreground text-background data-[state=closed]:animate-out w-fit origin-(--radix-tooltip-content-transform-origin) overflow-hidden rounded-md px-3 py-1.5 text-xs text-balance',
        POPUP_LAYER_CLASS,
        className
      )}
      data-slot="tooltip-content"
      ref={ref}
      sideOffset={sideOffset}
      {...props}
    />
  </TooltipPortal>
);
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipContent, TooltipPortal, TooltipProvider, TooltipTrigger };
