import type { ComponentPropsWithoutRef, Ref } from 'react';
import { Button } from '../button';
import { cn } from '../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';

export interface TooltipIconButtonProps extends ComponentPropsWithoutRef<typeof Button> {
  asChild?: boolean;
  side?: 'top' | 'bottom' | 'left' | 'right';
  tooltip: string;
}

export const TooltipIconButton = ({
  children,
  tooltip,
  side = 'bottom',
  className,
  asChild = false,
  ref,
  ...rest
}: TooltipIconButtonProps & { ref?: Ref<HTMLButtonElement> }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button
        aria-label={tooltip}
        size="icon"
        variant="ghost"
        {...rest}
        asChild={asChild}
        className={cn('size-6 p-1', className)}
        ref={ref}
      >
        {children}
      </Button>
    </TooltipTrigger>
    <TooltipContent side={side}>{tooltip}</TooltipContent>
  </Tooltip>
);

TooltipIconButton.displayName = 'TooltipIconButton';
