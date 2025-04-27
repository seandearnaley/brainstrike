import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INCLUDE_FILTERS, useFileExplorerSettings } from '../use-file-explorer-settings';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value.toString();
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

describe('useFileExplorerSettings', () => {
  const STORAGE_KEY = 'fileExplorerSettings';

  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should load default settings when no stored settings exist', () => {
    const { result } = renderHook(() => useFileExplorerSettings());

    expect(localStorageMock.getItem).toHaveBeenCalledWith(STORAGE_KEY);
    expect(result.current.settings).toEqual({
      maxSelectionCount: 10,
      includeFilters: DEFAULT_INCLUDE_FILTERS,
      excludeFilters: ['node_modules', 'test-results', 'playwright-report'],
      useRegex: false,
      includeProjectTree: true,
      folderSummaryThreshold: 100,
    });
  });

  it('should load stored settings from localStorage', () => {
    const storedSettings = {
      maxSelectionCount: 20,
      includeFilters: ['*.txt'],
      excludeFilters: ['*.log'],
      useRegex: true,
      includeProjectTree: false,
      folderSummaryThreshold: 50,
    };
    localStorageMock.getItem.mockReturnValueOnce(JSON.stringify(storedSettings));

    const { result } = renderHook(() => useFileExplorerSettings());

    expect(localStorageMock.getItem).toHaveBeenCalledWith(STORAGE_KEY);
    expect(result.current.settings).toEqual(storedSettings);
  });

  it('should handle errors when loading settings', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorageMock.getItem.mockReturnValueOnce('invalid-json');

    const { result } = renderHook(() => useFileExplorerSettings());

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(result.current.settings).toEqual({
      maxSelectionCount: 10,
      includeFilters: DEFAULT_INCLUDE_FILTERS,
      excludeFilters: ['node_modules', 'test-results', 'playwright-report'],
      useRegex: false,
      includeProjectTree: true,
      folderSummaryThreshold: 100,
    });
    consoleErrorSpy.mockRestore();
  });

  it('should update settings and save to localStorage', () => {
    const { result } = renderHook(() => useFileExplorerSettings());
    act(() => {
      result.current.updateSettings({ maxSelectionCount: 15, useRegex: true });
    });

    expect(localStorageMock.setItem).toHaveBeenCalledWith(STORAGE_KEY, expect.any(String));
    const savedValue = JSON.parse(localStorageMock.setItem.mock.calls[0][1]);
    expect(savedValue).toEqual({
      ...result.current.settings,
      maxSelectionCount: 15,
      useRegex: true,
    });
    expect(result.current.settings.maxSelectionCount).toBe(15);
    expect(result.current.settings.useRegex).toBe(true);
  });

  it('should handle errors when saving settings', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorageMock.setItem.mockImplementationOnce(() => {
      throw new Error('Storage error');
    });

    const { result } = renderHook(() => useFileExplorerSettings());
    act(() => {
      result.current.updateSettings({ maxSelectionCount: 15 });
    });
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
