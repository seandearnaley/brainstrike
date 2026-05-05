import {
  __resetLoggingPreferencesStoreForTests,
  useLoggingPreferencesStore,
} from '@brainstrike/preferences';
import {
  createDefaultLoggingPreferences,
  type LoggingPreferences,
  LogLevel,
  type LogRecord,
} from '@brainstrike/utils';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

declare global {
  interface Window {
    logging?: {
      getPreferences: () => Promise<LoggingSettingsPayload>;
      getBufferedLogs: () => Promise<LogRecord[]>;
      setPreferences: (preferences: LoggingPreferences) => Promise<LoggingSettingsPayload>;
      selectDestination: () => Promise<string | null>;
      openDestination: (target: string | null) => Promise<boolean>;
    };
  }
}

describe('DesktopLoggingSettings', () => {
  beforeEach(() => {
    __resetLoggingPreferencesStoreForTests();
    toastSpy.mockReset();
    const preferences = createDefaultLoggingPreferences({
      level: LogLevel.INFO,
      consoleLevel: LogLevel.INFO,
      includeTimestamp: true,
      file: {
        enabled: true,
        destination: '/tmp/default.log',
        level: LogLevel.DEBUG,
        append: true,
        mkdir: true,
      },
    });

    const capabilities: LoggingSettingsPayload['capabilities'] = {
      runtime: 'electron',
      fileLoggingSupported: true,
      canSelectDestination: true,
      defaultDestination: '/tmp/default.log',
      reason: null,
    };

    window.logging = {
      getPreferences: vi.fn().mockResolvedValue({
        preferences,
        capabilities,
      }),
      getBufferedLogs: vi.fn().mockResolvedValue([]),
      setPreferences: vi.fn(async (nextPreferences: LoggingPreferences) => ({
        preferences: nextPreferences,
        capabilities,
      })),
      selectDestination: vi.fn().mockResolvedValue('/tmp/desktop.log'),
      openDestination: vi.fn().mockResolvedValue(true),
    };
  });

  afterEach(() => {
    getRendererLogBuffer().clear();
    window.logging = undefined;
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
      getPreferences: vi.fn().mockRejectedValue(new Error('load failed')),
      getBufferedLogs: vi.fn().mockResolvedValue([]),
      setPreferences: vi.fn(),
      selectDestination: vi.fn(),
      openDestination: vi.fn(),
    };

    render(<DesktopLoggingSettings />);

    await waitFor(() =>
      expect(screen.getByText(/logging configuration is unavailable/i)).toBeInTheDocument()
    );
    expect(screen.getByText('load failed')).toBeInTheDocument();
  });

  it('includes Electron main buffered logs in the desktop log viewer source', async () => {
    getRendererLogBuffer().push(createLogRecord('renderer diagnostic', 'electron-renderer'));
    window.logging!.getBufferedLogs = vi
      .fn()
      .mockResolvedValue([createLogRecord('main diagnostic', 'electron-main')]);

    render(<DesktopLoggingSettings />);

    await waitFor(() => {
      expect(screen.getByText('renderer diagnostic')).toBeInTheDocument();
      expect(screen.getByText('main diagnostic')).toBeInTheDocument();
    });
  });

  it('renders an explicit diagnostic when Electron main buffered logs cannot be loaded', async () => {
    getRendererLogBuffer().push(createLogRecord('renderer diagnostic', 'electron-renderer'));
    window.logging!.getBufferedLogs = vi.fn().mockRejectedValue(new Error('main bridge failed'));

    render(<DesktopLoggingSettings />);

    await waitFor(() => {
      expect(screen.getByText('renderer diagnostic')).toBeInTheDocument();
      expect(screen.getByText('Electron main logs unavailable')).toBeInTheDocument();
      expect(screen.getByText(/main bridge failed/)).toBeInTheDocument();
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
