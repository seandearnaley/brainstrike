import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { Button } from '../button';
import { cn } from '../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';

export interface TooltipIconButtonProps extends ComponentPropsWithoutRef<typeof Button> {
  tooltip: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  asChild?: boolean;
}

// biome-ignore lint/nursery/noReactForwardRef: forwardRef required for ref forwarding to Button
export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  ({ children, tooltip, side = 'bottom', className, asChild = false, ...rest }, ref) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          {...rest}
          asChild={asChild}
          className={cn('size-6 p-1', className)}
          ref={ref}
        >
          {asChild ? (
            children
          ) : (
            <>
              {children}
              <span className="sr-only">{tooltip}</span>
            </>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>{tooltip}</TooltipContent>
    </Tooltip>
  )
);

TooltipIconButton.displayName = 'TooltipIconButton';
