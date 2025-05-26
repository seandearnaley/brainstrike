import type { ComponentType, ReactElement, ReactNode } from 'react';
import { cn } from './lib/utils';

export interface NavigationItem {
  name: string;
  icon: ComponentType<{ className?: string }>;
  path: string;
}

export interface NavigationSidebarProps extends React.HTMLAttributes<HTMLElement> {
  items: NavigationItem[];
  currentPath: string;
  children?: ReactNode;
  onItemClick?: (path: string) => void;
}

export function NavigationSidebar({
  items,
  currentPath,
  children,
  className,
  onItemClick,
  ...props
}: NavigationSidebarProps): ReactElement {
  return (
    <aside
      className={cn(
        'w-16 bg-gray-100 dark:bg-gray-800 h-full flex flex-col items-center py-4 space-y-4',
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
              key={item.name}
              type="button"
              onClick={() => onItemClick(item.path)}
              className={cn(
                'p-2 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors',
                currentPath === item.path && 'bg-gray-200 dark:bg-gray-700',
                'cursor-pointer'
              )}
              title={item.name}
            >
              <Icon className="w-6 h-6" />
            </button>
          );
        }

        // Default behavior: render as link
        return (
          <a
            key={item.name}
            href={item.path}
            className={cn(
              'p-2 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors',
              currentPath === item.path && 'bg-gray-200 dark:bg-gray-700'
            )}
            title={item.name}
          >
            <Icon className="w-6 h-6" />
          </a>
        );
      })}
      {children ? <div className="mt-auto">{children}</div> : null}
    </aside>
  );
}
