import React, { type ComponentType, type ReactElement, type ReactNode } from 'react';
import { cn } from './lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

export interface NavigationItem {
  icon: ComponentType<{ className?: string }>;
  name: string;
  path: string;
}

export interface NavigationSidebarProps extends React.HTMLAttributes<HTMLElement> {
  ariaLabel?: string;
  children?: ReactNode;
  currentPath: string;
  items: NavigationItem[];
  onItemClick?: (path: string) => void;
}

/**
 * Navigation item base styles for consistent appearance across button and link variants.
 * Uses a vertical tab pattern with left border indicator for active state.
 */
const getNavItemStyles = (isActive: boolean): string =>
  cn(
    // Base layout and sizing
    'relative flex items-center justify-center',
    'h-12 w-12 rounded-lg',
    // Transitions for smooth interactions
    'transition-[transform,background-color,color] duration-200 ease-out',
    // Hover state - uses accent color for consistent look with theme toggle
    'hover:bg-accent hover:text-accent-foreground hover:shadow-sm',
    // Active press state
    'kinetic-depress',
    // Focus visible state for keyboard navigation
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar',
    // Active/selected state styling - prominent background for clear indication
    isActive && [
      'bg-accent text-accent-foreground',
      // Left border indicator for vertical tab effect
      'before:absolute before:top-1/2 before:left-0 before:-translate-y-1/2',
      'before:h-6 before:w-1 before:rounded-r-full before:bg-sidebar-primary',
      'shadow-md',
    ]
  );

const NavigationSidebar = React.memo(function NavigationSidebar({
  items,
  currentPath,
  children,
  className,
  ariaLabel = 'Main navigation',
  onItemClick,
  ...props
}: NavigationSidebarProps): ReactElement {
  return (
    <nav
      aria-label={ariaLabel || 'Main navigation'}
      className={cn(
        'flex h-full w-16 flex-col items-center gap-2 border-sidebar-border border-r bg-sidebar py-4',
        className
      )}
      {...props}
    >
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = currentPath === item.path;

        // If onItemClick is provided, render as button instead of link
        if (onItemClick) {
          return (
            <Tooltip key={item.name}>
              <TooltipTrigger asChild>
                <button
                  aria-current={isActive ? 'page' : undefined}
                  aria-label={item.name}
                  className={cn(getNavItemStyles(isActive), 'cursor-pointer')}
                  onClick={() => onItemClick(item.path)}
                  type="button"
                >
                  <Icon
                    aria-hidden="true"
                    className={cn(
                      'h-5 w-5 transition-transform duration-200',
                      isActive && 'scale-110'
                    )}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                <p className="font-medium">{item.name}</p>
              </TooltipContent>
            </Tooltip>
          );
        }

        // Default behavior: render as link
        return (
          <Tooltip key={item.name}>
            <TooltipTrigger asChild>
              <a
                aria-current={isActive ? 'page' : undefined}
                aria-label={item.name}
                className={getNavItemStyles(isActive)}
                href={item.path}
              >
                <Icon
                  aria-hidden="true"
                  className={cn(
                    'h-5 w-5 transition-transform duration-200',
                    isActive && 'scale-110'
                  )}
                />
              </a>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              <p className="font-medium">{item.name}</p>
            </TooltipContent>
          </Tooltip>
        );
      })}
      {children ? <div className="mt-auto flex flex-col items-center gap-2">{children}</div> : null}
    </nav>
  );
});
NavigationSidebar.displayName = 'NavigationSidebar';

export { NavigationSidebar };
