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
}

export function NavigationSidebar({
  items,
  currentPath,
  children,
  className,
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
