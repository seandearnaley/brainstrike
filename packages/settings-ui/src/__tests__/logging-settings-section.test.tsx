// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  createDefaultLoggingPreferences,
  type LoggingPreferencesPatch,
  LogLevel,
} from '@brainstrike/logging';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ComponentProps, useState } from 'react';
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

const defaults = createDefaultLoggingPreferences({
  consoleLevel: LogLevel.WARN,
  includeTimestamp: true,
  level: LogLevel.INFO,
});
const initial = createDefaultLoggingPreferences({ includeTimestamp: false, level: LogLevel.DEBUG });

type SectionProps = ComponentProps<typeof LoggingSettingsSection>;

/** The section over a writer that merges each committed change into what it holds, as Main does. */
function renderWithWriter(
  props: Partial<SectionProps> = {},
  write: (patch: LoggingPreferencesPatch) => Promise<void> = async () => {}
) {
  const committed: LoggingPreferencesPatch[] = [];
  function Harness() {
    const [preferences, setPreferences] = useState(props.preferences ?? initial);
    return (
      <LoggingSettingsSection
        defaults={defaults}
        onCommitPreferences={async (patch) => {
          committed.push(patch);
          await write(patch);
          setPreferences((held) => ({ ...held, ...patch, file: { ...held.file, ...patch.file } }));
        }}
        preferences={preferences}
        runtime="electron-renderer"
        {...props}
      />
    );
  }
  render(<Harness />);
  return committed;
}

const fileCapabilities = {
  canSelectDestination: true,
  defaultDestination: '/var/log/brainstrike.log',
  fileLoggingSupported: true,
};

describe('LoggingSettingsSection', () => {
  beforeEach(() => {
    toastSpy.mockReset();
  });

  it('commits a changed switch and shows what the writer holds', async () => {
    const committed = renderWithWriter();

    const consoleSwitch = screen.getByRole('switch', { name: /console logging/iu });
    expect(consoleSwitch).toBeChecked();
    fireEvent.click(consoleSwitch);

    await waitFor(() => expect(consoleSwitch).not.toBeChecked());
    expect(committed).toEqual([{ consoleEnabled: false }]);
  });

  it("restores the writer's defaults", async () => {
    const committed = renderWithWriter();

    fireEvent.click(screen.getByRole('button', { name: /reset/iu }));

    await waitFor(() => expect(committed).toEqual([defaults]));
    expect(toastSpy).toHaveBeenCalledWith({ title: 'Logging preferences reset' });
  });

  it('commits a chosen file destination, enabling file logging', async () => {
    const committed = renderWithWriter({
      fileCapabilities,
      onSelectLogDestination: async () => '/tmp/brainstrike.log',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }));

    // Only the change is committed, so a change another window made while the picker
    // was open survives: the writer merges this into the record it holds.
    await waitFor(() => expect(committed).toHaveLength(1));
    expect(committed[0]).toEqual({ file: { destination: '/tmp/brainstrike.log', enabled: true } });
  });

  it('commits redacted fields when the field loses focus, keeping what was typed until then', async () => {
    const committed = renderWithWriter();
    const redactInput = screen.getByLabelText(/redacted fields/iu);

    fireEvent.change(redactInput, { target: { value: 'token, ' } });
    expect(redactInput).toHaveValue('token, ');
    fireEvent.change(redactInput, { target: { value: 'token, password' } });
    expect(committed).toEqual([]);
    fireEvent.blur(redactInput);

    await waitFor(() => expect(committed).toHaveLength(1));
    expect(committed[0]?.redactPaths).toEqual(['token', 'password']);
    await waitFor(() => expect(redactInput).toHaveValue('token, password'));
  });

  it('shows an error toast when opening destination fails', async () => {
    const onOpen = vi.fn(async () => false);
    renderWithWriter({
      fileCapabilities,
      onOpenLogDestination: onOpen,
      preferences: {
        ...initial,
        file: { ...initial.file, destination: '/tmp/existing.log', enabled: true },
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /open destination/iu }));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('/tmp/existing.log'));
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Unable to open log file' })
    );
  });

  it('keeps showing what the writer holds when a commit fails, and says so once', async () => {
    const committed = renderWithWriter({}, async () => {
      throw new Error('simulated failure');
    });
    const consoleSwitch = screen.getByRole('switch', { name: /console logging/iu });

    fireEvent.click(consoleSwitch);

    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Failed to update logging preferences' })
    );
    expect(committed).toHaveLength(1);
    expect(consoleSwitch).toBeChecked();
    expect(consoleSwitch).toBeEnabled();
  });

  it('returns redacted fields to what the writer holds when their commit fails', async () => {
    renderWithWriter({}, async () => {
      throw new Error('simulated failure');
    });
    const redactInput = screen.getByLabelText(/redacted fields/iu);

    fireEvent.change(redactInput, { target: { value: 'token' } });
    fireEvent.blur(redactInput);

    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByLabelText(/redacted fields/iu)).toHaveValue(''));
  });

  it('leaves the log source and its export to the Logs page', () => {
    renderWithWriter({ runtime: 'browser' });

    expect(screen.queryByText('Persistent errors')).not.toBeInTheDocument();
    expect(screen.queryByText('Session')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /export ndjson/iu })).not.toBeInTheDocument();
  });
});
