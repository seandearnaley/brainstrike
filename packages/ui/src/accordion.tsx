import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronDown } from 'lucide-react';
import type * as React from 'react';

import { cn } from './lib/utils';

const Accordion = AccordionPrimitive.Root;

const AccordionItem = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <AccordionPrimitive.Item
    className={cn('border-b last:border-b-0', className)}
    data-slot="accordion-item"
    ref={ref}
    {...props}
  />
);
AccordionItem.displayName = 'AccordionItem';

const AccordionTrigger = ({
  className,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger> & {
  ref?: React.RefObject<HTMLButtonElement | null>;
}) => (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger
      className={cn(
        'focus-visible:border-ring focus-visible:ring-ring/50 flex flex-1 cursor-pointer items-start justify-between gap-4 rounded-md py-4 text-left text-sm font-medium outline-hidden transition-[color,opacity,box-shadow,border-color] hover:underline focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180',
        className
      )}
      data-slot="accordion-trigger"
      ref={ref}
      {...props}
    >
      {children}
      <ChevronDown className="text-muted-foreground pointer-events-none size-4 shrink-0 translate-y-0.5 transition-transform duration-200" />
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
);
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

const AccordionContent = ({
  className,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <AccordionPrimitive.Content
    className="data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden text-sm"
    data-slot="accordion-content"
    ref={ref}
    {...props}
  >
    <div className={cn('pt-0 pb-4', className)}>{children}</div>
  </AccordionPrimitive.Content>
);

AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger };
