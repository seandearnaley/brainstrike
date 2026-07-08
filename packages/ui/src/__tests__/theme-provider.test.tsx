/**
 * @vitest-environment happy-dom
 */
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, type ThemeStorageAdapter, useTheme } from '../theme-provider';

// Mock storage adapter
let mockStorageAdapter: ThemeStorageAdapter;

// Mock classList
const mockClassList = {
  add: vi.fn(),
  contains: vi.fn(),
  entries: vi.fn(),
  forEach: vi.fn(),
  item: vi.fn(),
  keys: vi.fn(),
  length: 0,
  remove: vi.fn(),
  replace: vi.fn(),
  toggle: vi.fn(),
  toString: vi.fn(),
  value: '',
  values: vi.fn(),
  [Symbol.iterator]: vi.fn(),
} as unknown as DOMTokenList;

describe('ThemeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Create fresh mock storage adapter
    mockStorageAdapter = {
      clear: vi.fn().mockResolvedValue(undefined),
      getAllKeys: vi.fn().mockResolvedValue([]),
      getItem: vi.fn().mockResolvedValue(null),
      removeItem: vi.fn().mockResolvedValue(undefined),
      setItem: vi.fn().mockResolvedValue(undefined),
    } as ThemeStorageAdapter;

    // Set the classList on the document element
    Object.defineProperty(document.documentElement, 'classList', {
      value: mockClassList,
      writable: true,
    });

    // Mock window.matchMedia
    global.matchMedia = vi.fn().mockImplementation((query) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  // Default wrapper without explicit defaultTheme
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ThemeProvider storageAdapter={mockStorageAdapter}>{children}</ThemeProvider>
  );

  it('provides default theme state', async () => {
    (mockStorageAdapter.getItem as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { result } = renderHook(() => useTheme(), { wrapper });

    // Wait for mounted state
    await act(async () => {
      vi.runAllTimers();
      await vi.runAllTicks();
    });

    expect(result.current.theme).toBe('system');
  });

  it('loads theme from storage if available', async () => {
    (mockStorageAdapter.getItem as ReturnType<typeof vi.fn>).mockResolvedValue('dark');
    const { result } = renderHook(() => useTheme(), { wrapper });

    await act(async () => {
      vi.runAllTimers();
      await vi.runAllTicks();
    });

    expect(result.current.theme).toBe('dark');
  });

  it('updates theme when setTheme is called', async () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    await act(async () => {
      vi.runAllTimers();
      await vi.runAllTicks();
    });

    act(() => {
      result.current.setTheme('dark');
    });

    expect(result.current.theme).toBe('dark');
    expect(mockStorageAdapter.setItem).toHaveBeenCalledWith('ui-theme', 'dark');
  });

  it('applies system theme when theme is set to system', async () => {
    // Mock system theme as dark
    global.matchMedia = vi.fn().mockImplementation((query) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    }));

    const { result } = renderHook(() => useTheme(), { wrapper });

    await act(async () => {
      vi.runAllTimers();
      await vi.runAllTicks();
    });

    act(() => {
      result.current.setTheme('system');
    });

    await act(async () => {
      vi.runAllTimers();
      await vi.runAllTicks();
    });

    expect(mockClassList.remove).toHaveBeenCalledWith('light', 'dark');
    expect(mockClassList.add).toHaveBeenCalledWith('dark');
  });

  it('throws error when useTheme is used outside provider', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      renderHook(() => useTheme());
    }).toThrow('useTheme must be used within a ThemeProvider');

    consoleSpy.mockRestore();
  });

  it('handles custom defaultTheme prop', async () => {
    const customWrapper = ({ children }: { children: ReactNode }) => (
      <ThemeProvider defaultTheme="dark" storageAdapter={mockStorageAdapter}>
        {children}
      </ThemeProvider>
    );

    (mockStorageAdapter.getItem as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { result } = renderHook(() => useTheme(), { wrapper: customWrapper });

    await act(async () => {
      vi.runAllTimers();
      await vi.runAllTicks();
    });

    expect(result.current.theme).toBe('dark');
  });

  it('handles custom storageKey prop', async () => {
    const customWrapper = ({ children }: { children: ReactNode }) => (
      <ThemeProvider storageAdapter={mockStorageAdapter} storageKey="custom-theme-key">
        {children}
      </ThemeProvider>
    );

    const { result } = renderHook(() => useTheme(), { wrapper: customWrapper });

    await act(async () => {
      vi.runAllTimers();
      await vi.runAllTicks();
    });

    act(() => {
      result.current.setTheme('light');
    });

    expect(mockStorageAdapter.setItem).toHaveBeenCalledWith('custom-theme-key', 'light');
  });
});
