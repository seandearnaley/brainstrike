import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TablePagination } from '../table-pagination';

describe('TablePagination', () => {
  it('renders page info and numbers', () => {
    render(
      <TablePagination currentPage={1} totalPages={3} totalItems={30} onPageChange={vi.fn()} />
    );

    expect(screen.getByText('Page 2 of 3 (30 total items)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3' })).toBeInTheDocument();
  });

  it('calls onPageChange when navigation buttons clicked', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    const { rerender } = render(
      <TablePagination currentPage={0} totalPages={3} totalItems={30} onPageChange={onPageChange} />
    );

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenCalledWith(1);

    onPageChange.mockClear();
    rerender(
      <TablePagination currentPage={1} totalPages={3} totalItems={30} onPageChange={onPageChange} />
    );
    await user.click(screen.getByRole('button', { name: '3' }));
    expect(onPageChange).toHaveBeenCalledWith(2);

    onPageChange.mockClear();
    rerender(
      <TablePagination currentPage={1} totalPages={3} totalItems={30} onPageChange={onPageChange} />
    );
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onPageChange).toHaveBeenCalledWith(0);
  });

  it('disables previous and next buttons at bounds', () => {
    const { rerender } = render(
      <TablePagination currentPage={0} totalPages={2} totalItems={20} onPageChange={vi.fn()} />
    );

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();

    rerender(
      <TablePagination currentPage={1} totalPages={2} totalItems={20} onPageChange={vi.fn()} />
    );

    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('does not render when only one page', () => {
    const { container } = render(
      <TablePagination currentPage={0} totalPages={1} totalItems={10} onPageChange={vi.fn()} />
    );

    expect(container.firstChild).toBeNull();
  });
});
