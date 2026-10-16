import '@testing-library/jest-dom/vitest';
import { LogLevel, type LogRecord } from '@brainstrike/logging';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogViewer } from '../log-viewer';
import { installLogViewerDomStubs } from './log-viewer-test-harness';

/** Source, code, time and list limits sit behind the toolbar's Filters toggle. */
function openFilters(): void {
  fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
}

const clipboardMocks = vi.hoisted(() => ({
  writeText: vi.fn(),
}));

vi.mock('@brainstrike/context-actions', () => ({
  createClipboardService: () => ({
    writeText: clipboardMocks.writeText,
  }),
}));

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

const createMockLogRecord = (overrides: Partial<LogRecord> = {}): LogRecord => ({
  args: [],
  bindings: {},
  level: LogLevel.INFO,
  message: 'Test log message',
  timestamp: Date.now(),
  ...overrides,
});

describe('LogViewer', () => {
  beforeEach(() => {
    clipboardMocks.writeText.mockReset();
    clipboardMocks.writeText.mockResolvedValue({ ok: true });
    mockToast.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing without a log source', () => {
    const { container } = render(<LogViewer logSource={undefined} toast={mockToast} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders empty state when no logs', async () => {
    const logSource = {
      getInitialRecords: async () => [],
      subscribe: () => () => {},
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);

    expect(screen.getByRole('region', { name: 'Log Viewer' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('No logs recorded for the current session.')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Export Logs' })).toBeDisabled();
  });

  it('surfaces initial log load failures through toast', async () => {
    const logSource = {
      getInitialRecords: vi.fn().mockRejectedValue(new Error('initial logs failed')),
      subscribe: () => () => {},
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        description: 'initial logs failed',
        title: 'Failed to load logs',
        variant: 'destructive',
      });
    });
  });

  it('surfaces refresh failures through toast', async () => {
    const getInitialRecords = vi
      .fn()
      .mockResolvedValueOnce([
        createMockLogRecord({
          message: 'Initial log',
          timestamp: 1000,
        }),
      ])
      .mockRejectedValueOnce(new Error('refresh failed'));
    const logSource = {
      getInitialRecords,
      subscribe: () => () => {},
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);

    await waitFor(() => expect(screen.getByText('Initial log')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Logs' }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        description: 'refresh failed',
        title: 'Failed to refresh logs',
        variant: 'destructive',
      });
    });
  });

  it('surfaces subscription failures and recovers when the source changes', async () => {
    const user = userEvent.setup();
    const failedSource = {
      getInitialRecords: async () => [createMockLogRecord({ message: 'Initial fallback record' })],
      subscribe: () => {
        throw new Error('subscription failed');
      },
    };
    let subscribedHandler: ((records: readonly LogRecord[]) => void) | undefined;
    const unsubscribe = vi.fn();
    const recoveredSource = {
      getInitialRecords: async () => [],
      subscribe: (handler: (records: readonly LogRecord[]) => void) => {
        subscribedHandler = handler;
        return unsubscribe;
      },
    };

    const { rerender, unmount } = render(<LogViewer logSource={failedSource} toast={mockToast} />);

    expect(await screen.findByText('Initial fallback record')).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith({
      description: 'subscription failed',
      title: 'Failed to subscribe to logs',
      variant: 'destructive',
    });
    expect(screen.getByTestId('log-viewer-live-status')).toHaveTextContent(
      'Live updates unavailable: subscription failed'
    );

    openFilters();
    await user.click(screen.getByRole('combobox', { name: 'Retention' }));
    await user.click(screen.getByRole('option', { name: '500 logs' }));
    expect(mockToast).toHaveBeenCalledTimes(1);

    rerender(<LogViewer logSource={recoveredSource} toast={mockToast} />);
    await waitFor(() => expect(subscribedHandler).toBeDefined());
    act(() => {
      subscribedHandler?.([createMockLogRecord({ message: 'Recovered subscription record' })]);
    });
    await waitFor(() =>
      expect(screen.getByText('Recovered subscription record')).toBeInTheDocument()
    );
    expect(screen.getByTestId('log-viewer-live-status')).toHaveTextContent('Auto-scroll on');

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('renders subscribed log updates and unsubscribes on unmount', async () => {
    let subscribedHandler: ((records: readonly LogRecord[]) => void) | undefined;
    const unsubscribe = vi.fn();
    const logSource = {
      getInitialRecords: async () => [],
      subscribe: vi.fn((handler: (records: readonly LogRecord[]) => void) => {
        subscribedHandler = handler;
        return unsubscribe;
      }),
    };

    const { unmount } = render(<LogViewer logSource={logSource} toast={mockToast} />);

    await waitFor(() => expect(logSource.subscribe).toHaveBeenCalledTimes(1));
    act(() => {
      subscribedHandler?.([
        createMockLogRecord({
          message: 'Subscribed log',
          scope: 'live',
          timestamp: 2000,
        }),
      ]);
    });

    await waitFor(() => expect(screen.getByText('Subscribed log')).toBeInTheDocument());
    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps a circular-bindings serialization failure visible without dropping the log record', async () => {
    const circularBindings: Record<string, unknown> = {};
    circularBindings['self'] = circularBindings;
    const logSource = {
      getInitialRecords: async () => [
        createMockLogRecord({
          bindings: circularBindings,
          message: 'Circular bindings record',
        }),
      ],
      subscribe: () => () => {},
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);

    expect(await screen.findByText('Circular bindings record')).toBeInTheDocument();
    expect(screen.getByText('{"self":"[Circular]"}')).toBeInTheDocument();
  });

  it('exports circular bindings with an explicit circular marker', async () => {
    const circularBindings: Record<string, unknown> = { runtime: 'electron-renderer' };
    circularBindings['self'] = circularBindings;
    Object.defineProperty(circularBindings, 'broken', {
      enumerable: true,
      get: () => {
        throw new Error('binding getter failed');
      },
    });
    const logSource = {
      getInitialRecords: async () => [
        createMockLogRecord({
          bindings: circularBindings,
          message: 'Circular bindings export record',
        }),
      ],
      subscribe: () => () => {},
    };
    let exportedBlob: Blob | null = null;
    const createObjectUrlSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation((blob: Blob | MediaSource) => {
        exportedBlob = blob as Blob;
        return 'blob:circular-logs';
      });
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    try {
      render(<LogViewer logSource={logSource} toast={mockToast} />);

      expect(await screen.findByText('Circular bindings export record')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Export Logs' }));

      expect(exportedBlob).not.toBeNull();
      const payload = JSON.parse(await exportedBlob!.text());
      expect(payload.records[0].bindings).toEqual({
        broken: '[Bindings serialization failed]',
        runtime: 'electron-renderer',
        self: '[Circular]',
      });
      expect(mockToast).not.toHaveBeenCalled();
    } finally {
      createObjectUrlSpy.mockRestore();
      anchorClickSpy.mockRestore();
    }
  });

  it('serializes unchanged records only once across incremental notifications', () => {
    vi.useFakeTimers();
    let subscribedHandler: ((records: readonly LogRecord[]) => void) | undefined;
    let firstBindingsSerializations = 0;
    const firstRecord = createMockLogRecord({
      bindings: {
        runtime: 'electron-renderer',
        toJSON: () => {
          firstBindingsSerializations += 1;
          return { runtime: 'electron-renderer' };
        },
      },
      message: 'First record',
      timestamp: 1,
    });
    const secondRecord = createMockLogRecord({ message: 'Second record', timestamp: 2 });
    const logSource = {
      subscribe: (handler: (records: readonly LogRecord[]) => void) => {
        subscribedHandler = handler;
        return () => {};
      },
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);
    act(() => {
      subscribedHandler?.([firstRecord]);
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByText('First record')).toBeInTheDocument();
    expect(firstBindingsSerializations).toBe(1);

    act(() => {
      subscribedHandler?.([firstRecord, secondRecord]);
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByText('Second record')).toBeInTheDocument();
    expect(firstBindingsSerializations).toBe(1);
  });

  it('reuses cached row and search projections across incremental search terms', async () => {
    let argumentSerializations = 0;
    let bindingSerializations = 0;
    let searchHaystackProjections = 0;
    const expectedHaystack =
      'Searchable record  {"detail":"needle detail"} {"runtime":"electron-renderer"}';
    const originalToLowerCase = String.prototype.toLowerCase;
    const lowercaseSpy = vi
      .spyOn(String.prototype, 'toLowerCase')
      .mockImplementation(function lowercaseWithProjectionCount(this: string): string {
        if (String(this) === expectedHaystack) {
          searchHaystackProjections += 1;
        }
        return originalToLowerCase.call(this);
      });
    const record = createMockLogRecord({
      args: [
        {
          toJSON: () => {
            argumentSerializations += 1;
            return { detail: 'needle detail' };
          },
        },
      ],
      bindings: {
        toJSON: () => {
          bindingSerializations += 1;
          return { runtime: 'electron-renderer' };
        },
      },
      message: 'Searchable record',
    });
    const logSource = {
      getInitialRecords: async () => [record],
      subscribe: () => () => {},
    };

    try {
      render(<LogViewer logSource={logSource} toast={mockToast} />);

      await waitFor(() => expect(screen.getByText('Searchable record')).toBeInTheDocument());
      expect(argumentSerializations).toBe(1);
      expect(bindingSerializations).toBe(1);

      const searchInput = screen.getByPlaceholderText('Search logs...');
      fireEvent.change(searchInput, { target: { value: 'needle' } });
      fireEvent.change(searchInput, { target: { value: 'needle detail' } });

      expect(screen.getByText('Searchable record')).toBeInTheDocument();
      expect(argumentSerializations).toBe(1);
      expect(bindingSerializations).toBe(1);
      expect(searchHaystackProjections).toBe(1);
    } finally {
      lowercaseSpy.mockRestore();
    }
  });

  it('coalesces subscription bursts into one trailing snapshot', () => {
    vi.useFakeTimers();
    let subscribedHandler: ((records: readonly LogRecord[]) => void) | undefined;
    const records = [
      createMockLogRecord({ message: 'Burst one', timestamp: 1 }),
      createMockLogRecord({ message: 'Burst two', timestamp: 2 }),
      createMockLogRecord({ message: 'Burst three', timestamp: 3 }),
    ];
    const logSource = {
      subscribe: (handler: (records: readonly LogRecord[]) => void) => {
        subscribedHandler = handler;
        return () => {};
      },
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);
    act(() => {
      subscribedHandler?.(records.slice(0, 1));
      subscribedHandler?.(records.slice(0, 2));
      subscribedHandler?.(records);
      vi.advanceTimersByTime(99);
    });
    expect(screen.queryByText('Burst one')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText('Burst one')).toBeInTheDocument();
    expect(screen.getByText('Burst two')).toBeInTheDocument();
    expect(screen.getByText('Burst three')).toBeInTheDocument();
  });

  it('renders logs from source', async () => {
    const logs = [
      createMockLogRecord({
        bindings: { runtime: 'electron-renderer' },
        message: 'First log',
        timestamp: 1000,
      }),
      createMockLogRecord({
        bindings: { runtime: 'electron-main' },
        message: 'Second log',
        timestamp: 2000,
      }),
    ];
    const logSource = {
      getInitialRecords: async () => logs,
      subscribe: () => () => {},
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);

    await waitFor(() => {
      expect(screen.getByText('First log')).toBeInTheDocument();
      expect(screen.getByText('Second log')).toBeInTheDocument();
      expect(
        screen.getByText(/Sources: electron-main 1 .* electron-renderer 1/)
      ).toBeInTheDocument();
    });
  });

  it('uses explicit log source metadata for forwarded utility process logs', async () => {
    const logs = [
      createMockLogRecord({
        args: ['DB host process started', { logSource: 'db-host', runtime: 'db-host' }],
        bindings: { runtime: 'electron-main' },
        message: 'DB host process started',
        timestamp: 1000,
      }),
    ];
    const logSource = {
      getInitialRecords: async () => logs,
      subscribe: () => () => {},
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);

    await waitFor(() => {
      expect(screen.getByText('DB host process started')).toBeInTheDocument();
      expect(screen.getByText('Sources: db-host 1')).toBeInTheDocument();
    });
  });

  it('exports a diagnostic bundle with runtime source coverage', async () => {
    const logs = [
      createMockLogRecord({
        bindings: { runtime: 'electron-renderer' },
        message: 'Renderer log',
        timestamp: 1000,
      }),
      createMockLogRecord({
        bindings: { runtime: 'electron-main' },
        message: 'Main log',
        timestamp: 2000,
      }),
    ];
    const logSource = {
      getInitialRecords: async () => logs,
      subscribe: () => () => {},
    };
    let exportedBlob: Blob | null = null;
    const createObjectUrlSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation((blob: Blob | MediaSource) => {
        exportedBlob = blob as Blob;
        return 'blob:logs';
      });
    const revokeObjectUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    try {
      render(<LogViewer logSource={logSource} toast={mockToast} />);

      await waitFor(() => expect(screen.getByText('Renderer log')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Export Logs' }));

      expect(exportedBlob).not.toBeNull();
      const exportedText = await exportedBlob!.text();
      const exportedPayload = JSON.parse(exportedText) as {
        recordCount: number;
        records: readonly unknown[];
        sourceCoverage: Record<string, number>;
      };
      expect(exportedPayload.recordCount).toBe(2);
      expect(exportedPayload.sourceCoverage).toEqual({
        'electron-main': 1,
        'electron-renderer': 1,
      });
      expect(exportedPayload.records).toHaveLength(2);

      // `downloadBlobFile` holds the object URL alive for a wall-clock grace
      // period (the download manager resolves the blob asynchronously), so the
      // revoke must NOT land in the click's wake. The pending revoke timer
      // intentionally outlives this test (real timers); scoping to THIS
      // export's URL keeps a stale revoke from a >60s file run harmless.
      expect(revokeObjectUrlSpy).not.toHaveBeenCalledWith('blob:logs');
    } finally {
      createObjectUrlSpy.mockRestore();
      revokeObjectUrlSpy.mockRestore();
      anchorClickSpy.mockRestore();
    }
  });

  // A raw `new Date().toISOString()` in `anchor.download` carries `:` and
  // millis; Windows rejects `:` and browsers mangle the name silently. The
  // revoke is deferred a wall-clock grace period because the download manager
  // resolves the blob asynchronously after the click — revoking inline (or a
  // task later) can drop the file with no error.
  it('exports under a filesystem-safe filename without revoking the object URL in the click wake', async () => {
    const logs = [createMockLogRecord({ message: 'Renderer log', timestamp: 1000 })];
    const logSource = {
      getInitialRecords: async () => logs,
      subscribe: () => () => {},
    };
    const originalCreateElement = document.createElement.bind(document);
    const mockAnchor = originalCreateElement('a');
    const anchorClickSpy = vi.spyOn(mockAnchor, 'click').mockImplementation(() => {});
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation(((tagName: string) =>
        tagName === 'a'
          ? mockAnchor
          : originalCreateElement(tagName)) as typeof document.createElement);
    const createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:logs-named');
    const revokeObjectUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    try {
      render(<LogViewer logSource={logSource} toast={mockToast} />);

      await waitFor(() => expect(screen.getByText('Renderer log')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Export Logs' }));

      expect(mockAnchor.download).toMatch(
        /^brainstrike-logs-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/
      );
      expect(mockAnchor.download).not.toMatch(/[<>:"/\\|?*]/);
      expect(anchorClickSpy).toHaveBeenCalledTimes(1);
      // URL-scoped for the same stale-timer reason as the export test above.
      expect(revokeObjectUrlSpy).not.toHaveBeenCalledWith('blob:logs-named');
    } finally {
      createElementSpy.mockRestore();
      createObjectUrlSpy.mockRestore();
      revokeObjectUrlSpy.mockRestore();
      anchorClickSpy.mockRestore();
    }
  });

  it('filters logs by search term', async () => {
    const logs = [
      createMockLogRecord({ message: 'Apple' }),
      createMockLogRecord({ message: 'Banana' }),
    ];
    const logSource = {
      getInitialRecords: async () => logs,
      subscribe: () => () => {},
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);

    await waitFor(() => expect(screen.getByText('Apple')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('Search logs...');
    expect(searchInput).toHaveClass('pl-10');
    // Authored inline in rem (SETTINGS_SEARCH_INPUT_STYLE /
    // SETTINGS_SEARCH_ICON_LEFT_INSET), so read `.style` rather than
    // getComputedStyle — jsdom >=30 resolves computed lengths to px.
    expect(searchInput.style.paddingLeft).toBe('2.5rem');
    expect(
      searchInput.parentElement?.querySelector<HTMLElement>('[data-slot="settings-search-icon"]')
        ?.style.left
    ).toBe('0.75rem');
    fireEvent.change(searchInput, { target: { value: 'Apple' } });

    await waitFor(() => {
      expect(screen.getByText('Apple')).toBeInTheDocument();
      expect(screen.queryByText('Banana')).not.toBeInTheDocument();
    });
  });

  it('filters logs by dedicated source and code controls', async () => {
    const user = userEvent.setup();
    const logs = [
      createMockLogRecord({
        args: [{ logSource: 'electron-main' }],
        bindings: { code: 'main_crash', runtime: 'electron-main' },
        message: 'Main crash',
        timestamp: 1000,
      }),
      createMockLogRecord({
        args: [{ logSource: 'electron-main' }],
        bindings: { code: 'main_timeout', runtime: 'electron-main' },
        message: 'Main timeout',
        timestamp: 2000,
      }),
      createMockLogRecord({
        args: [{ logSource: 'electron-renderer' }],
        bindings: { code: 'render_crash', runtime: 'electron-renderer' },
        message: 'Renderer crash',
        timestamp: 3000,
      }),
    ];
    const logSource = {
      getInitialRecords: async () => logs,
      subscribe: () => () => {},
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);

    await waitFor(() => expect(screen.getByText('Renderer crash')).toBeInTheDocument());
    openFilters();
    await user.click(screen.getByRole('combobox', { name: 'Source' }));
    await user.click(screen.getByRole('option', { name: 'electron-main' }));

    expect(screen.getByText('Main crash')).toBeInTheDocument();
    expect(screen.getByText('Main timeout')).toBeInTheDocument();
    expect(screen.queryByText('Renderer crash')).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Code' }));
    await user.click(screen.getByRole('option', { name: 'main_timeout' }));

    expect(screen.queryByText('Main crash')).not.toBeInTheDocument();
    expect(screen.getByText('Main timeout')).toBeInTheDocument();
  });

  it('does not project newly excluded records while a search is active', async () => {
    let subscribedHandler: ((records: readonly LogRecord[]) => void) | undefined;
    let argumentSerializations = 0;
    let bindingSerializations = 0;
    const mainRecord = createMockLogRecord({
      args: [{ logSource: 'electron-main' }],
      bindings: { code: 'included-code' },
      message: 'Main needle',
      timestamp: new Date('2026-01-01T12:00').getTime(),
    });
    const sourceExcludedRecord = createMockLogRecord({
      args: [
        {
          logSource: 'electron-renderer',
          toJSON: () => {
            argumentSerializations += 1;
            return { detail: 'Renderer needle' };
          },
        },
      ],
      bindings: {
        code: 'included-code',
        toJSON: () => {
          bindingSerializations += 1;
          return { runtime: 'electron-renderer' };
        },
      },
      message: 'Renderer needle',
      timestamp: new Date('2026-01-01T12:00').getTime(),
    });
    const codeExcludedRecord = createMockLogRecord({
      args: [
        {
          logSource: 'electron-main',
          toJSON: () => {
            argumentSerializations += 1;
            return { detail: 'Code excluded needle' };
          },
        },
      ],
      bindings: {
        code: 'excluded-code',
        toJSON: () => {
          bindingSerializations += 1;
          return { code: 'excluded-code' };
        },
      },
      message: 'Code excluded needle',
      timestamp: new Date('2026-01-01T12:00').getTime(),
    });
    const timeExcludedRecord = createMockLogRecord({
      args: [
        {
          logSource: 'electron-main',
          toJSON: () => {
            argumentSerializations += 1;
            return { detail: 'Time excluded needle' };
          },
        },
      ],
      bindings: {
        code: 'included-code',
        toJSON: () => {
          bindingSerializations += 1;
          return { code: 'included-code' };
        },
      },
      message: 'Time excluded needle',
      timestamp: new Date('2026-01-01T10:00').getTime(),
    });
    const subscribe = vi.fn((handler: (records: readonly LogRecord[]) => void) => {
      subscribedHandler = handler;
      return () => {};
    });
    const logSource = {
      getInitialRecords: async () => [mainRecord],
      subscribe,
    };
    const user = userEvent.setup();

    render(<LogViewer logSource={logSource} toast={mockToast} />);

    await waitFor(() => expect(screen.getByText('Main needle')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('Search logs...'), {
      target: { value: 'needle' },
    });
    openFilters();
    await user.click(screen.getByRole('combobox', { name: 'Source' }));
    await user.click(screen.getByRole('option', { name: 'electron-main' }));
    await user.click(screen.getByRole('combobox', { name: 'Code' }));
    await user.click(screen.getByRole('option', { name: 'included-code' }));
    fireEvent.change(screen.getByLabelText('From time'), {
      target: { value: '2026-01-01T11:00' },
    });
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));

    await act(async () => {
      subscribedHandler?.([
        mainRecord,
        sourceExcludedRecord,
        codeExcludedRecord,
        timeExcludedRecord,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 110));
    });

    expect(argumentSerializations).toBe(0);
    expect(bindingSerializations).toBe(0);
  });

  it('filters logs to an explicit local time range', async () => {
    const logs = [
      createMockLogRecord({
        message: 'Before range',
        timestamp: new Date('2026-01-01T10:00').getTime(),
      }),
      createMockLogRecord({
        message: 'Inside range',
        timestamp: new Date('2026-01-01T12:00').getTime(),
      }),
      createMockLogRecord({
        message: 'After range',
        timestamp: new Date('2026-01-01T14:00').getTime(),
      }),
    ];
    const logSource = {
      getInitialRecords: async () => logs,
      subscribe: () => () => {},
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);

    await waitFor(() => expect(screen.getByText('Inside range')).toBeInTheDocument());
    openFilters();
    fireEvent.change(screen.getByLabelText('From time'), {
      target: { value: '2026-01-01T11:00' },
    });
    fireEvent.change(screen.getByLabelText('To time'), {
      target: { value: '2026-01-01T13:00' },
    });

    expect(screen.queryByText('Before range')).not.toBeInTheDocument();
    expect(screen.getByText('Inside range')).toBeInTheDocument();
    expect(screen.queryByText('After range')).not.toBeInTheDocument();
  });

  it('includes the full minute selected by the To filter', async () => {
    const logs = [
      createMockLogRecord({
        message: 'Inside selected minute',
        timestamp: new Date('2026-01-01T13:00:30').getTime(),
      }),
      createMockLogRecord({
        message: 'Next minute',
        timestamp: new Date('2026-01-01T13:01:00').getTime(),
      }),
    ];
    const logSource = {
      getInitialRecords: async () => logs,
      subscribe: () => () => {},
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);

    await waitFor(() => expect(screen.getByText('Next minute')).toBeInTheDocument());
    openFilters();
    fireEvent.change(screen.getByLabelText('To time'), {
      target: { value: '2026-01-01T13:00' },
    });

    expect(screen.getByText('Inside selected minute')).toBeInTheDocument();
    expect(screen.queryByText('Next minute')).not.toBeInTheDocument();
  });

  it('surfaces malformed time input instead of throwing from the change handler', async () => {
    const logSource = {
      getInitialRecords: async () => [createMockLogRecord()],
      subscribe: () => () => {},
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);

    await screen.findByText('Test log message');
    openFilters();
    const toInput = screen.getByLabelText('To time') as HTMLInputElement;
    const valueSpy = vi.spyOn(toInput, 'value', 'get').mockReturnValue('not-a-local-time');
    expect(() => fireEvent.change(toInput)).not.toThrow();
    valueSpy.mockRestore();

    expect(screen.getByRole('alert')).toHaveTextContent('To time is invalid.');
  });

  it('resets source and code filters when live records remove the selected options', async () => {
    let subscribedHandler: ((records: readonly LogRecord[]) => void) | undefined;
    const selectedRecord = createMockLogRecord({
      args: [{ code: 'selected-code', logSource: 'electron-main' }],
      message: 'Selected record',
    });
    const remainingRecord = createMockLogRecord({
      args: [{ code: 'remaining-code', logSource: 'web-renderer' }],
      message: 'Remaining record',
    });
    const logSource = {
      getInitialRecords: async () => [selectedRecord, remainingRecord],
      subscribe: (handler: (records: readonly LogRecord[]) => void) => {
        subscribedHandler = handler;
        return () => {};
      },
    };
    const user = userEvent.setup();

    render(<LogViewer logSource={logSource} toast={mockToast} />);
    openFilters();
    await user.click(await screen.findByRole('combobox', { name: 'Source' }));
    await user.click(screen.getByRole('option', { name: 'electron-main' }));
    await user.click(screen.getByRole('combobox', { name: 'Code' }));
    await user.click(screen.getByRole('option', { name: 'selected-code' }));

    act(() => subscribedHandler?.([remainingRecord]));

    await waitFor(() => expect(screen.getByText('Remaining record')).toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: 'Source' })).toHaveTextContent('All sources');
    expect(screen.getByRole('combobox', { name: 'Code' })).toHaveTextContent('All codes');
  });

  it('opens a structured diagnostic detail view with the cause chain', async () => {
    const user = userEvent.setup();
    const record = createMockLogRecord({
      args: [
        {
          causeChain: [
            { code: 'ROOT_TIMEOUT', message: 'Socket timed out', name: 'TimeoutError' },
            { message: 'Connection failed', name: 'NetworkError' },
          ],
          logSource: 'electron-main',
          stack: 'Error: provider failed\n    at run.ts:42',
        },
      ],
      bindings: {
        code: 'provider_failed',
        fingerprint: 'fingerprint-123',
        runtime: 'electron-main',
      },
      message: 'Provider failed',
      timestamp: 1000,
    });
    const logSource = {
      getInitialRecords: async () => [record],
      subscribe: () => () => {},
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);

    await user.click(
      await screen.findByRole('button', { name: 'View details for Provider failed' })
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Diagnostic details' })).toBeInTheDocument();
    expect(screen.getByText('Cause chain')).toBeInTheDocument();
    expect(screen.getByText('TimeoutError')).toBeInTheDocument();
    expect(screen.getByText('ROOT_TIMEOUT')).toBeInTheDocument();
    expect(screen.getByText('Socket timed out')).toBeInTheDocument();
    expect(screen.getByText('NetworkError')).toBeInTheDocument();
    expect(screen.getByText('Connection failed')).toBeInTheDocument();
    expect(screen.getByText('fingerprint-123')).toBeInTheDocument();
  });

  it('keeps the selected detail record stable across live snapshots', async () => {
    let subscribedHandler: ((records: readonly LogRecord[]) => void) | undefined;
    const originalRecord = createMockLogRecord({
      message: 'Original detail record',
      timestamp: 1000,
    });
    const replacementRecord = createMockLogRecord({
      message: 'Replacement live record',
      timestamp: 2000,
    });
    const logSource = {
      getInitialRecords: async () => [originalRecord],
      subscribe: (handler: (records: readonly LogRecord[]) => void) => {
        subscribedHandler = handler;
        return () => {};
      },
    };
    const user = userEvent.setup();

    render(<LogViewer logSource={logSource} toast={mockToast} />);
    await user.click(
      await screen.findByRole('button', { name: 'View details for Original detail record' })
    );

    act(() => subscribedHandler?.([replacementRecord]));

    await waitFor(() => expect(screen.getByText('Replacement live record')).toBeInTheDocument());
    expect(screen.getByRole('dialog')).toHaveTextContent('Original detail record');
    expect(screen.getByRole('dialog')).not.toHaveTextContent('Replacement live record');
  });

  it('surfaces malformed cause entries while retaining valid causes', async () => {
    const record = createMockLogRecord({
      args: [
        {
          causeChain: [
            { code: null, message: 'Root failed', name: 'RootError' },
            { code: 42, message: 'Malformed', name: 'BadCodeError' },
          ],
        },
      ],
      message: 'Partial cause chain',
    });
    const logSource = {
      getInitialRecords: async () => [record],
      subscribe: () => () => {},
    };
    const user = userEvent.setup();

    render(<LogViewer logSource={logSource} toast={mockToast} />);
    await user.click(
      await screen.findByRole('button', { name: 'View details for Partial cause chain' })
    );

    expect(screen.getByText('RootError')).toBeInTheDocument();
    expect(screen.getByText('1 malformed cause entry was omitted.')).toBeInTheDocument();
  });

  it('copies one row as JSON through the shared clipboard service', async () => {
    const user = userEvent.setup();
    const record = createMockLogRecord({
      args: [{ logSource: 'electron-main', reason: 'boom' }],
      bindings: {
        code: 'main_crash',
        fingerprint: 'fingerprint-123',
        runtime: 'electron-main',
      },
      message: 'Copy me',
      timestamp: 1000,
    });
    const logSource = {
      getInitialRecords: async () => [record],
      subscribe: () => () => {},
    };

    render(<LogViewer logSource={logSource} toast={mockToast} />);

    await user.click(await screen.findByRole('button', { name: 'Copy Copy me as JSON' }));

    await waitFor(() => expect(clipboardMocks.writeText).toHaveBeenCalledTimes(1));
    const copied = clipboardMocks.writeText.mock.calls[0]?.[0];
    expect(JSON.parse(String(copied))).toEqual(record);
  });
});
