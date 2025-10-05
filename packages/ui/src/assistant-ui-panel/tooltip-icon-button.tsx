import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { Button } from '../button';
import { cn } from '../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';

export interface TooltipIconButtonProps extends ComponentPropsWithoutRef<typeof Button> {
  tooltip: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  asChild?: boolean;
}

export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  ({ children, tooltip, side = 'bottom', className, asChild = false, ...rest }, ref) => {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            {...rest}
            className={cn('size-6 p-1', className)}
            ref={ref}
            asChild={asChild}
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
    );
  }
);

TooltipIconButton.displayName = 'TooltipIconButton';
