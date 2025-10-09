import * as React from 'react';
import { cn } from './lib/utils';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';
import { TablePagination } from './table-pagination';

export interface DataTableColumn<TData> {
  id: string;
  header?: React.ReactNode | ((props: { column: DataTableColumn<TData> }) => React.ReactNode);
  cell: (props: { row: TData; rowIndex: number }) => React.ReactNode;
  accessorFn?: (row: TData) => unknown;
  sortable?: boolean;
  className?: string;
  headerClassName?: string;
}

export interface DataTableProps<TData> {
  columns: DataTableColumn<TData>[];
  data: TData[];
  getRowId?: (row: TData, index: number) => string;
  maxHeight?: string;
  pagination?: {
    enabled: boolean;
    pageSize?: number;
  };
  sorting?: {
    enabled: boolean;
    onSortChange?: (columnId: string, direction: 'asc' | 'desc' | null) => void;
    sortColumn?: string | null;
    sortDirection?: 'asc' | 'desc' | null;
  };
  expandable?: {
    enabled: boolean;
    expandedRows?: Set<string>;
    onToggleExpand?: (rowId: string) => void;
    renderExpandedContent?: (row: TData) => React.ReactNode;
  };
  emptyState?: React.ReactNode;
  className?: string;
}

export function DataTable<TData>({
  columns,
  data,
  getRowId = (_, index) => String(index),
  maxHeight = '400px',
  pagination,
  sorting,
  expandable,
  emptyState,
  className,
}: DataTableProps<TData>) {
  const [currentPage, setCurrentPage] = React.useState(0);
  const [sortColumn, setSortColumn] = React.useState<string | null>(sorting?.sortColumn ?? null);
  const [sortDirection, setSortDirection] = React.useState<'asc' | 'desc' | null>(
    sorting?.sortDirection ?? null
  );

  const pageSize = pagination?.pageSize ?? 50;
  const isPaginationEnabled = pagination?.enabled ?? false;

  // Calculate paginated data
  const paginatedData = React.useMemo(() => {
    if (!isPaginationEnabled) return data;
    const start = currentPage * pageSize;
    return data.slice(start, start + pageSize);
  }, [data, currentPage, pageSize, isPaginationEnabled]);

  const totalPages = Math.ceil(data.length / pageSize);

  const handleSort = React.useCallback(
    (columnId: string) => {
      if (!sorting?.enabled) return;

      let newDirection: 'asc' | 'desc' | null = 'asc';

      if (sortColumn === columnId) {
        if (sortDirection === 'asc') {
          newDirection = 'desc';
        } else if (sortDirection === 'desc') {
          newDirection = null;
        }
      }

      setSortColumn(newDirection ? columnId : null);
      setSortDirection(newDirection);
      sorting.onSortChange?.(columnId, newDirection);
    },
    [sorting, sortColumn, sortDirection]
  );

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
        {emptyState || 'No data available'}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col', className)}>
      <div className="overflow-auto border rounded-md" style={{ maxHeight }}>
        <Table>
          <TableHeader className="sticky top-0 bg-background z-10">
            <TableRow>
              {columns.map((column) => (
                <TableHead
                  key={column.id}
                  className={cn(
                    column.headerClassName,
                    sorting?.enabled && column.sortable && 'cursor-pointer select-none'
                  )}
                  onClick={() => column.sortable && handleSort(column.id)}
                >
                  {typeof column.header === 'function'
                    ? column.header({ column })
                    : column.header || column.id}
                  {sorting?.enabled && column.sortable && sortColumn === column.id && (
                    <span className="ml-2 text-xs">
                      {sortDirection === 'asc' ? '↑' : sortDirection === 'desc' ? '↓' : ''}
                    </span>
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedData.map((row, index) => {
              const rowId = getRowId(row, index);
              const isExpanded = expandable?.expandedRows?.has(rowId) ?? false;

              return (
                <React.Fragment key={rowId}>
                  <TableRow>
                    {columns.map((column) => (
                      <TableCell key={column.id} className={column.className}>
                        {column.cell({ row, rowIndex: index })}
                      </TableCell>
                    ))}
                  </TableRow>
                  {expandable?.enabled && isExpanded && expandable.renderExpandedContent && (
                    <TableRow>
                      <TableCell colSpan={columns.length} className="p-0">
                        {expandable.renderExpandedContent(row)}
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {isPaginationEnabled && totalPages > 1 && (
        <TablePagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={data.length}
          onPageChange={setCurrentPage}
        />
      )}
    </div>
  );
}
