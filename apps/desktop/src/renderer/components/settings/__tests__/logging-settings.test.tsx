// @vitest-environment jsdom
import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import {
  LOGS_APP_ID,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import {
  createDefaultLoggingPreferences,
  type LoggingPreferences,
  LogLevel,
} from '@brainstrike/logging';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { LoggingSettingsPayload } from '../../../../logging-shared';
import { DesktopLoggingSettings } from '../logging-settings';

const toastSpy = vi.fn();

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    useToast: () => ({ toast: toastSpy }),
  };
});

const defaults = createDefaultLoggingPreferences({
  consoleLevel: LogLevel.WARN,
  includeTimestamp: true,
  level: LogLevel.INFO,
});
let broadcast: ((preferences: LoggingPreferences) => void) | undefined;

describe('DesktopLoggingSettings', () => {
  beforeEach(() => {
    toastSpy.mockReset();
    broadcast = undefined;
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
          defaults,
          preferences,
        },
      }),
      onDurableRecord: vi.fn(() => () => undefined),
      onPreferencesUpdated: vi.fn((callback: (next: LoggingPreferences) => void) => {
        broadcast = callback;
        return () => undefined;
      }),
      openDestination: vi.fn().mockResolvedValue({ ok: true, value: true }),
      selectDestination: vi.fn().mockResolvedValue({ ok: true, value: '/tmp/desktop.log' }),
      setPreferences: vi.fn(async (nextPreferences: LoggingPreferences) => ({
        ok: true,
        value: {
          capabilities,
          defaults,
          preferences: nextPreferences,
        },
      })),
    } as unknown as Window['logging'];
  });

  afterEach(() => {
    useWorkspaceTabSelectionStore.getState().reset();
    usePanelLayoutStore.setState({ activeTab: 'explorer' });
    Reflect.deleteProperty(window, 'logging');
  });

  it('loads preferences and updates them through the bridge', async () => {
    render(<DesktopLoggingSettings />);

    await waitFor(() => expect(window.logging?.getPreferences).toHaveBeenCalledTimes(1));

    const consoleSwitch = await screen.findByRole('switch', { name: /console logging/iu });
    expect(consoleSwitch).toBeChecked();

    fireEvent.click(consoleSwitch);

    await waitFor(() => expect(window.logging?.setPreferences).toHaveBeenCalledTimes(1));
    const setPreferencesMock = window.logging?.setPreferences as unknown as Mock;
    const sentPreferences = setPreferencesMock.mock.calls[0]?.[0];
    expect(sentPreferences.consoleEnabled).toBe(false);
    await waitFor(() => expect(consoleSwitch).not.toBeChecked());
  });

  it('shows a change another window committed, as Main broadcasts it', async () => {
    render(<DesktopLoggingSettings />);
    const timestampSwitch = await screen.findByRole('switch', { name: /include timestamp/iu });
    expect(timestampSwitch).toBeChecked();

    act(() => {
      broadcast?.({ ...defaults, includeTimestamp: false });
    });

    expect(timestampSwitch).not.toBeChecked();
  });

  it("restores Main's defaults", async () => {
    render(<DesktopLoggingSettings />);

    fireEvent.click(await screen.findByRole('button', { name: /reset/iu }));

    await waitFor(() => expect(window.logging?.setPreferences).toHaveBeenCalledWith(defaults));
    expect(toastSpy).toHaveBeenCalledWith({ title: 'Logging preferences reset' });
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
      expect(screen.getByText(/logging configuration is unavailable/iu)).toBeInTheDocument()
    );
    expect(screen.getByText(INTERNAL_FAULT.message)).toBeInTheDocument();
  });

  it('keeps configuration here and opens the log viewer in the Logs tab', async () => {
    usePanelLayoutStore.getState().openSettings();
    render(<DesktopLoggingSettings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Logs' }));

    expect(screen.queryByRole('region', { name: 'Log Viewer' })).not.toBeInTheDocument();
    expect(window.logging?.getBufferedLogs).not.toHaveBeenCalled();
    expect(usePanelLayoutStore.getState().activeTab).toBe('explorer');
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: LOGS_APP_ID,
      kind: 'app',
    });
  });
});
