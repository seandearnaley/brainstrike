import {
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnSizingState,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  type Table,
  type VisibilityState,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useCallback, useMemo, useState } from 'react';

export interface UseDataTableProps<TData> {
  data: TData[];
  columns: ColumnDef<TData, unknown>[];
  pageCount?: number;
  initialState?: {
    sorting?: SortingState;
    columnFilters?: ColumnFiltersState;
    columnVisibility?: VisibilityState;
    rowSelection?: RowSelectionState;
    pagination?: PaginationState;
    columnSizing?: ColumnSizingState;
  };
  getRowId?: (originalRow: TData, index: number) => string;
  enableRowSelection?: boolean;
  enableMultiRowSelection?: boolean;
  enableColumnResizing?: boolean;
  columnResizeMode?: 'onChange' | 'onEnd';
  onRowSelectionChange?: (rowSelection: RowSelectionState) => void;
}

export interface UseDataTableReturn<TData> {
  table: Table<TData>;
  selectedRows: TData[];
  isAllRowsSelected: boolean;
  isSomeRowsSelected: boolean;
  toggleAllRowsSelected: () => void;
  resetRowSelection: () => void;
}

export function useDataTable<TData>({
  data,
  columns,
  pageCount,
  initialState,
  getRowId,
  enableRowSelection = true,
  enableMultiRowSelection = true,
  enableColumnResizing = false,
  columnResizeMode = 'onChange',
  onRowSelectionChange,
}: UseDataTableProps<TData>): UseDataTableReturn<TData> {
  const [sorting, setSorting] = useState<SortingState>(initialState?.sorting ?? []);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(
    initialState?.columnFilters ?? []
  );
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    initialState?.columnVisibility ?? {}
  );
  const [rowSelection, setRowSelection] = useState<RowSelectionState>(
    initialState?.rowSelection ?? {}
  );
  const [pagination, setPagination] = useState<PaginationState>(
    initialState?.pagination ?? {
      pageIndex: 0,
      pageSize: 10,
    }
  );
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(
    initialState?.columnSizing ?? {}
  );

  const handleRowSelectionChange = useCallback(
    (updaterOrValue: RowSelectionState | ((old: RowSelectionState) => RowSelectionState)) => {
      setRowSelection((prev) => {
        const newSelection =
          typeof updaterOrValue === 'function' ? updaterOrValue(prev) : updaterOrValue;
        onRowSelectionChange?.(newSelection);
        return newSelection;
      });
    },
    [onRowSelectionChange]
  );

  const table = useReactTable({
    data,
    columns,
    ...(pageCount !== undefined && { pageCount }),
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: handleRowSelectionChange,
    onPaginationChange: setPagination,
    onColumnSizingChange: setColumnSizing,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
      pagination,
      columnSizing,
    },
    enableRowSelection,
    enableMultiRowSelection,
    enableColumnResizing,
    columnResizeMode,
    ...(getRowId && { getRowId }),
    manualPagination: pageCount !== undefined,
  });

  const selectedRows = useMemo(() => {
    return table.getFilteredSelectedRowModel().rows.map((row) => row.original);
  }, [table]);

  const isAllRowsSelected = useMemo(() => {
    const totalRows = table.getFilteredRowModel().rows.length;
    return totalRows > 0 && Object.keys(rowSelection).length === totalRows;
  }, [table, rowSelection]);

  const isSomeRowsSelected = useMemo(() => {
    return Object.keys(rowSelection).length > 0 && !isAllRowsSelected;
  }, [rowSelection, isAllRowsSelected]);

  const toggleAllRowsSelected = useCallback(() => {
    table.toggleAllRowsSelected();
  }, [table]);

  const resetRowSelection = useCallback(() => {
    table.resetRowSelection();
  }, [table]);

  return {
    table,
    selectedRows,
    isAllRowsSelected,
    isSomeRowsSelected,
    toggleAllRowsSelected,
    resetRowSelection,
  };
}
