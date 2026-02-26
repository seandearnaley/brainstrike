import * as React from 'react';
import { cn } from './lib/utils';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';
import { TablePagination } from './table-pagination';

const defaultGetRowId = (_: unknown, index: number) => String(index);

function ExpandedRowContent({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export interface DataTableColumn<TData> {
  accessorFn?: (row: TData) => unknown;
  cell: (props: { row: TData; rowIndex: number }) => React.ReactNode;
  className?: string;
  header?: React.ReactNode | ((props: { column: DataTableColumn<TData> }) => React.ReactNode);
  headerClassName?: string;
  id: string;
  sortable?: boolean;
}

export interface DataTableProps<TData> {
  className?: string;
  columns: DataTableColumn<TData>[];
  data: TData[];
  emptyState?: React.ReactNode;
  expandable?: {
    enabled: boolean;
    expandedRows?: Set<string>;
    onToggleExpand?: (rowId: string) => void;
    renderExpandedContent?: (row: TData) => React.ReactNode;
  };
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
}

export function DataTable<TData>({
  columns,
  data,
  getRowId = defaultGetRowId,
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
    if (!isPaginationEnabled) {
      return data;
    }
    const start = currentPage * pageSize;
    return data.slice(start, start + pageSize);
  }, [data, currentPage, pageSize, isPaginationEnabled]);

  const totalPages = Math.ceil(data.length / pageSize);

  const handleSort = React.useCallback(
    (columnId: string) => {
      if (!sorting?.enabled) {
        return;
      }

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
      <div className="flex h-32 items-center justify-center text-muted-foreground text-sm">
        {emptyState || 'No data available'}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col', className)}>
      <div className="overflow-auto rounded-md border" style={{ maxHeight }}>
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              {columns.map((column) => (
                <TableHead
                  className={cn(
                    column.headerClassName,
                    sorting?.enabled && column.sortable && 'cursor-pointer select-none'
                  )}
                  key={column.id}
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
              const expandedContent =
                expandable?.enabled && isExpanded && expandable.renderExpandedContent
                  ? expandable.renderExpandedContent(row)
                  : null;

              return (
                <React.Fragment key={rowId}>
                  <TableRow>
                    {columns.map((column) => (
                      <TableCell className={column.className} key={column.id}>
                        {column.cell({ row, rowIndex: index })}
                      </TableCell>
                    ))}
                  </TableRow>
                  {expandedContent && (
                    <TableRow>
                      <TableCell className="p-0" colSpan={columns.length}>
                        <ExpandedRowContent>{expandedContent}</ExpandedRowContent>
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
          onPageChange={setCurrentPage}
          pageSize={pageSize}
          totalItems={data.length}
          totalPages={totalPages}
        />
      )}
    </div>
  );
}
