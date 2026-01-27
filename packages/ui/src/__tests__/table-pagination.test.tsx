import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TablePagination } from '../table-pagination';

describe('TablePagination', () => {
  it('renders item range and page input', () => {
    render(
      <TablePagination currentPage={1} onPageChange={vi.fn()} totalItems={30} totalPages={3} />
    );

    // Shows item range (items 11-20 for page 2 with default pageSize of 50, capped at totalItems)
    expect(screen.getByText(/11-20 of 30/)).toBeInTheDocument();

    // Has page input showing current page
    const pageInput = screen.getByRole('spinbutton', { name: 'Page number' });
    expect(pageInput).toHaveValue(2); // 0-indexed internally, display is 1-indexed

    // Shows "of 3" total pages
    expect(screen.getByText('of 3')).toBeInTheDocument();
  });

  it('calls onPageChange when navigation buttons clicked', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    const { rerender } = render(
      <TablePagination currentPage={0} onPageChange={onPageChange} totalItems={30} totalPages={3} />
    );

    // Click next page
    await user.click(screen.getByRole('button', { name: 'Go to next page' }));
    expect(onPageChange).toHaveBeenCalledWith(1);

    onPageChange.mockClear();
    rerender(
      <TablePagination currentPage={1} onPageChange={onPageChange} totalItems={30} totalPages={3} />
    );

    // Click last page
    await user.click(screen.getByRole('button', { name: 'Go to last page' }));
    expect(onPageChange).toHaveBeenCalledWith(2);

    onPageChange.mockClear();
    rerender(
      <TablePagination currentPage={1} onPageChange={onPageChange} totalItems={30} totalPages={3} />
    );

    // Click previous page
    await user.click(screen.getByRole('button', { name: 'Go to previous page' }));
    expect(onPageChange).toHaveBeenCalledWith(0);
  });

  it('calls onPageChange when page input is changed', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <TablePagination currentPage={0} onPageChange={onPageChange} totalItems={30} totalPages={3} />
    );

    const pageInput = screen.getByRole('spinbutton', { name: 'Page number' });

    // Clear and type new page number
    await user.clear(pageInput);
    await user.type(pageInput, '3');
    await user.tab(); // Trigger blur

    expect(onPageChange).toHaveBeenCalledWith(2); // 0-indexed
  });

  it('disables navigation buttons at bounds', () => {
    const { rerender } = render(
      <TablePagination currentPage={0} onPageChange={vi.fn()} totalItems={20} totalPages={2} />
    );

    // At first page: first and previous disabled
    expect(screen.getByRole('button', { name: 'Go to first page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Go to previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Go to next page' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Go to last page' })).not.toBeDisabled();

    rerender(
      <TablePagination currentPage={1} onPageChange={vi.fn()} totalItems={20} totalPages={2} />
    );

    // At last page: next and last disabled
    expect(screen.getByRole('button', { name: 'Go to first page' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Go to previous page' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Go to next page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Go to last page' })).toBeDisabled();
  });

  it('does not render when only one page and no page size change', () => {
    const { container } = render(
      <TablePagination currentPage={0} onPageChange={vi.fn()} totalItems={10} totalPages={1} />
    );

    expect(container.firstChild).toBeNull();
  });

  it('renders page size selector when onPageSizeChange provided', () => {
    render(
      <TablePagination
        currentPage={0}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
        pageSize={25}
        totalItems={100}
        totalPages={4}
      />
    );

    expect(screen.getByText('Show')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Items per page' })).toBeInTheDocument();
  });

  // Skip: Radix Select has jsdom compatibility issues (hasPointerCapture not implemented).
  // The callback wiring is tested via integration tests.
  // biome-ignore lint/suspicious/noSkippedTests: Radix Select requires browser environment
  it.skip('calls onPageSizeChange when page size changed', async () => {
    const user = userEvent.setup();
    const onPageSizeChange = vi.fn();
    render(
      <TablePagination
        currentPage={0}
        onPageChange={vi.fn()}
        onPageSizeChange={onPageSizeChange}
        pageSize={25}
        totalItems={100}
        totalPages={4}
      />
    );

    // Open the select dropdown
    const selectTrigger = screen.getByRole('combobox', { name: 'Items per page' });
    await user.click(selectTrigger);

    // Select 50 - Radix puts options in a portal, use findByRole for async lookup
    const option = await screen.findByRole('option', { name: '50' });
    await user.click(option);

    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });

  it('clamps page input to valid range', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <TablePagination currentPage={0} onPageChange={onPageChange} totalItems={30} totalPages={3} />
    );

    const pageInput = screen.getByRole('spinbutton', { name: 'Page number' });

    // Try to enter a page number higher than max
    await user.clear(pageInput);
    await user.type(pageInput, '10');
    await user.tab();

    // Should clamp to max page (3)
    expect(onPageChange).toHaveBeenCalledWith(2); // 0-indexed, so page 3 = index 2
  });

  it('shows empty state when no items', () => {
    render(
      <TablePagination
        currentPage={0}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
        pageSize={50}
        totalItems={0}
        totalPages={0}
      />
    );

    expect(screen.getByText('No items')).toBeInTheDocument();
  });
});
