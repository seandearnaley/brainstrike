import '@testing-library/jest-dom/vitest';
import {
  __resetLoggingPreferencesStoreForTests,
  useLoggingPreferencesStore,
} from '@brainstrike/app-state/stores/logging-preferences-store';
import { type LoggingPreferences, LogLevel } from '@brainstrike/logging';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggingSettingsSection } from '../settings/system/logging-settings-section';

const toastSpy = vi.fn();

vi.mock('lucide-react', () => ({
  FolderOpen: () => <span>Open destination</span>,
  RefreshCw: () => <span>Reset Icon</span>,
}));

vi.mock('@brainstrike/ui', async () => {
  const React = await import('react');
  const SelectContext = React.createContext<{ select: (value: string) => void } | null>(null);

  const Select = ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children: React.ReactNode;
  }) => {
    const contextValue = React.useMemo(
      () => ({
        select: (next: string) => {
          onValueChange?.(next);
        },
      }),
      [onValueChange]
    );

    return (
      <SelectContext.Provider value={contextValue}>
        <div data-testid={`mock-select-${value ?? 'unset'}`}>{children}</div>
      </SelectContext.Provider>
    );
  };

  const SelectTrigger = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const SelectValue = ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder ?? ''}</span>
  );
  const SelectContent = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const SelectItem = ({ value, children }: { value: string; children: React.ReactNode }) => {
    const ctx = React.useContext(SelectContext);
    return (
      <button onClick={() => ctx?.select(value)} type="button">
        {children}
      </button>
    );
  };

  const Button = ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  );
  const Card = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const CardHeader = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const CardTitle = ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>;
  const CardDescription = ({ children }: { children: React.ReactNode }) => <p>{children}</p>;
  const CardContent = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const Input = ({ id, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input id={id} {...props} />
  );
  const Label = ({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) => (
    <label htmlFor={htmlFor}>{children}</label>
  );
  const Badge = ({ children }: { children: React.ReactNode }) => <span>{children}</span>;

  const Switch = ({
    id,
    checked,
    onCheckedChange,
    disabled,
  }: {
    id?: string;
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    disabled?: boolean;
  }) => (
    <input
      aria-checked={Boolean(checked)}
      checked={Boolean(checked)}
      disabled={disabled}
      id={id}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      role="switch"
      type="checkbox"
    />
  );

  return {
    Badge,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
    useToast: () => ({ toast: toastSpy }),
  };
});

describe('LoggingSettingsSection', () => {
  beforeEach(() => {
    __resetLoggingPreferencesStoreForTests();
    toastSpy.mockReset();
  });

  it('updates console logging preference and commits changes', async () => {
    const onCommit = vi.fn(async (preferences) => preferences);

    render(<LoggingSettingsSection onCommitPreferences={onCommit} runtime="browser" />);

    const consoleSwitch = screen.getByRole('switch', { name: /console logging/i });
    expect(consoleSwitch).toBeChecked();

    fireEvent.click(consoleSwitch);

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit.mock.calls[0]?.[0].consoleEnabled).toBe(false);
    expect(useLoggingPreferencesStore.getState().preferences.consoleEnabled).toBe(false);
  });

  it('resets preferences and invokes reset handler', async () => {
    const onCommit = vi.fn(async (preferences) => preferences);
    const onReset = vi.fn(async () => {});

    render(
      <LoggingSettingsSection
        onCommitPreferences={onCommit}
        onResetPreferences={onReset}
        runtime="browser"
      />
    );

    fireEvent.click(screen.getByRole('switch', { name: /console logging/i }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /reset/i }));

    await waitFor(() => expect(onReset).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));

    const { preferences } = useLoggingPreferencesStore.getState();
    expect(preferences.level).toBe(LogLevel.INFO);
    expect(preferences.consoleEnabled).toBe(true);
    expect(preferences.includeTimestamp).toBe(false);
    expect(preferences.file.enabled).toBe(false);
    expect(preferences.file.destination).toBeNull();
  });

  it('selects a file destination when supported', async () => {
    const onCommit = vi.fn(async (preferences) => preferences);
    const onSelect = vi.fn(async () => '/tmp/brainstrike.log');

    render(
      <LoggingSettingsSection
        fileCapabilities={{
          canSelectDestination: true,
          defaultDestination: '/var/log/brainstrike.log',
          fileLoggingSupported: true,
        }}
        onCommitPreferences={onCommit}
        onSelectLogDestination={onSelect}
        runtime="electron-renderer"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }));

    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCommit).toHaveBeenCalled());

    const { preferences } = useLoggingPreferencesStore.getState();
    expect(preferences.file.enabled).toBe(true);
    expect(preferences.file.destination).toBe('/tmp/brainstrike.log');
  });

  it('updates redact paths from text input', async () => {
    const onCommit = vi.fn(async (preferences) => preferences);

    render(<LoggingSettingsSection onCommitPreferences={onCommit} runtime="browser" />);

    const redactInput = screen.getByLabelText(/redacted fields/i);
    fireEvent.change(redactInput, { target: { value: 'token, password, token' } });

    await waitFor(() => expect(onCommit).toHaveBeenCalled());
    expect(useLoggingPreferencesStore.getState().preferences.redactPaths).toEqual([
      'token',
      'password',
      'token',
    ]);
  });

  it('shows an error toast when opening destination fails', async () => {
    const onCommit = vi.fn(async (preferences) => preferences);
    const onOpen = vi.fn(async () => false);

    useLoggingPreferencesStore.setState({
      preferences: {
        ...useLoggingPreferencesStore.getState().preferences,
        file: {
          ...useLoggingPreferencesStore.getState().preferences.file,
          destination: '/tmp/existing.log',
          enabled: true,
        },
      },
    });

    render(
      <LoggingSettingsSection
        fileCapabilities={{
          canSelectDestination: true,
          defaultDestination: '/var/log/brainstrike.log',
          fileLoggingSupported: true,
        }}
        onCommitPreferences={onCommit}
        onOpenLogDestination={onOpen}
        runtime="electron-renderer"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /open destination/i }));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('/tmp/existing.log'));
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Unable to open log file' })
    );
  });

  it('does not revert new updates when earlier commit fails later', async () => {
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    const onCommit = vi.fn((preferences: LoggingPreferences) => {
      if (!rejectFirst) {
        return new Promise<LoggingPreferences>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return Promise.resolve(preferences);
    });

    render(<LoggingSettingsSection onCommitPreferences={onCommit} runtime="browser" />);

    fireEvent.click(screen.getByRole('switch', { name: /console logging/i }));
    expect(onCommit).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('switch', { name: /include timestamp/i }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));

    rejectFirst?.(new Error('simulated failure'));

    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    const state = useLoggingPreferencesStore.getState().preferences;
    expect(state.consoleEnabled).toBe(false);
    expect(state.includeTimestamp).toBe(true);
  });

  it('leaves the log source and its export to the Logs page', () => {
    render(<LoggingSettingsSection onCommitPreferences={vi.fn()} runtime="browser" />);

    expect(screen.queryByText('Persistent errors')).not.toBeInTheDocument();
    expect(screen.queryByText('Session')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /export ndjson/i })).not.toBeInTheDocument();
  });
});
