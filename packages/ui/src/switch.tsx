import * as SwitchPrimitives from '@radix-ui/react-switch';
import type * as React from 'react';

import { cn } from './lib/utils';

const Switch = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> & {
  ref?: React.RefObject<HTMLButtonElement | null>;
}) => (
  <SwitchPrimitives.Root
    className={cn(
      'peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-transparent shadow-xs outline-hidden transition-[background-color,border-color,box-shadow,opacity] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80',
      className
    )}
    data-slot="switch"
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        'pointer-events-none block h-5 w-5 rounded-full bg-background ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground'
      )}
      data-slot="switch-thumb"
    />
  </SwitchPrimitives.Root>
);
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
