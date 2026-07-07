import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SortableTableHeader } from '../sortable-table-header';

function renderHeader(props: Parameters<typeof SortableTableHeader>[0]) {
  return render(
    <table>
      <thead>
        <tr>
          <SortableTableHeader {...props} />
        </tr>
      </thead>
    </table>
  );
}

describe('SortableTableHeader', () => {
  it('applies aria-sort and icon based on sort state', () => {
    const { rerender } = renderHeader({
      field: 'name',
      onSort: vi.fn(),
      sortDirection: 'asc',
      sortField: 'name',
      title: 'Name',
    });

    const header = screen.getByRole('columnheader', { name: 'Name' });
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    expect(header.querySelector('svg')).toBeInTheDocument();

    rerender(
      <table>
        <thead>
          <tr>
            <SortableTableHeader
              field="name"
              onSort={vi.fn()}
              sortDirection="desc"
              sortField="name"
              title="Name"
            />
          </tr>
        </thead>
      </table>
    );
    expect(header).toHaveAttribute('aria-sort', 'descending');
  });

  it('triggers onSort on click and keyboard events', async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    renderHeader({ field: 'name', onSort, title: 'Name' });

    const header = screen.getByRole('columnheader', { name: 'Name' });
    await user.click(header);
    expect(onSort).toHaveBeenCalledWith('name');

    onSort.mockClear();
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(onSort).toHaveBeenCalledWith('name');

    onSort.mockClear();
    header.focus();
    fireEvent.keyDown(header, { key: ' ' });
    expect(onSort).toHaveBeenCalledWith('name');
  });
});
