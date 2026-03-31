import * as LabelPrimitive from '@radix-ui/react-label';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from './lib/utils';

const labelVariants = cva(
  'flex select-none items-center gap-2 font-medium text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50 group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50'
);

const Label = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> &
  VariantProps<typeof labelVariants> & { ref?: React.RefObject<HTMLLabelElement | null> }) => (
  <LabelPrimitive.Root
    className={cn(labelVariants(), className)}
    data-slot="label"
    ref={ref}
    {...props}
  />
);
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
