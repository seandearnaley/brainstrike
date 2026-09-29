import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ComponentProps, createContext, type ReactElement, use, useState } from 'react';

import { cn } from './lib/utils';

/**
 * The fixed view switcher: a segmented control over a fixed set of views
 * (Library, Explorer|Search, Git Changes|History, Settings Tools). Rules live in
 * docs/agents/ui-conventions.md § VIEW SWITCHERS (Tabs).
 *
 * Every class below is a literal: Tailwind emits only what its scanner sees.
 */

/**
 * The committed value, for `TabsContent`, which owns panel visibility. Radix
 * keeps its own copy private, so `Tabs` always controls Radix and publishes the
 * value here.
 */
const TabsValueContext = createContext<string | null>(null);

type TabsProps = ComponentProps<typeof TabsPrimitive.Root>;

/** Manual activation by default: arrows move focus, Enter or Space selects. */
function Tabs({
  activationMode = 'manual',
  defaultValue,
  onValueChange,
  value,
  ...props
}: TabsProps): ReactElement {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue ?? '');
  const currentValue = value ?? uncontrolledValue;

  const handleValueChange = (nextValue: string): void => {
    if (value === undefined) {
      setUncontrolledValue(nextValue);
    }
    onValueChange?.(nextValue);
  };

  return (
    <TabsValueContext value={currentValue}>
      <TabsPrimitive.Root
        activationMode={activationMode}
        data-slot="tabs"
        onValueChange={handleValueChange}
        value={currentValue}
        {...props}
      />
    </TabsValueContext>
  );
}

const tabsListVariants = cva(
  'inline-flex items-center justify-center rounded-md bg-muted p-0.5 text-muted-foreground',
  {
    defaultVariants: { size: 'md' },
    variants: {
      size: {
        md: 'h-9',
        sm: 'h-7',
      },
    },
  }
);

type TabsSize = NonNullable<VariantProps<typeof tabsListVariants>['size']>;

const TabsSizeContext = createContext<TabsSize>('md');

/**
 * `sm` sits in a 36px panel header; `md` is for full pages. The list publishes
 * its size so every trigger paints the matching geometry.
 */
function TabsList({
  className,
  size = 'md',
  ...props
}: ComponentProps<typeof TabsPrimitive.List> & { readonly size?: TabsSize }): ReactElement {
  return (
    <TabsSizeContext value={size}>
      <TabsPrimitive.List
        className={cn(tabsListVariants({ size }), className)}
        data-size={size}
        data-slot="tabs-list"
        {...props}
      />
    </TabsSizeContext>
  );
}

/**
 * State changes colour only, never weight, so widths never jitter. The
 * compound `focus-visible:data-[state=active]:` pair exists because `data-*`
 * variants sort after `focus-visible`, so the selected ring would otherwise
 * repaint over the focus ring on the active trigger.
 */
const tabsTriggerVariants = cva(
  'inline-flex min-w-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[calc(var(--radius-md)-2px)] font-medium text-muted-foreground outline-hidden transition-[color,background-color,box-shadow,opacity] duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-pending:bg-background/50 data-[state=active]:text-foreground data-pending:text-foreground data-[state=active]:shadow-xs data-[state=active]:ring-1 data-[state=active]:ring-border/70 focus-visible:data-[state=active]:ring-2 focus-visible:data-[state=active]:ring-ring motion-reduce:transition-none [&_svg:not([class*=size-])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    defaultVariants: { size: 'md' },
    variants: {
      size: {
        md: 'h-8 px-4 text-sm',
        sm: 'h-6 px-2 text-xs [&_svg:not([class*=size-])]:size-3.5',
      },
    },
  }
);

function TabsTrigger({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Trigger>): ReactElement {
  const size = use(TabsSizeContext);
  return (
    <TabsPrimitive.Trigger
      className={cn(tabsTriggerVariants({ size }), className)}
      data-size={size}
      data-slot="tabs-trigger"
      {...props}
    />
  );
}

interface TabsContentProps
  extends Omit<ComponentProps<typeof TabsPrimitive.Content>, 'forceMount'> {
  /** Mount now, before the first activation (a preloaded panel). */
  readonly forceMount?: boolean;
  /**
   * Mount on first activation, then never unmount: an inactive panel stays
   * mounted and `hidden`, so its state survives switches.
   */
  readonly keepMounted?: boolean;
}

/**
 * Owns panel visibility instead of Radix `Presence`, which marks an incoming
 * panel present in a layout effect: a sync update that renders the panel after
 * a transition commits. Here children render in the switch's own render.
 *
 * An inactive panel is always `hidden`. Children render while active; with
 * `forceMount` they render at once (a preloaded panel); with `keepMounted`
 * they stay rendered once mounted.
 */
function TabsContent({
  children,
  className,
  forceMount = false,
  keepMounted = false,
  ...props
}: TabsContentProps): ReactElement {
  const activeValue = use(TabsValueContext);
  const [hasMounted, setHasMounted] = useState(false);
  if (activeValue === null) {
    throw new Error('TabsContent must be rendered inside @brainstrike/ui Tabs');
  }

  const isActive = activeValue === props.value;
  const mounted = isActive || forceMount || (keepMounted && hasMounted);
  if (keepMounted && mounted && !hasMounted) {
    // Latch during render (React's "state from previous renders" pattern).
    setHasMounted(true);
  }

  return (
    <TabsPrimitive.Content
      className={cn(
        'flex-1 outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className
      )}
      data-slot="tabs-content"
      {...props}
      forceMount
      hidden={!isActive}
    >
      {mounted ? children : null}
    </TabsPrimitive.Content>
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
