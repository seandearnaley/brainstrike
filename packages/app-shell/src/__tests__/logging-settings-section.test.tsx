import {
  __resetLoggingPreferencesStoreForTests,
  useLoggingPreferencesStore,
} from '@brainstrike/preferences';
import { type LoggingPreferences, LogLevel } from '@brainstrike/utils';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggingSettingsSection } from '../logging/logging-settings-section';

const toastSpy = vi.fn();

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
      <button type="button" onClick={() => ctx?.select(value)}>
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
      id={id}
      role="switch"
      type="checkbox"
      checked={Boolean(checked)}
      aria-checked={Boolean(checked)}
      disabled={disabled}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
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

    render(<LoggingSettingsSection runtime="browser" onCommitPreferences={onCommit} />);

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
        runtime="browser"
        onCommitPreferences={onCommit}
        onResetPreferences={onReset}
      />
    );

    // change state first
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
        runtime="electron-renderer"
        onCommitPreferences={onCommit}
        onSelectLogDestination={onSelect}
        fileCapabilities={{
          fileLoggingSupported: true,
          canSelectDestination: true,
          defaultDestination: '/var/log/brainstrike.log',
        }}
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

    render(<LoggingSettingsSection runtime="browser" onCommitPreferences={onCommit} />);

    const redactInput = screen.getByLabelText(/redacted fields/i);
    fireEvent.change(redactInput, { target: { value: 'token, password, token' } });

    await waitFor(() => expect(onCommit).toHaveBeenCalled());
    expect(useLoggingPreferencesStore.getState().preferences.redactPaths).toEqual([
      'token',
      'password',
      'token',
    ]);
  });

  it('does not revert newer updates when an earlier commit fails later', async () => {
    let rejectFirst: ((reason?: unknown) => void) | null = null;
    const onCommit = vi.fn((preferences: LoggingPreferences) => {
      if (!rejectFirst) {
        return new Promise<LoggingPreferences>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return Promise.resolve(preferences);
    });

    render(<LoggingSettingsSection runtime="browser" onCommitPreferences={onCommit} />);

    const consoleSwitch = screen.getByRole('switch', { name: /console logging/i });
    fireEvent.click(consoleSwitch);
    expect(onCommit).toHaveBeenCalledTimes(1);

    const timestampSwitch = screen.getByRole('switch', { name: /include timestamp/i });
    fireEvent.click(timestampSwitch);

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));

    rejectFirst?.(new Error('simulated failure'));

    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    const state = useLoggingPreferencesStore.getState().preferences;
    expect(state.consoleEnabled).toBe(false);
    expect(state.includeTimestamp).toBe(true);
  });
});
