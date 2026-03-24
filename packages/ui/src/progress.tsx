import type * as React from 'react';
// import * as ProgressPrimitive from '@radix-ui/react-progress'; // Removed: Unused
import { cn } from './lib/utils';

const Progress = ({
  className,
  value,
  ref,
  ...props
}: Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'aria-valuemax' | 'aria-valuemin' | 'aria-valuenow' | 'role'
> & {
  value?: number;
} & { ref?: React.RefObject<HTMLDivElement | null> }) => (
  <div
    {...props}
    aria-valuemax={100}
    aria-valuemin={0}
    aria-valuenow={value}
    className={cn('relative h-2 w-full overflow-hidden rounded-full bg-secondary', className)}
    ref={ref}
    role="progressbar"
  >
    <div
      className="h-full w-full flex-1 bg-primary transition-transform"
      style={{
        transform: `translateX(-${100 - (value || 0)}%)`,
      }}
    />
  </div>
);
Progress.displayName = 'Progress';

export { Progress };
