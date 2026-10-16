// @vitest-environment jsdom
import { openLogsTab } from '@brainstrike/app-shell/diagnostics';
import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { LogLevel, type LogRecord } from '@brainstrike/logging';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRendererLogBuffer } from '../../log-buffer';
import { LogsPageContent } from '../logs-page-content';

const toastSpy = vi.fn();

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    useToast: () => ({ toast: toastSpy }),
  };
});

vi.mock('@tanstack/react-virtual', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-virtual')>('@tanstack/react-virtual');
  return {
    ...actual,
    useVirtualizer: ({ count }: { count: number }) => ({
      getTotalSize: () => count * 30,
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({
          end: (index + 1) * 30,
          index,
          key: index,
          measureElement: () => undefined,
          size: 30,
          start: index * 30,
        })),
      measureElement: () => undefined,
      scrollToIndex: () => undefined,
    }),
  };
});

describe('desktop Logs tab', () => {
  beforeEach(() => {
    getRendererLogBuffer().resume();
    getRendererLogBuffer().clear();
    toastSpy.mockReset();
    window.logging = {
      getBufferedLogs: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      onDurableRecord: vi.fn(() => () => undefined),
    } as unknown as Window['logging'];
    openLogsTab();
  });

  afterEach(() => {
    getRendererLogBuffer().resume();
    getRendererLogBuffer().clear();
    useWorkspaceTabSelectionStore.getState().reset();
    usePanelLayoutStore.setState({ activeTab: 'explorer' });
    (window as unknown as { logging?: Window['logging'] }).logging = undefined;
  });

  it("shows this renderer's logs beside Electron main's buffered logs", async () => {
    getRendererLogBuffer().push(createLogRecord('renderer diagnostic', 'electron-renderer'));
    const logging = window.logging;
    if (!logging) {
      throw new Error('Expected the logging bridge to be available.');
    }
    logging.getBufferedLogs = vi.fn().mockResolvedValue({
      ok: true,
      value: [createLogRecord('main diagnostic', 'electron-main')],
    });

    render(<LogsPageContent />);

    await waitFor(
      () => {
        expect(screen.getByText('renderer diagnostic')).toBeInTheDocument();
        expect(screen.getByText('main diagnostic')).toBeInTheDocument();
      },
      { timeout: 10_000 }
    );
  });

  it('does not fetch Main again when a failed snapshot logs to the renderer subscription', async () => {
    const readMain = vi
      .fn()
      .mockRejectedValueOnce(new Error('private Main failure'))
      .mockResolvedValue({ ok: true, value: [] });
    window.logging.getBufferedLogs = readMain;
    render(<LogsPageContent />);

    await screen.findByText('Electron main logs unavailable');
    act(() =>
      getRendererLogBuffer().push(createLogRecord('later renderer record', 'electron-renderer'))
    );
    await screen.findByText('later renderer record');
    expect(readMain).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Electron main logs unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Logs' }));
    await waitFor(() =>
      expect(screen.queryByText('Electron main logs unavailable')).not.toBeInTheDocument()
    );
    expect(readMain).toHaveBeenCalledTimes(2);
  });

  it('keeps the failed snapshot remedy visible through live Main records until Refresh succeeds', async () => {
    const readMain = vi
      .fn()
      .mockResolvedValueOnce({
        error: {
          category: 'availability',
          code: 'logging.unavailable',
          kind: 'refusal',
          message: 'The log source is unavailable.',
          remedy: 'Refresh after reconnecting.',
        },
        ok: false,
      })
      .mockResolvedValue({ ok: true, value: [] });
    window.logging.getBufferedLogs = readMain;
    let receiveMain: ((record: LogRecord) => void) | undefined;
    const unsubscribe = vi.fn();
    window.logging.onDurableRecord = (listener) => {
      receiveMain = listener;
      return unsubscribe;
    };
    const { unmount } = render(<LogsPageContent />);
    await screen.findByText('Refresh after reconnecting.', { exact: false });
    act(() => receiveMain?.(createLogRecord('live Main record', 'electron-main')));
    await screen.findByText('live Main record');
    expect(screen.getByText('Refresh after reconnecting.', { exact: false })).toBeInTheDocument();
    expect(readMain).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Logs' }));
    await waitFor(() =>
      expect(screen.queryByText('Electron main logs unavailable')).not.toBeInTheDocument()
    );
    expect(readMain).toHaveBeenCalledTimes(2);
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('renders an explicit diagnostic when Electron main buffered logs cannot be loaded', async () => {
    getRendererLogBuffer().push(createLogRecord('renderer diagnostic', 'electron-renderer'));
    const logging = window.logging;
    if (!logging) {
      throw new Error('Expected the logging bridge to be available.');
    }
    logging.getBufferedLogs = vi.fn().mockRejectedValue(new Error('main bridge failed'));

    render(<LogsPageContent />);

    await waitFor(() => {
      expect(screen.getByText('renderer diagnostic')).toBeInTheDocument();
      expect(screen.getByText('Electron main logs unavailable')).toBeInTheDocument();
      expect(screen.getByText(INTERNAL_FAULT.message, { exact: false })).toBeInTheDocument();
    });
  });
});

function createLogRecord(message: string, runtime: string): LogRecord {
  return {
    args: [],
    bindings: { runtime },
    level: LogLevel.INFO,
    message,
    scope: 'LoggingSettingsTest',
    timestamp: Date.now(),
  };
}
