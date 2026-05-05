import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import type * as React from 'react';

import { cn } from './lib/utils';

const Checkbox = ({
  className,
  checked,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> & {
  ref?: React.RefObject<React.ElementRef<typeof CheckboxPrimitive.Root> | null>;
}) => (
  <CheckboxPrimitive.Root
    className={cn(
      'group peer size-4 shrink-0 cursor-pointer rounded-[4px] border border-input shadow-xs outline-hidden transition-shadow focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=checked]:border-primary data-[state=indeterminate]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:text-primary-foreground dark:bg-input/30 dark:data-[state=checked]:bg-primary dark:data-[state=indeterminate]:bg-primary dark:aria-invalid:ring-destructive/40',
      className
    )}
    data-slot="checkbox"
    ref={ref}
    {...(checked === undefined ? {} : { checked })}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className={cn('grid place-content-center text-current transition-none')}
      data-slot="checkbox-indicator"
    >
      <Check className="size-3.5 group-data-[state=indeterminate]:hidden" />
      <Minus className="hidden size-3.5 group-data-[state=indeterminate]:block" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
);

Checkbox.displayName = 'Checkbox';

export { Checkbox };
