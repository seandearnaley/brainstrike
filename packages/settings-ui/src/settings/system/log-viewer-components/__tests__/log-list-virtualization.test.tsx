import '@testing-library/jest-dom/vitest';
import type { Table as ReactTableInstance, Row } from '@tanstack/react-table';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogList } from '../log-list';
import type { LogTableFeatures } from '../log-table-features';
import type { LogRecordRow } from '../log-utils';

vi.mock('../log-row', () => ({
  LogRow: ({
    measureRow,
    virtualRow,
  }: {
    measureRow: (node: HTMLTableRowElement | null) => void;
    virtualRow: { index: number };
  }) => (
    <tr data-index={virtualRow.index} data-testid="virtual-log-row" ref={measureRow}>
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

const rowRect = { ...viewportRect, bottom: 40, height: 40 } as DOMRect;

class MeasuredResizeObserver implements ResizeObserver {
  readonly #callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
  }

  disconnect(): void {}

  observe(target: Element): void {
    const rect = target instanceof HTMLTableRowElement ? rowRect : viewportRect;
    if (target instanceof HTMLTableRowElement) {
      rowMeasurementCount += 1;
    }
    this.#callback(
      [
        {
          borderBoxSize: [{ blockSize: rect.height, inlineSize: rect.width }],
          contentBoxSize: [{ blockSize: rect.height, inlineSize: rect.width }],
          contentRect: rect,
          devicePixelContentBoxSize: [],
          target,
        },
      ],
      this
    );
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
let rowMeasurementCount = 0;

describe('LogList real virtualization', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', MeasuredResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect(
      this: HTMLElement
    ): DOMRect {
      if (this.dataset['testid'] === 'log-list-scroll-container') {
        return viewportRect;
      }
      return rowRect;
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollToMock,
    });
    scrollToMock.mockReset();
    rowMeasurementCount = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
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
    expect(screen.getAllByTestId('virtual-log-row').length).toBeLessThan(100);
    expect(rowMeasurementCount).toBeGreaterThan(0);
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
    await act(async () => {});

    vi.useFakeTimers();
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
    act(() => {
      vi.runOnlyPendingTimers();
    });
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
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(scrollToMock).toHaveBeenCalled();
  });
});
