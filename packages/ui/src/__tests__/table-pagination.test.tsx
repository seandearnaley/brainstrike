import { act, render, screen, waitFor } from '@testing-library/react';
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

  it('makes the truncated range summary focusable for keyboard tooltip access', () => {
    render(
      <TablePagination
        currentPage={1}
        onPageChange={vi.fn()}
        pageSize={50}
        totalItems={300}
        totalPages={6}
      />
    );

    const rangeSummary = screen.getByText('51-100 of 300');

    expect(rangeSummary).toHaveAttribute('tabindex', '0');
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

  it('uses the icon-xs size token for navigation buttons', () => {
    render(
      <TablePagination currentPage={1} onPageChange={vi.fn()} totalItems={30} totalPages={3} />
    );

    expect(screen.getByRole('button', { name: 'Go to first page' })).toHaveAttribute(
      'data-size',
      'icon-xs'
    );
    expect(screen.getByRole('button', { name: 'Go to previous page' })).toHaveAttribute(
      'data-size',
      'icon-xs'
    );
    expect(screen.getByRole('button', { name: 'Go to next page' })).toHaveAttribute(
      'data-size',
      'icon-xs'
    );
    expect(screen.getByRole('button', { name: 'Go to last page' })).toHaveAttribute(
      'data-size',
      'icon-xs'
    );
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

  it('does not render page size selector when pageSize is provided without onPageSizeChange', () => {
    render(
      <TablePagination
        currentPage={0}
        onPageChange={vi.fn()}
        pageSize={25}
        totalItems={100}
        totalPages={4}
      />
    );

    expect(screen.queryByText('Show')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Items per page' })).not.toBeInTheDocument();
  });

  // Skip: Radix Select has jsdom compatibility issues (hasPointerCapture not implemented).
  // The callback wiring is tested via integration tests.
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

  it('uses compact density when explicitly requested', () => {
    render(
      <TablePagination
        currentPage={1}
        density="compact"
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
        pageSize={50}
        totalItems={300}
        totalPages={6}
      />
    );

    // Compact mode hides "Show" label and uses shortened range summary.
    expect(screen.queryByText('Show')).not.toBeInTheDocument();
    expect(screen.getByText('51-100/300')).toBeInTheDocument();
  });

  it('uses mini density when explicitly requested', () => {
    render(
      <TablePagination
        currentPage={1}
        density="mini"
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
        pageSize={50}
        totalItems={300}
        totalPages={6}
      />
    );

    // Mini mode removes first/last controls and hides range text to fit narrow panels.
    expect(screen.queryByRole('button', { name: 'Go to first page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go to last page' })).not.toBeInTheDocument();
    expect(screen.queryByText('51-100/300')).not.toBeInTheDocument();
    expect(screen.getByText('/6')).toBeInTheDocument();
  });

  it('adapts auto density with resize transitions and hysteresis', async () => {
    const observedCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        observedCallbacks.push(callback);
      }
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    }

    const originalResizeObserver = window.ResizeObserver;
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback): number => {
        callback(0);
        return 1;
      });

    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: TestResizeObserver,
      writable: true,
    });

    try {
      render(
        <TablePagination
          currentPage={1}
          density="auto"
          onPageChange={vi.fn()}
          onPageSizeChange={vi.fn()}
          pageSize={50}
          totalItems={300}
          totalPages={6}
        />
      );

      const emitResize = (width: number): void => {
        const callback = observedCallbacks.at(-1);
        if (!callback) {
          throw new Error('ResizeObserver callback was not registered');
        }
        callback(
          [
            {
              contentRect: { width } as DOMRectReadOnly,
            } as ResizeObserverEntry,
          ],
          {} as ResizeObserver
        );
      };

      await waitFor(() => {
        expect(observedCallbacks.length).toBeGreaterThan(0);
      });

      act(() => {
        emitResize(620);
      });
      await waitFor(() => {
        expect(screen.queryByText('Show')).not.toBeInTheDocument();
        expect(screen.getByText('51-100/300')).toBeInTheDocument();
      });

      act(() => {
        emitResize(495);
      });
      await waitFor(() => {
        expect(screen.getByText('/6')).toBeInTheDocument();
      });

      // Extremely narrow panels progressively reduce to previous/current/next.
      act(() => {
        emitResize(200);
      });
      await waitFor(() => {
        expect(screen.queryByRole('combobox', { name: 'Items per page' })).not.toBeInTheDocument();
        expect(screen.queryByRole('spinbutton', { name: 'Page number' })).not.toBeInTheDocument();
        expect(screen.getByText('2/6')).toHaveAccessibleName('Page 2 of 6');
      });

      // Micro mode should persist inside the 20px hysteresis band (<=320px).
      act(() => {
        emitResize(310);
      });
      await waitFor(() => {
        expect(screen.getByText('2/6')).toBeInTheDocument();
      });

      // Crossing beyond hysteresis transitions micro -> mini.
      act(() => {
        emitResize(321);
      });
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: 'Items per page' })).toBeInTheDocument();
        expect(screen.getByRole('spinbutton', { name: 'Page number' })).toBeInTheDocument();
        expect(screen.getByText('/6')).toBeInTheDocument();
      });

      // Mini mode should persist inside the 20px hysteresis band (<=520px).
      act(() => {
        emitResize(510);
      });
      await waitFor(() => {
        expect(screen.getByText('/6')).toBeInTheDocument();
      });

      // Crossing beyond hysteresis transitions mini -> compact.
      act(() => {
        emitResize(530);
      });
      await waitFor(() => {
        expect(screen.queryByText('/6')).not.toBeInTheDocument();
        expect(screen.getByText('51-100/300')).toBeInTheDocument();
      });

      // Compact should persist inside its upper hysteresis band (<=660px).
      act(() => {
        emitResize(650);
      });
      await waitFor(() => {
        expect(screen.queryByText('Show')).not.toBeInTheDocument();
        expect(screen.getByText('51-100/300')).toBeInTheDocument();
      });

      // Exiting the hysteresis band transitions compact -> full.
      act(() => {
        emitResize(661);
      });
      await waitFor(() => {
        expect(screen.getByText('Show')).toBeInTheDocument();
        expect(screen.getByText('51-100 of 300')).toBeInTheDocument();
      });
    } finally {
      Object.defineProperty(window, 'ResizeObserver', {
        configurable: true,
        value: originalResizeObserver,
        writable: true,
      });
      requestAnimationFrameSpy.mockRestore();
    }
  });
});
