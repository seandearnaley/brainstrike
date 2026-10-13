import {
  __resetLoggingPreferencesStoreForTests,
  useLoggingPreferencesStore,
} from '@brainstrike/app-state/stores/logging-preferences-store';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import {
  createDefaultLoggingPreferences,
  type LoggingPreferences,
  LogLevel,
  type LogRecord,
} from '@brainstrike/logging';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { LoggingSettingsPayload } from '../../../../logging-shared';
import { getRendererLogBuffer } from '../../../log-buffer';
import { DesktopLoggingSettings } from '../logging-settings';

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

describe('DesktopLoggingSettings', () => {
  beforeEach(() => {
    __resetLoggingPreferencesStoreForTests();
    getRendererLogBuffer().resume();
    getRendererLogBuffer().clear();
    toastSpy.mockReset();
    const preferences = createDefaultLoggingPreferences({
      consoleLevel: LogLevel.INFO,
      file: {
        append: true,
        destination: '/tmp/default.log',
        enabled: true,
        level: LogLevel.DEBUG,
        mkdir: true,
      },
      includeTimestamp: true,
      level: LogLevel.INFO,
    });

    const capabilities: LoggingSettingsPayload['capabilities'] = {
      canSelectDestination: true,
      defaultDestination: '/tmp/default.log',
      fileLoggingSupported: true,
      reason: null,
      runtime: 'electron',
    };

    window.logging = {
      getBufferedLogs: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      getPreferences: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          capabilities,
          preferences,
        },
      }),
      onDurableRecord: vi.fn(() => () => undefined),
      openDestination: vi.fn().mockResolvedValue({ ok: true, value: true }),
      selectDestination: vi.fn().mockResolvedValue({ ok: true, value: '/tmp/desktop.log' }),
      setPreferences: vi.fn(async (nextPreferences: LoggingPreferences) => ({
        ok: true,
        value: {
          capabilities,
          preferences: nextPreferences,
        },
      })),
    } as unknown as Window['logging'];
  });

  afterEach(() => {
    getRendererLogBuffer().resume();
    getRendererLogBuffer().clear();
    (window as unknown as { logging?: Window['logging'] }).logging = undefined;
  });

  it('loads preferences and updates them through the bridge', async () => {
    render(<DesktopLoggingSettings />);

    await waitFor(() => expect(window.logging?.getPreferences).toHaveBeenCalledTimes(1));

    const consoleSwitch = await screen.findByRole('switch', { name: /console logging/i });
    expect(consoleSwitch).toBeChecked();

    fireEvent.click(consoleSwitch);

    await waitFor(() => expect(window.logging?.setPreferences).toHaveBeenCalledTimes(1));
    const setPreferencesMock = window.logging?.setPreferences as unknown as Mock;
    const sentPreferences = setPreferencesMock.mock.calls[0]?.[0];
    expect(sentPreferences.consoleEnabled).toBe(false);
    expect(useLoggingPreferencesStore.getState().preferences.consoleEnabled).toBe(false);
  });

  it('renders an error card when loading fails', async () => {
    window.logging = {
      getBufferedLogs: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      getPreferences: vi.fn().mockRejectedValue(new Error('load failed')),
      onDurableRecord: vi.fn(() => () => undefined),
      openDestination: vi.fn(),
      selectDestination: vi.fn(),
      setPreferences: vi.fn(),
    } as unknown as Window['logging'];

    render(<DesktopLoggingSettings />);

    await waitFor(() =>
      expect(screen.getByText(/logging configuration is unavailable/i)).toBeInTheDocument()
    );
    expect(screen.getByText(INTERNAL_FAULT.message)).toBeInTheDocument();
  });

  it('includes Electron main buffered logs in the desktop log viewer source', async () => {
    getRendererLogBuffer().push(createLogRecord('renderer diagnostic', 'electron-renderer'));
    const logging = window.logging;
    if (!logging) {
      throw new Error('Expected the logging bridge to be available.');
    }
    logging.getBufferedLogs = vi.fn().mockResolvedValue({
      ok: true,
      value: [createLogRecord('main diagnostic', 'electron-main')],
    });

    render(<DesktopLoggingSettings />);

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
    render(<DesktopLoggingSettings />);

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
    const { unmount } = render(<DesktopLoggingSettings />);
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

    render(<DesktopLoggingSettings />);

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
