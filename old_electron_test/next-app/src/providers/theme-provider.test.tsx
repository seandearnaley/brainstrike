import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ThemeProvider, useTheme } from './theme-provider';

// Mock localStorage
const mockLocalStorage = {
  getItem: jest.fn(),
  setItem: jest.fn(),
};

// Mock window.matchMedia
const mockMatchMedia = jest.fn().mockImplementation((query) => ({
  matches: query === '(prefers-color-scheme: dark)',
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
}));

// Mock classList
const mockClassList = {
  remove: jest.fn(),
  add: jest.fn(),
};

describe('ThemeProvider', () => {
  beforeAll(() => {
    // Setup localStorage mock
    Object.defineProperty(window, 'localStorage', {
      value: mockLocalStorage,
      writable: true,
    });

    // Setup matchMedia mock
    Object.defineProperty(window, 'matchMedia', {
      value: mockMatchMedia,
      writable: true,
    });

    // Setup document mock
    Object.defineProperty(document, 'documentElement', {
      value: {
        classList: mockClassList,
      },
      writable: true,
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <ThemeProvider>{children}</ThemeProvider>
  );

  it('provides default theme state', () => {
    mockLocalStorage.getItem.mockReturnValue(null);
    const { result } = renderHook(() => useTheme(), { wrapper });

    expect(result.current.theme).toBe('system');
  });

  it('loads theme from localStorage if available', async () => {
    mockLocalStorage.getItem.mockReturnValue('dark');
    const { result } = renderHook(() => useTheme(), { wrapper });

    // Run all pending timers and updates
    await act(async () => {
      jest.runAllTimers();
    });

    expect(result.current.theme).toBe('dark');
  });

  it('updates theme when setTheme is called', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setTheme('dark');
    });

    expect(result.current.theme).toBe('dark');
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith('ui-theme', 'dark');
  });

  it('applies system theme when theme is set to system', async () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setTheme('system');
    });

    // Run all pending timers and updates
    await act(async () => {
      jest.runAllTimers();
    });

    expect(mockClassList.add).toHaveBeenCalledWith('dark');
  });

  it('throws error when useTheme is used outside provider', () => {
    // Suppress console.error for this test
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      renderHook(() => useTheme());
      fail('Expected an error to be thrown');
    } catch (error: unknown) {
      if (error instanceof Error) {
        expect(error.message).toBe('useTheme must be used within a ThemeProvider');
      } else {
        fail('Expected error to be an instance of Error');
      }
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('handles custom defaultTheme prop', () => {
    const customWrapper = ({ children }: { children: ReactNode }) => (
      <ThemeProvider defaultTheme="dark">{children}</ThemeProvider>
    );

    mockLocalStorage.getItem.mockReturnValue(null);
    const { result } = renderHook(() => useTheme(), { wrapper: customWrapper });

    expect(result.current.theme).toBe('dark');
  });

  it('handles custom storageKey prop', () => {
    const customWrapper = ({ children }: { children: ReactNode }) => (
      <ThemeProvider storageKey="custom-theme-key">{children}</ThemeProvider>
    );

    const { result } = renderHook(() => useTheme(), { wrapper: customWrapper });

    act(() => {
      result.current.setTheme('light');
    });

    expect(mockLocalStorage.setItem).toHaveBeenCalledWith('custom-theme-key', 'light');
  });
});
