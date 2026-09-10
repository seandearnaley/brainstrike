/**
 * @vitest-environment happy-dom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, type ThemeStorageAdapter, useTheme } from '../theme-provider';

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock('@brainstrike/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: mockWarn }),
}));

function createStorage(
  seed: Record<string, string> = {}
): ThemeStorageAdapter & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: vi.fn(async (key: string) => data.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
  };
}

function wrapperFor(
  storage: ThemeStorageAdapter,
  extra: Partial<Omit<ComponentProps<typeof ThemeProvider>, 'children' | 'storageAdapter'>> = {}
) {
  return ({ children }: { children: ReactNode }) => (
    <ThemeProvider storageAdapter={storage} {...extra}>
      {children}
    </ThemeProvider>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    mockWarn.mockClear();
    document.documentElement.className = '';
    document.documentElement.dataset['theme'] = undefined;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to system mode and the brainstrike theme', async () => {
    const { result } = renderHook(() => useTheme(), { wrapper: wrapperFor(createStorage()) });
    await waitFor(() => expect(result.current.mode).toBe('system'));
    expect(result.current.theme).toBe('brainstrike');
    expect(document.documentElement.dataset['theme']).toBe('brainstrike');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('loads a persisted mode and theme from separate keys', async () => {
    const storage = createStorage({ 'ui-theme': 'light', 'ui-theme-palette': 'tide' });
    const { result } = renderHook(() => useTheme(), { wrapper: wrapperFor(storage) });
    await waitFor(() => expect(result.current.theme).toBe('tide'));
    expect(result.current.mode).toBe('light');
    expect(document.documentElement.dataset['theme']).toBe('tide');
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('persists setMode and setTheme under their own keys', async () => {
    const storage = createStorage();
    const { result } = renderHook(() => useTheme(), {
      wrapper: wrapperFor(storage, { storageKey: 'k-mode', themeStorageKey: 'k-theme' }),
    });
    await waitFor(() => expect(result.current.mode).toBe('system'));
    act(() => result.current.setMode('dark'));
    act(() => result.current.setTheme('orchid'));
    expect(storage.setItem).toHaveBeenCalledWith('k-mode', 'dark');
    expect(storage.setItem).toHaveBeenCalledWith('k-theme', 'orchid');
    expect(document.documentElement.dataset['theme']).toBe('orchid');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('resets an unknown persisted theme to the default and warns', async () => {
    const storage = createStorage({ 'ui-theme-palette': 'retired-theme' });
    const { result } = renderHook(() => useTheme(), { wrapper: wrapperFor(storage) });
    await waitFor(() => expect(result.current.theme).toBe('brainstrike'));
    expect(mockWarn).toHaveBeenCalledWith(
      'Ignoring unknown persisted theme',
      expect.objectContaining({ key: 'ui-theme-palette', value: 'retired-theme' })
    );
  });

  it('resets an unknown persisted mode to the default and warns', async () => {
    const storage = createStorage({ 'ui-theme': 'sepia' });
    const { result } = renderHook(() => useTheme(), {
      wrapper: wrapperFor(storage, { defaultMode: 'light' }),
    });
    await waitFor(() => expect(result.current.mode).toBe('light'));
    expect(mockWarn).toHaveBeenCalledWith(
      'Ignoring unknown persisted theme mode',
      expect.objectContaining({ key: 'ui-theme', value: 'sepia' })
    );
  });

  it('honours defaultMode and defaultTheme when nothing is persisted', async () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: wrapperFor(createStorage(), { defaultMode: 'light', defaultTheme: 'ember' }),
    });
    await waitFor(() => expect(result.current.theme).toBe('ember'));
    expect(result.current.mode).toBe('light');
  });

  it('throws when useTheme is used outside the provider', () => {
    expect(() => renderHook(() => useTheme())).toThrow(
      'useTheme must be used within a ThemeProvider'
    );
  });
});
