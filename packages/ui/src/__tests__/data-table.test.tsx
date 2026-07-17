import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DataTableColumn } from '../data-table';
import { DataTable } from '../data-table';

vi.mock('../table-pagination', () => ({
  TablePagination: ({
    currentPage,
    onPageChange,
    totalPages,
  }: {
    currentPage: number;
    onPageChange: (page: number) => void;
    totalPages: number;
  }) => (
    <div>
      <span data-testid="pagination-state">{`page-${currentPage}`}</span>
      <button onClick={() => onPageChange(Math.min(currentPage + 1, totalPages - 1))} type="button">
        next-page
      </button>
    </div>
  ),
}));

interface Row {
  id: string;
  name: string;
  score: number;
}

const columns: DataTableColumn<Row>[] = [
  {
    cell: ({ row }) => row.name,
    header: ({ column }) => `Header-${column.id}`,
    id: 'name',
    sortable: true,
  },
  {
    cell: ({ row, rowIndex }) => `${row.score}:${rowIndex}`,
    className: 'score-cell',
    header: 'Score',
    id: 'score',
  },
];

const rows: Row[] = [
  { id: 'r-1', name: 'Alpha', score: 10 },
  { id: 'r-2', name: 'Beta', score: 20 },
];

describe('DataTable', () => {
  it('renders default and custom empty states', () => {
    const { rerender } = render(<DataTable<Row> columns={columns} data={[]} />);
    expect(screen.getByText('No data available')).toBeInTheDocument();

    rerender(<DataTable<Row> columns={columns} data={[]} emptyState="Nothing to show" />);
    expect(screen.getByText('Nothing to show')).toBeInTheDocument();
  });

  it('renders rows/headers and toggles sorting direction', () => {
    const onSortChange = vi.fn();

    render(
      <DataTable<Row>
        columns={columns}
        data={rows}
        sorting={{ enabled: true, onSortChange, sortColumn: null, sortDirection: null }}
      />
    );

    expect(screen.getByText('Header-name')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('10:0')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Header-name'));
    expect(onSortChange).toHaveBeenLastCalledWith('name', 'asc');
    expect(screen.getByText('↑')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Header-name'));
    expect(onSortChange).toHaveBeenLastCalledWith('name', 'desc');
    expect(screen.getByText('↓')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Header-name'));
    expect(onSortChange).toHaveBeenLastCalledWith('name', null);
  });

  it('supports pagination and expandable rows', () => {
    render(
      <DataTable<Row>
        columns={columns}
        data={rows}
        expandable={{
          enabled: true,
          expandedRows: new Set(['r-1']),
          renderExpandedContent: (row) => <div>{`expanded-${row.id}`}</div>,
        }}
        getRowId={(row) => row.id}
        pagination={{ enabled: true, pageSize: 1 }}
      />
    );

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('expanded-r-1')).toBeInTheDocument();
    expect(screen.getByTestId('pagination-state')).toHaveTextContent('page-0');

    fireEvent.click(screen.getByText('next-page'));

    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByTestId('pagination-state')).toHaveTextContent('page-1');
  });
});
