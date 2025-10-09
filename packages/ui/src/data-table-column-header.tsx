import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import type * as React from 'react';
import { cn } from './lib/utils';

export interface DataTableColumnHeaderProps extends React.HTMLAttributes<HTMLButtonElement> {
  title: string;
  sortable?: boolean;
  sortDirection?: 'asc' | 'desc' | null;
  onSort?: () => void;
}

export function DataTableColumnHeader({
  title,
  sortable = false,
  sortDirection = null,
  onSort,
  className,
  ...props
}: DataTableColumnHeaderProps) {
  if (!sortable) {
    return <div className={cn('font-medium', className)}>{title}</div>;
  }

  return (
    <button
      type="button"
      className={cn(
        'flex items-center gap-2 cursor-pointer select-none hover:text-foreground bg-transparent border-none p-0 font-inherit',
        className
      )}
      onClick={onSort}
      {...props}
    >
      <span className="font-medium">{title}</span>
      {sortDirection === 'asc' ? (
        <ArrowUp className="h-3.5 w-3.5" />
      ) : sortDirection === 'desc' ? (
        <ArrowDown className="h-3.5 w-3.5" />
      ) : (
        <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
      )}
    </button>
  );
}
