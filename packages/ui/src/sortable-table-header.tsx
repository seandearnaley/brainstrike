import { ArrowDown, ArrowUp } from 'lucide-react';
import { memo } from 'react';

type SortableTableHeaderProps<T> = {
  field: T;
  title: string;
  sortField?: T;
  sortDirection?: 'asc' | 'desc';
  onSort: (field: T) => void;
  className?: string;
};

function SortableTableHeaderComponent<T extends string | number | symbol>({
  field,
  title,
  sortField,
  sortDirection = 'asc',
  onSort,
  className = '',
}: SortableTableHeaderProps<T>) {
  const isActive = sortField === field;

  return (
    <th
      aria-sort={isActive ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`cursor-pointer bg-background px-4 py-2 text-left font-medium text-muted-foreground text-sm hover:text-foreground ${className}`}
      onClick={() => onSort(field)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSort(field);
        }
      }}
      scope="col"
    >
      <div className="flex items-center gap-1">
        {title}
        {isActive &&
          (sortDirection === 'asc' ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          ))}
      </div>
    </th>
  );
}

export const SortableTableHeader = memo(
  SortableTableHeaderComponent
) as typeof SortableTableHeaderComponent;
