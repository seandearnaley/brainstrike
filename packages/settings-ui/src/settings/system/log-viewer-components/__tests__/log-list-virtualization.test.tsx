import '@testing-library/jest-dom/vitest';
import type { Table as ReactTableInstance, Row } from '@tanstack/react-table';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogList } from '../log-list';
import type { LogTableFeatures } from '../log-table-features';
import type { LogRecordRow } from '../log-utils';

vi.mock('../log-row', () => ({
  LogRow: ({ virtualRow }: { virtualRow: { index: number } }) => (
    <tr data-testid="virtual-log-row">
      <td>Row {virtualRow.index}</td>
    </tr>
  ),
}));

const viewportRect = {
  bottom: 300,
  height: 300,
  left: 0,
  right: 800,
  toJSON: () => ({}),
  top: 0,
  width: 800,
  x: 0,
  y: 0,
} as DOMRect;

class MeasuredResizeObserver implements ResizeObserver {
  readonly #callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
  }

  disconnect(): void {}

  observe(target: Element): void {
    queueMicrotask(() => {
      this.#callback(
        [
          {
            borderBoxSize: [{ blockSize: 300, inlineSize: 800 }],
            contentBoxSize: [{ blockSize: 300, inlineSize: 800 }],
            contentRect: viewportRect,
            devicePixelContentBoxSize: [],
            target,
          },
        ],
        this
      );
    });
  }

  unobserve(): void {}
}

const createRows = (count: number): Row<LogTableFeatures, LogRecordRow>[] =>
  Array.from({ length: count }, (_, index) => ({ id: String(index) })) as Row<
    LogTableFeatures,
    LogRecordRow
  >[];

const table = {
  getHeaderGroups: () => [],
  getVisibleLeafColumns: () => [],
} as unknown as ReactTableInstance<LogTableFeatures, LogRecordRow>;

const scrollToMock = vi.fn();

describe('LogList real virtualization', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', MeasuredResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(viewportRect);
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollToMock,
    });
    scrollToMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders a measured DOM window instead of mounting every row', async () => {
    render(
      <LogList
        autoScroll={false}
        autoScrollAnchor="end"
        logsLoading={false}
        rows={createRows(100)}
        table={table}
        wrapLines={false}
      />
    );

    await waitFor(() => expect(screen.getAllByTestId('virtual-log-row').length).toBeGreaterThan(0));
    expect(screen.getAllByTestId('virtual-log-row')).toHaveLength(28);
    expect(screen.getByText('Row 0')).toBeInTheDocument();
    expect(screen.queryByText('Row 99')).not.toBeInTheDocument();
  });

  it('stops scheduling row follow while paused and resumes against the latest row count', async () => {
    const { rerender } = render(
      <LogList
        autoScroll
        autoScrollAnchor="end"
        logsLoading={false}
        rows={createRows(100)}
        table={table}
        wrapLines={false}
      />
    );
    await waitFor(() => expect(scrollToMock).toHaveBeenCalled());

    scrollToMock.mockClear();
    rerender(
      <LogList
        autoScroll={false}
        autoScrollAnchor="end"
        logsLoading={false}
        rows={createRows(101)}
        table={table}
        wrapLines={false}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scrollToMock).not.toHaveBeenCalled();

    rerender(
      <LogList
        autoScroll
        autoScrollAnchor="end"
        logsLoading={false}
        rows={createRows(101)}
        table={table}
        wrapLines={false}
      />
    );
    await waitFor(() => expect(scrollToMock).toHaveBeenCalled());
  });
});
