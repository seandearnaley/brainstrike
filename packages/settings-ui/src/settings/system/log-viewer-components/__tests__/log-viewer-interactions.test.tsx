import '@testing-library/jest-dom/vitest';
import { LogLevel, type LogRecord } from '@brainstrike/logging';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogViewer } from '../log-viewer';
import { installLogViewerDomStubs } from './log-viewer-test-harness';

vi.mock('@tanstack/react-virtual', async () => {
  const actual = await vi.importActual('@tanstack/react-virtual');
  const { createMockLogVirtualizer } = await vi.importActual('./log-viewer-test-harness');
  return {
    ...actual,
    useVirtualizer: createMockLogVirtualizer,
  };
});

const mockToast = vi.fn();

beforeAll(() => {
  installLogViewerDomStubs();
});

beforeEach(() => {
  mockToast.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

const createMockLogRecord = (overrides: Partial<LogRecord> = {}): LogRecord => ({
  args: [],
  bindings: {},
  level: LogLevel.INFO,
  message: 'Test log message',
  timestamp: Date.now(),
  ...overrides,
});

describe('LogViewer interactions and export', () => {
  it('cancels a pending subscription snapshot during unmount cleanup', () => {
    vi.useFakeTimers();
    let subscribedHandler: ((records: readonly LogRecord[]) => void) | undefined;
    const unsubscribe = vi.fn();
    const logSource = {
      subscribe: (handler: (records: readonly LogRecord[]) => void) => {
        subscribedHandler = handler;
        return unsubscribe;
      },
    };
    const { unmount } = render(<LogViewer logSource={logSource} toast={mockToast} />);

    act(() => {
      subscribedHandler?.([createMockLogRecord({ message: 'Must not render after cleanup' })]);
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(screen.queryByText('Must not render after cleanup')).not.toBeInTheDocument();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('retains malformed level, timestamp, and bindings fields as an inspectable row', async () => {
    const logSource = {
      getInitialRecords: async () => [
        createMockLogRecord({
          bindings: {
            toJSON: () => {
              throw new Error('malformed bindings');
            },
          },
          level: 'unexpected-level' as LogLevel,
          message: 'Malformed record remains visible',
          timestamp: Number.NaN,
        }),
      ],
      subscribe: () => () => {},
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);

    expect(await screen.findByText('Malformed record remains visible')).toBeInTheDocument();
    expect(screen.getByText('unknown (unexpected-level)')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'View details for Malformed record remains visible' })
    ).toBeInTheDocument();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('sorts rows and toggles column visibility from the table controls', async () => {
    const user = userEvent.setup();
    const logSource = {
      getInitialRecords: async () => [
        createMockLogRecord({ message: 'Older row', scope: 'old', timestamp: 1000 }),
        createMockLogRecord({ message: 'Newer row', scope: 'new', timestamp: 2000 }),
      ],
      subscribe: () => () => {},
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);
    await screen.findByText('Older row');
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('Older row');

    await user.click(screen.getByRole('button', { name: /^Time/ }));
    expect(screen.getByRole('button', { name: /^Time/ })).toHaveAccessibleName('Time');
    await user.click(screen.getByRole('button', { name: /^Time/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Time/ })).toHaveAccessibleName('Time↓');
      expect(screen.getAllByRole('row')[1]).toHaveTextContent('Newer row');
    });

    await user.click(screen.getByRole('button', { name: 'View' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Scope' }));
    expect(screen.queryByRole('columnheader', { name: 'Scope' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Message' })).toBeInTheDocument();
  });

  it('filters logs by level through the accessible control', async () => {
    const user = userEvent.setup();
    const logSource = {
      getInitialRecords: async () => [
        createMockLogRecord({ level: LogLevel.DEBUG, message: 'Debug Log' }),
        createMockLogRecord({ level: LogLevel.ERROR, message: 'Error Log' }),
      ],
      subscribe: () => () => {},
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);
    await screen.findByText('Debug Log');
    await user.click(screen.getByRole('combobox', { name: 'Level' }));
    await user.click(screen.getByRole('option', { name: 'Error' }));

    expect(screen.queryByText('Debug Log')).not.toBeInTheDocument();
    expect(screen.getByText('Error Log')).toBeInTheDocument();
  });

  it('exports every filtered row across pages instead of only the visible page', async () => {
    const includedLogs = Array.from({ length: 60 }, (_, index) =>
      createMockLogRecord({ message: `Included log ${index + 1}`, timestamp: index + 1 })
    );
    const excludedLogs = Array.from({ length: 10 }, (_, index) =>
      createMockLogRecord({ message: `Excluded log ${index + 1}`, timestamp: 100 + index })
    );
    let exportedBlob: Blob | null = null;
    const createObjectUrlSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation((blob: Blob | MediaSource) => {
        exportedBlob = blob as Blob;
        return 'blob:filtered-logs';
      });
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    try {
      render(
        <LogViewer
          logSource={{
            getInitialRecords: async () => [...includedLogs, ...excludedLogs],
            subscribe: () => () => {},
          }}
          toast={mockToast}
        />
      );
      await screen.findByText('Excluded log 10');
      fireEvent.change(screen.getByPlaceholderText('Search logs...'), {
        target: { value: 'Included log' },
      });
      await waitFor(() =>
        expect(screen.getByTestId('log-viewer-summary')).toHaveTextContent('Showing 51-60 of 60')
      );
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Export Logs' }));
      });

      const payload = JSON.parse(await exportedBlob!.text()) as {
        recordCount: number;
        records: LogRecord[];
      };
      expect(payload.recordCount).toBe(60);
      expect(payload.records).toHaveLength(60);
      expect(payload.records.every((record) => record.message?.startsWith('Included log'))).toBe(
        true
      );
    } finally {
      createObjectUrlSpy.mockRestore();
      anchorClickSpy.mockRestore();
    }
  });

  it('pauses pagination follow and resumes auto-scroll on demand', async () => {
    const user = userEvent.setup();
    const logs = Array.from({ length: 60 }, (_, index) =>
      createMockLogRecord({ message: `Log ${index + 1}`, timestamp: index + 1 })
    );
    render(
      <LogViewer
        logSource={{ getInitialRecords: async () => logs, subscribe: () => () => {} }}
        toast={mockToast}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(2);
      expect(screen.getByText('Auto-scroll on')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Go to previous page' }));
    expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(1);
    expect(screen.getByText('Scroll paused')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Auto-scroll' }));
    expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(2);
    expect(screen.getByText('Auto-scroll on')).toBeInTheDocument();
  });
});
