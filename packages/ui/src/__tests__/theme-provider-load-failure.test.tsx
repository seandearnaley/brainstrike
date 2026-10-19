/**
 * @vitest-environment happy-dom
 */
import { addLogListener, type LogRecord } from '@brainstrike/logging';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, type ThemeStorageAdapter, useTheme } from '../theme-provider';

const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));

vi.mock('../use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../use-toast')>();
  return { ...actual, toast: toastSpy };
});

function ThemedApp() {
  const { setTheme, theme } = useTheme();
  return (
    <main>
      <p>App theme: {theme}</p>
      <button onClick={() => setTheme('dark')} type="button">
        Use dark
      </button>
    </main>
  );
}

function renderProvider(adapter: ThemeStorageAdapter) {
  return render(
    <ThemeProvider defaultTheme="light" storageAdapter={adapter} storageKey="app-theme">
      <ThemedApp />
    </ThemeProvider>
  );
}

function storageAdapter(overrides: Partial<ThemeStorageAdapter> = {}) {
  return {
    getItem: vi.fn<ThemeStorageAdapter['getItem']>().mockResolvedValue(null),
    setItem: vi.fn<ThemeStorageAdapter['setItem']>().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ThemeProvider storage failures (BST-1731)', () => {
  const logRecords: LogRecord[] = [];
  let removeLogListener: () => void;

  beforeEach(() => {
    toastSpy.mockClear();
    logRecords.length = 0;
    removeLogListener = addLogListener((record) => {
      if (record.scope === 'ThemeProvider') {
        logRecords.push(record);
      }
    });
  });

  afterEach(() => {
    removeLogListener();
  });

  it('opens the app on the saved theme when the read succeeds', async () => {
    const adapter = storageAdapter({ getItem: vi.fn().mockResolvedValue('dark') });
    renderProvider(adapter);

    expect(await screen.findByText('App theme: dark')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(adapter.getItem).toHaveBeenCalledWith('app-theme');
    expect(adapter.setItem).not.toHaveBeenCalled();
    expect(logRecords).toEqual([]);
  });

  it('shows the failure instead of a blank app, logs it, and writes nothing', async () => {
    const adapter = storageAdapter({
      getItem: vi.fn().mockRejectedValue(new Error('storage bridge unavailable')),
    });
    renderProvider(adapter);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Your theme preference couldn't be read");
    expect(alert).toHaveTextContent('storage bridge unavailable');
    expect(alert).toHaveTextContent('Your saved preference has not been changed.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Continue with the light theme' })
    ).toBeInTheDocument();
    expect(screen.queryByText(/App theme:/)).not.toBeInTheDocument();

    expect(logRecords).toHaveLength(1);
    expect(logRecords[0]?.args).toEqual([
      'Reading the saved theme preference failed',
      {
        attempt: 0,
        error: expect.objectContaining({ message: 'storage bridge unavailable' }),
        storageKey: 'app-theme',
      },
    ]);
    expect(adapter.setItem).not.toHaveBeenCalled();
  });

  it('Try again re-reads storage and opens the app on the saved theme', async () => {
    const adapter = storageAdapter({
      getItem: vi
        .fn()
        .mockRejectedValueOnce(new Error('storage bridge unavailable'))
        .mockResolvedValueOnce('dark'),
    });
    renderProvider(adapter);

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('App theme: dark')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(adapter.getItem).toHaveBeenCalledTimes(2);
    expect(adapter.setItem).not.toHaveBeenCalled();
  });

  it('Try again that fails again keeps the failure visible', async () => {
    const adapter = storageAdapter({
      getItem: vi.fn().mockRejectedValue(new Error('storage bridge unavailable')),
    });
    renderProvider(adapter);

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    await vi.waitFor(() => expect(logRecords).toHaveLength(2));
    expect(await screen.findByRole('alert')).toHaveTextContent('storage bridge unavailable');
    expect(logRecords[1]?.args[1]).toMatchObject({ attempt: 1, storageKey: 'app-theme' });
    expect(adapter.setItem).not.toHaveBeenCalled();
  });

  it('Continue opens the app on the default theme without overwriting the saved preference', async () => {
    const adapter = storageAdapter({
      getItem: vi.fn().mockRejectedValue(new Error('storage bridge unavailable')),
    });
    renderProvider(adapter);

    fireEvent.click(await screen.findByRole('button', { name: 'Continue with the light theme' }));

    expect(await screen.findByText('App theme: light')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(adapter.setItem).not.toHaveBeenCalled();
  });

  it('a failed save keeps the chosen theme, logs, and says it was not saved', async () => {
    const adapter = storageAdapter({
      setItem: vi.fn().mockRejectedValue(new Error('quota exceeded')),
    });
    renderProvider(adapter);

    fireEvent.click(await screen.findByRole('button', { name: 'Use dark' }));

    expect(await screen.findByText('App theme: dark')).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        description: 'The theme changed for this session, but it could not be saved.',
        title: 'Theme not saved',
        variant: 'destructive',
      })
    );
    expect(adapter.setItem).toHaveBeenCalledWith('app-theme', 'dark');
    expect(logRecords.map((record) => record.args)).toEqual([
      [
        'Saving the theme preference failed',
        {
          error: expect.objectContaining({ message: 'quota exceeded' }),
          storageKey: 'app-theme',
          theme: 'dark',
        },
      ],
    ]);
  });
});
