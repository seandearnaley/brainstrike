import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { LogLevel, type LogRecord } from '@brainstrike/logging';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableNdjsonExportResult, LogSourceAdapter } from './logging-settings-section';
import { LogsPage } from './logs-page';

// Mock virtualizer to render all items for testing
vi.mock('@tanstack/react-virtual', async () => {
  const actual = await vi.importActual('@tanstack/react-virtual');
  return {
    ...actual,
    useVirtualizer: ({ count }: any) => ({
      getTotalSize: () => count * 30,
      getVirtualItems: () =>
        Array.from({ length: count }).map((_, i) => ({
          end: (i + 1) * 30,
          index: i,
          key: i,
          measureElement: () => {},
          size: 30,
          start: i * 30,
        })),
      measureElement: () => {},
      scrollToIndex: () => {},
    }),
  };
});

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));

// Override only `useToast`; keep every other real export (the export-button
// failure test needs to observe the toast call, and the real `use-toast.ts`
// module doesn't render into the DOM without a mounted `<Toaster />`).
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useToast: () => ({ dismiss: vi.fn(), toast: toastMock, toasts: [] }),
}));

beforeEach(() => {
  toastMock.mockReset();
});

beforeAll(() => {
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserver as unknown as typeof ResizeObserver;
  // JSDOM implements neither of these Radix `Select` interaction APIs.
  (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () =>
    false;
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});

function createLogSource(records: readonly LogRecord[]): LogSourceAdapter {
  return {
    getInitialRecords: async () => records,
    subscribe: (handler) => {
      handler(records);
      return vi.fn();
    },
  };
}

/** Builds an `onExportDurableNdjson` resolution. Defaults to an untruncated
 * export whose `exportedCount`/`totalCount` are derived from the NDJSON
 * payload's line count, matching what a real `exportNdjson()` call would
 * report for a non-truncated result — override to pin the truncated case. */
function makeExportResult(
  ndjson: string,
  overrides: Partial<Omit<DurableNdjsonExportResult, 'ndjson'>> = {}
): DurableNdjsonExportResult {
  const lineCount =
    ndjson.length === 0 ? 0 : ndjson.split('\n').filter((line) => line.length > 0).length;
  const exportedCount = overrides.exportedCount ?? lineCount;
  return {
    exportedCount,
    ndjson,
    totalCount: overrides.totalCount ?? exportedCount,
    truncated: overrides.truncated ?? false,
  };
}

/** Same shape as `createLogSource`, but counts `subscribe` calls so a test
 * can observe which adapter the viewer actually subscribed to. */
function createCountingLogSource(records: readonly LogRecord[]): {
  callCount: { subscribe: number };
  source: LogSourceAdapter;
} {
  const callCount = { subscribe: 0 };
  const source: LogSourceAdapter = {
    getInitialRecords: async () => records,
    subscribe: (handler) => {
      callCount.subscribe += 1;
      handler(records);
      return vi.fn();
    },
  };
  return { callCount, source };
}

describe('LogsPage log viewer', () => {
  it('renders renderer log records', async () => {
    const sampleRecords: LogRecord[] = [
      {
        args: ['hello world'],
        bindings: {},
        level: LogLevel.INFO,
        message: 'Renderer log row',
        scope: 'TestScope',
        timestamp: Date.now(),
      },
    ];

    render(<LogsPage active logSource={createLogSource(sampleRecords)} />);

    await waitFor(() => {
      expect(screen.getByText('Renderer log row')).toBeInTheDocument();
    });
  });

  it('updates when logs arrive via subscribe after mount', async () => {
    const laterRecords: LogRecord[] = [
      {
        args: ['late log'],
        bindings: {},
        level: LogLevel.ERROR,
        message: 'Late arriving row',
        scope: 'LateScope',
        timestamp: Date.now() + 1,
      },
    ];

    const logSource: LogSourceAdapter = {
      getInitialRecords: async () => [],
      subscribe: (handler) => {
        handler([]);
        // Use microtask to ensure update happens after mount but reliably
        Promise.resolve().then(() => handler(laterRecords));
        return vi.fn();
      },
    };

    render(<LogsPage active logSource={logSource} />);

    await waitFor(
      () => {
        expect(screen.getByText('Late arriving row')).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  });
});

describe('LogsPage log source switch', () => {
  it('does not render a log source control without a durable source', () => {
    render(<LogsPage active logSource={createLogSource([])} />);

    expect(screen.queryByRole('combobox', { name: /log source/i })).not.toBeInTheDocument();
  });

  it('subscribes to the session adapter by default and the durable adapter once Persistent errors is selected', async () => {
    const user = userEvent.setup();
    const session = createCountingLogSource([]);
    const persistent = createCountingLogSource([]);

    render(<LogsPage active durableLogSource={persistent.source} logSource={session.source} />);

    await waitFor(() => {
      expect(session.callCount.subscribe).toBeGreaterThan(0);
    });
    expect(persistent.callCount.subscribe).toBe(0);

    await user.click(screen.getByRole('combobox', { name: /log source/i }));
    await user.click(screen.getByText('Persistent errors'));

    await waitFor(() => {
      expect(persistent.callCount.subscribe).toBeGreaterThan(0);
    });
  });

  it('shows the durable empty-state copy once Persistent errors is selected', async () => {
    const user = userEvent.setup();

    render(
      <LogsPage active durableLogSource={createLogSource([])} logSource={createLogSource([])} />
    );

    await waitFor(() => {
      expect(screen.getByText('No logs recorded for the current session.')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('combobox', { name: /log source/i }));
    await user.click(screen.getByText('Persistent errors'));

    await waitFor(() => {
      expect(screen.getByText('No durable warn+ events recorded.')).toBeInTheDocument();
    });
  });
});

describe('LogsPage export NDJSON button', () => {
  async function selectPersistentSource() {
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: /log source/i }));
    await user.click(screen.getByText('Persistent errors'));
    return user;
  }

  it('is absent for the session source', () => {
    render(
      <LogsPage
        active
        durableLogSource={createLogSource([])}
        logSource={createLogSource([])}
        onExportDurableNdjson={vi.fn(async () => makeExportResult(''))}
      />
    );

    expect(screen.queryByRole('button', { name: /export ndjson/i })).not.toBeInTheDocument();
  });

  it('is present once the persistent source is selected', async () => {
    render(
      <LogsPage
        active
        durableLogSource={createLogSource([])}
        logSource={createLogSource([])}
        onExportDurableNdjson={vi.fn(async () => makeExportResult(''))}
      />
    );

    await selectPersistentSource();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /export ndjson/i })).toBeInTheDocument();
    });
  });

  it('stays absent in persistent mode when onExportDurableNdjson is not supplied', async () => {
    render(
      <LogsPage active durableLogSource={createLogSource([])} logSource={createLogSource([])} />
    );

    await selectPersistentSource();

    await waitFor(() => {
      expect(screen.getByText('No durable warn+ events recorded.')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /export ndjson/i })).not.toBeInTheDocument();
  });

  it('clicking it invokes the export and triggers a Blob-anchor download', async () => {
    const ndjsonPayload = '{"id":"evt-1"}\n';
    const onExportDurableNdjson = vi.fn(async () => makeExportResult(ndjsonPayload));

    let exportedBlob: Blob | null = null;
    const createObjectUrlSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation((blob: Blob | MediaSource) => {
        exportedBlob = blob as Blob;
        return 'blob:ndjson-export';
      });
    const revokeObjectUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    try {
      render(
        <LogsPage
          active
          durableLogSource={createLogSource([])}
          logSource={createLogSource([])}
          onExportDurableNdjson={onExportDurableNdjson}
        />
      );

      const user = await selectPersistentSource();
      const exportButton = await screen.findByRole('button', { name: /export ndjson/i });
      await user.click(exportButton);

      await waitFor(() => expect(onExportDurableNdjson).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(createObjectUrlSpy).toHaveBeenCalledTimes(1));
      expect(exportedBlob).not.toBeNull();
      expect((exportedBlob as unknown as Blob).type).toBe('application/x-ndjson');
      expect(await (exportedBlob as unknown as Blob).text()).toBe(ndjsonPayload);
      expect(anchorClickSpy).toHaveBeenCalledTimes(1);
      // The download manager resolves the blob URL asynchronously after the
      // click, so `downloadBlobFile` holds the URL alive for a wall-clock
      // grace period — it must NOT be revoked in the click's wake. The pending
      // revoke timer intentionally outlives this test (it runs on real
      // timers); the assertion is scoped to THIS export's URL so a stale
      // revoke firing during a later test in a >60s file run stays harmless.
      expect(revokeObjectUrlSpy).not.toHaveBeenCalledWith('blob:ndjson-export');
    } finally {
      createObjectUrlSpy.mockRestore();
      revokeObjectUrlSpy.mockRestore();
      anchorClickSpy.mockRestore();
    }
  });

  // Pins FIX 4 (no silent caps): a truncated export must say so in BOTH the
  // downloaded filename and a visible toast, per
  // docs/archive/agent-contract-history/platform-contracts/log-viewer-sources.md
  // and AGENTS.md's "make failure visible" rule.
  it('suffixes the filename and shows a truncation toast with the N of M counts when the export was truncated', async () => {
    const ndjsonPayload = '{"id":"evt-1"}\n';
    const onExportDurableNdjson = vi.fn(async () =>
      makeExportResult(ndjsonPayload, { exportedCount: 2000, totalCount: 5000, truncated: true })
    );

    // Same pattern as packages/app-shell/src/__tests__/use-export-handlers.test.ts:
    // a real anchor element stands in for every `document.createElement('a')`
    // call so `anchor.download` can be inspected directly, without fighting
    // `createElement`'s overloaded DOM typings.
    const originalCreateElement = document.createElement.bind(document);
    const mockAnchor = originalCreateElement('a');
    const anchorClickSpy = vi.spyOn(mockAnchor, 'click').mockImplementation(() => {});
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation(((tagName: string) =>
        tagName === 'a'
          ? mockAnchor
          : originalCreateElement(tagName)) as typeof document.createElement);
    const createObjectUrlSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:truncated-export');
    const revokeObjectUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    try {
      render(
        <LogsPage
          active
          durableLogSource={createLogSource([])}
          logSource={createLogSource([])}
          onExportDurableNdjson={onExportDurableNdjson}
        />
      );

      const user = await selectPersistentSource();
      const exportButton = await screen.findByRole('button', { name: /export ndjson/i });
      await user.click(exportButton);

      await waitFor(() =>
        expect(toastMock).toHaveBeenCalledWith(
          expect.objectContaining({
            description:
              'Exported the most recent 2000 of 5000 warn+ events. Older events were not included.',
            title: 'Export truncated',
          })
        )
      );
      expect(mockAnchor.download).toMatch(
        /^brainstrike-errors-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-recent2000\.ndjson$/
      );
      // Windows rejects `:`; a raw ISO timestamp here gets silently mangled.
      expect(mockAnchor.download).not.toMatch(/[<>:"/\\|?*]/);
    } finally {
      createElementSpy.mockRestore();
      createObjectUrlSpy.mockRestore();
      revokeObjectUrlSpy.mockRestore();
      anchorClickSpy.mockRestore();
    }
  });

  it('surfaces a rejected export visibly via toast instead of failing silently', async () => {
    const onExportDurableNdjson = vi.fn(async () => {
      throw new Error('database unavailable');
    });

    render(
      <LogsPage
        active
        durableLogSource={createLogSource([])}
        logSource={createLogSource([])}
        onExportDurableNdjson={onExportDurableNdjson}
      />
    );

    const user = await selectPersistentSource();
    const exportButton = await screen.findByRole('button', { name: /export ndjson/i });
    await user.click(exportButton);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          description: INTERNAL_FAULT.message,
          title: 'Failed to export diagnostics',
          variant: 'destructive',
        })
      )
    );
  });

  it('skips the download and shows a non-destructive toast when there are no events to export', async () => {
    const onExportDurableNdjson = vi.fn(async () => makeExportResult(''));
    const createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL');
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    try {
      render(
        <LogsPage
          active
          durableLogSource={createLogSource([])}
          logSource={createLogSource([])}
          onExportDurableNdjson={onExportDurableNdjson}
        />
      );

      const user = await selectPersistentSource();
      const exportButton = await screen.findByRole('button', { name: /export ndjson/i });
      await user.click(exportButton);

      await waitFor(() => expect(onExportDurableNdjson).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(toastMock).toHaveBeenCalledWith(
          expect.objectContaining({
            description: 'There are no durable warn+ events to export.',
            title: 'No diagnostics to export',
          })
        )
      );
      const [toastCall] = toastMock.mock.calls[0] ?? [];
      expect(toastCall?.variant).not.toBe('destructive');
      expect(createObjectUrlSpy).not.toHaveBeenCalled();
      expect(anchorClickSpy).not.toHaveBeenCalled();
    } finally {
      createObjectUrlSpy.mockRestore();
      anchorClickSpy.mockRestore();
    }
  });

  it('disables the export button while an export is in flight and re-enables it once it resolves', async () => {
    let resolveExport: ((value: DurableNdjsonExportResult) => void) | undefined;
    const onExportDurableNdjson = vi.fn(
      () =>
        new Promise<DurableNdjsonExportResult>((resolve) => {
          resolveExport = resolve;
        })
    );
    const createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:in-flight');
    const revokeObjectUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    try {
      render(
        <LogsPage
          active
          durableLogSource={createLogSource([])}
          logSource={createLogSource([])}
          onExportDurableNdjson={onExportDurableNdjson}
        />
      );

      const user = await selectPersistentSource();
      const exportButton = await screen.findByRole('button', { name: /export ndjson/i });
      expect(exportButton).not.toBeDisabled();

      await user.click(exportButton);

      await waitFor(() => expect(exportButton).toBeDisabled());
      expect(onExportDurableNdjson).toHaveBeenCalledTimes(1);

      resolveExport?.(makeExportResult('{"id":"evt-1"}\n'));

      await waitFor(() => expect(exportButton).not.toBeDisabled());
    } finally {
      createObjectUrlSpy.mockRestore();
      revokeObjectUrlSpy.mockRestore();
      anchorClickSpy.mockRestore();
    }
  });

  it('re-enables the export button after a rejected export', async () => {
    let rejectExport: ((reason: Error) => void) | undefined;
    const onExportDurableNdjson = vi.fn(
      () =>
        new Promise<DurableNdjsonExportResult>((_resolve, reject) => {
          rejectExport = reject;
        })
    );

    render(
      <LogsPage
        active
        durableLogSource={createLogSource([])}
        logSource={createLogSource([])}
        onExportDurableNdjson={onExportDurableNdjson}
      />
    );

    const user = await selectPersistentSource();
    const exportButton = await screen.findByRole('button', { name: /export ndjson/i });
    expect(exportButton).not.toBeDisabled();

    await user.click(exportButton);

    await waitFor(() => expect(exportButton).toBeDisabled());

    rejectExport?.(new Error('database unavailable'));

    await waitFor(() => expect(exportButton).not.toBeDisabled());
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Failed to export diagnostics' })
      )
    );
  });
});

describe('LogsPage visibility', () => {
  it('reads nothing while hidden, reads once shown and stops when hidden again', async () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const getInitialRecords = vi.fn(async () => [] as readonly LogRecord[]);
    const source: LogSourceAdapter = { getInitialRecords, subscribe };

    const { rerender } = render(<LogsPage active={false} logSource={source} />);
    expect(getInitialRecords).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Log Viewer' })).not.toBeInTheDocument();

    rerender(<LogsPage active logSource={source} />);
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    expect(getInitialRecords).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('region', { name: 'Log Viewer' })).toBeInTheDocument();

    rerender(<LogsPage active={false} logSource={source} />);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('names a stopped durable sink above the viewer', () => {
    render(
      <LogsPage
        active
        logSource={createLogSource([])}
        sinkHealthReason="Failed to insert diagnostic events: disk is full"
      />
    );

    const banner = screen.getByTestId('diagnostic-sink-health-banner');
    expect(banner).toHaveTextContent('Failed to insert diagnostic events: disk is full');
    expect(
      banner.compareDocumentPosition(screen.getByRole('region', { name: 'Log Viewer' })) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});
