import React, { type ComponentType, type ReactElement, type ReactNode } from 'react';
import { cn } from './lib/utils';

export type NavigationItem = {
  name: string;
  icon: ComponentType<{ className?: string }>;
  path: string;
};

export interface NavigationSidebarProps extends React.HTMLAttributes<HTMLElement> {
  items: NavigationItem[];
  currentPath: string;
  children?: ReactNode;
  ariaLabel?: string;
  onItemClick?: (path: string) => void;
}

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
        'flex h-full w-16 flex-col items-center space-y-4 border-sidebar-border border-r bg-sidebar py-4',
        className
      )}
      {...props}
    >
      {items.map((item) => {
        const Icon = item.icon;

        // If onItemClick is provided, render as button instead of link
        if (onItemClick) {
          return (
            <button
              aria-label={item.name}
              className={cn(
                'rounded-md p-2 transition-all duration-150',
                'hover:bg-sidebar-accent active:scale-95',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1',
                currentPath === item.path && 'bg-sidebar-accent text-sidebar-primary',
                'cursor-pointer'
              )}
              key={item.name}
              onClick={() => onItemClick(item.path)}
              title={item.name}
              type="button"
            >
              <Icon className="h-6 w-6" />
            </button>
          );
        }

        // Default behavior: render as link
        return (
          <a
            aria-label={item.name}
            className={cn(
              'rounded-md p-2 transition-all duration-150',
              'hover:bg-sidebar-accent active:scale-95',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1',
              currentPath === item.path && 'bg-sidebar-accent text-sidebar-primary'
            )}
            href={item.path}
            key={item.name}
            title={item.name}
          >
            <Icon className="h-6 w-6" />
          </a>
        );
      })}
      {children ? <div className="mt-auto">{children}</div> : null}
    </nav>
  );
});
NavigationSidebar.displayName = 'NavigationSidebar';

export { NavigationSidebar };
