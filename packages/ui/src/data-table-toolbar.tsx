import type { Table } from '@tanstack/react-table';
import { X } from 'lucide-react';
import { useState, useEffect } from 'react';
import { Button } from './button';
import { DataTableViewOptions } from './data-table-view-options';
import { Input } from './input';

interface DataTableToolbarProps<TData> {
  table: Table<TData>;
  children?: React.ReactNode;
}

export function DataTableToolbar<TData>({ table, children }: DataTableToolbarProps<TData>) {
  const isFiltered = table.getState().columnFilters.length > 0;
  const [globalFilter, setGlobalFilter] = useState((table.getState().globalFilter as string) ?? '');

  // Debounce global filter updates
  useEffect(() => {
    const timer = setTimeout(() => {
      table.setGlobalFilter(globalFilter);
    }, 200);

    return () => clearTimeout(timer);
  }, [globalFilter, table]);

  return (
    <div className="flex items-center justify-between">
      <div className="flex flex-1 items-center space-x-2">
        <Input
          placeholder="Search all columns..."
          value={globalFilter}
          onChange={(event) => setGlobalFilter(String(event.target.value))}
          className="h-8 w-[150px] lg:w-[250px]"
        />
        {isFiltered && (
          <Button
            variant="ghost"
            onClick={() => table.resetColumnFilters()}
            className="h-8 px-2 lg:px-3"
          >
            Reset
            <X className="ml-2 h-4 w-4" />
          </Button>
        )}
        {children}
      </div>
      <div className="flex items-center space-x-2">
        <DataTableViewOptions table={table} />
      </div>
    </div>
  );
}
