import * as ProgressPrimitive from '@radix-ui/react-progress';
import type * as React from 'react';

import { cn } from './lib/utils';

type ProgressProps = React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & {
  ref?: React.RefObject<HTMLDivElement | null>;
};

const Progress = ({
  className,
  value,
  ref,
  // Stripped: Radix ProgressPrimitive manages these internally
  'aria-valuemax': _ariaValueMax,
  'aria-valuemin': _ariaValueMin,
  'aria-valuenow': _ariaValueNow,
  role: _role,
  ...props
}: ProgressProps) => (
  <ProgressPrimitive.Root
    className={cn('relative h-2 w-full overflow-hidden rounded-full bg-primary/20', className)}
    data-slot="progress"
    ref={ref}
    value={value}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className="h-full w-full flex-1 bg-primary transition-all"
      data-slot="progress-indicator"
      style={{
        transform: `translateX(-${100 - (value ?? 0)}%)`,
      }}
    />
  </ProgressPrimitive.Root>
);
Progress.displayName = 'Progress';

export { Progress };
