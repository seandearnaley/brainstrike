import * as TabsPrimitive from '@radix-ui/react-tabs';
import type * as React from 'react';

import { cn } from './lib/utils';

const Tabs = TabsPrimitive.Root;

/**
 * Compact trigger sizing shared by panel-header tab strips (Library,
 * Explorer|Search). Keeps every left/right panel on one segmented idiom
 * instead of per-surface bespoke tab styles.
 */
const PANEL_TAB_TRIGGER_CLASS_NAME = 'min-w-0 gap-1.5 px-2 text-xs';

const TabsList = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <TabsPrimitive.List
    className={cn(
      'inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground',
      className
    )}
    data-slot="tabs-list"
    ref={ref}
    {...props}
  />
);
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & {
  ref?: React.RefObject<HTMLButtonElement | null>;
}) => (
  <TabsPrimitive.Trigger
    className={cn(
      'kinetic-depress inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-3 py-1.5 font-medium text-sm outline-hidden transition-[color,background-color,border-color,box-shadow,opacity,transform] focus-visible:border-ring focus-visible:outline-1 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-xs dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 [&_svg:not([class*=size-])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0',
      className
    )}
    data-slot="tabs-trigger"
    ref={ref}
    {...props}
  />
);
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <TabsPrimitive.Content
    className={cn(
      'flex-1 outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50',
      className
    )}
    data-slot="tabs-content"
    ref={ref}
    {...props}
  />
);
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { PANEL_TAB_TRIGGER_CLASS_NAME, Tabs, TabsContent, TabsList, TabsTrigger };
