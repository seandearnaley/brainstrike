import { act, renderHook } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
});

import { useTabManager } from '../../hooks/use-tab-manager';
import { __resetTabManagerStoreForTests } from '../../stores/tab-manager-store';

describe('useTabManager', () => {
  // Mock localStorage
  const localStorageMock = {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  };

  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
    __resetTabManagerStoreForTests();
    Object.defineProperty(window, 'localStorage', {
      value: localStorageMock,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with empty state when no localStorage data exists', () => {
      localStorageMock.getItem.mockReturnValue(null);

      const { result } = renderHook(() => useTabManager());

      expect(result.current.tabs).toEqual([]);
      expect(result.current.activeTabId).toBeNull();
    });

    it('should initialize from localStorage when data exists', async () => {
      const persisted = {
        state: {
          tabs: [
            { id: 'file1', path: '/src/index.ts', compositeKey: 'file1' },
            { id: 'file2', path: '/src/app.ts', compositeKey: 'file2' },
          ],
          activeTabId: 'file1',
        },
        version: 1,
      };
      localStorageMock.getItem.mockReturnValue(JSON.stringify(persisted));
      // Rehydrate store explicitly before rendering hook
      await act(async () => {
        const mod = await import('../../stores/tab-manager-store');
        const persistApi = (
          mod.useTabManagerStore as unknown as {
            persist?: { rehydrate?: () => Promise<void> };
          }
        ).persist;
        await persistApi?.rehydrate?.();
      });

      const { result } = renderHook(() => useTabManager());

      // Content and loading states should be initialized to defaults
      expect(result.current.tabs).toEqual([
        {
          id: 'file1',
          path: '/src/index.ts',
          compositeKey: 'file1',
          content: null,
          isLoading: false,
          error: undefined,
        },
        {
          id: 'file2',
          path: '/src/app.ts',
          compositeKey: 'file2',
          content: null,
          isLoading: false,
          error: undefined,
        },
      ]);
      expect(result.current.activeTabId).toBe('file1');
    });

    it('should handle corrupted localStorage data gracefully', () => {
      localStorageMock.getItem.mockReturnValue('invalid json');

      const { result } = renderHook(() => useTabManager());

      expect(result.current.tabs).toEqual([]);
      expect(result.current.activeTabId).toBeNull();
    });
  });

  describe('openTab', () => {
    it('should create a new tab when opening a file', () => {
      localStorageMock.getItem.mockReturnValue(null);
      const { result } = renderHook(() => useTabManager());

      act(() => {
        result.current.openTab('/src/index.ts', 'folder1:/src/index.ts', 'folder1:/src/index.ts');
      });

      expect(result.current.tabs).toHaveLength(1);
      expect(result.current.tabs[0]).toEqual({
        id: 'folder1:/src/index.ts',
        path: '/src/index.ts',
        compositeKey: 'folder1:/src/index.ts',
        content: null,
        isLoading: true,
      });
      expect(result.current.activeTabId).toBe('folder1:/src/index.ts');
    });

    it('should activate existing tab if already open', () => {
      localStorageMock.getItem.mockReturnValue(null);
      const { result } = renderHook(() => useTabManager());

      // Open first tab
      act(() => {
        result.current.openTab('/src/index.ts', 'folder1:/src/index.ts', 'folder1:/src/index.ts');
      });

      // Open second tab
      act(() => {
        result.current.openTab('/src/app.ts', 'folder1:/src/app.ts', 'folder1:/src/app.ts');
      });

      expect(result.current.tabs).toHaveLength(2);
      expect(result.current.activeTabId).toBe('folder1:/src/app.ts');

      // Try to open first tab again
      act(() => {
        result.current.openTab('/src/index.ts', 'folder1:/src/index.ts', 'folder1:/src/index.ts');
      });

      // Should not create a new tab, just activate the existing one
      expect(result.current.tabs).toHaveLength(2);
      expect(result.current.activeTabId).toBe('folder1:/src/index.ts');
    });
  });

  describe('closeTab', () => {
    it('should remove tab and activate next tab', () => {
      localStorageMock.getItem.mockReturnValue(null);
      const { result } = renderHook(() => useTabManager());

      // Open three tabs
      act(() => {
        result.current.openTab('/src/index.ts', 'file1', 'file1');
        result.current.openTab('/src/app.ts', 'file2', 'file2');
        result.current.openTab('/src/utils.ts', 'file3', 'file3');
      });

      expect(result.current.tabs).toHaveLength(3);
      expect(result.current.activeTabId).toBe('file3');

      // Close the middle tab
      act(() => {
        result.current.closeTab('file2');
      });

      expect(result.current.tabs).toHaveLength(2);
      expect(result.current.tabs.find((t) => t.id === 'file2')).toBeUndefined();
      expect(result.current.activeTabId).toBe('file3'); // Active tab should not change
    });

    it('should activate previous tab when closing active tab', () => {
      localStorageMock.getItem.mockReturnValue(null);
      const { result } = renderHook(() => useTabManager());

      // Open three tabs
      act(() => {
        result.current.openTab('/src/index.ts', 'file1', 'file1');
        result.current.openTab('/src/app.ts', 'file2', 'file2');
        result.current.openTab('/src/utils.ts', 'file3', 'file3');
      });

      // Close the active tab (file3)
      act(() => {
        result.current.closeTab('file3');
      });

      expect(result.current.tabs).toHaveLength(2);
      expect(result.current.activeTabId).toBe('file2'); // Should activate the previous tab
    });

    it('should clear active tab when closing last tab', () => {
      localStorageMock.getItem.mockReturnValue(null);
      const { result } = renderHook(() => useTabManager());

      act(() => {
        result.current.openTab('/src/index.ts', 'file1', 'file1');
      });

      act(() => {
        result.current.closeTab('file1');
      });

      expect(result.current.tabs).toHaveLength(0);
      expect(result.current.activeTabId).toBeNull();
    });

    it('should activate first tab when closing active tab at position 0', () => {
      localStorageMock.getItem.mockReturnValue(null);
      const { result } = renderHook(() => useTabManager());

      // Open three tabs
      act(() => {
        result.current.openTab('/src/index.ts', 'file1', 'file1');
      });

      act(() => {
        result.current.openTab('/src/app.ts', 'file2', 'file2');
      });

      act(() => {
        result.current.openTab('/src/utils.ts', 'file3', 'file3');
      });

      // Make the first one active
      act(() => {
        result.current.setActiveTab('file1');
      });

      // Verify the order before closing
      expect(result.current.tabs.map((t) => t.id)).toEqual(['file1', 'file2', 'file3']);
      expect(result.current.activeTabId).toBe('file1');

      // Close the first tab (active)
      act(() => {
        result.current.closeTab('file1');
      });

      expect(result.current.tabs).toHaveLength(2);
      expect(result.current.tabs.map((t) => t.id)).toEqual(['file2', 'file3']);
      expect(result.current.activeTabId).toBe('file2'); // Should activate the next tab
    });
  });

  describe('setActiveTab', () => {
    it('should update active tab', () => {
      localStorageMock.getItem.mockReturnValue(null);
      const { result } = renderHook(() => useTabManager());

      act(() => {
        result.current.openTab('/src/index.ts', 'file1', 'file1');
        result.current.openTab('/src/app.ts', 'file2', 'file2');
      });

      expect(result.current.activeTabId).toBe('file2');

      act(() => {
        result.current.setActiveTab('file1');
      });

      expect(result.current.activeTabId).toBe('file1');
    });
  });

  describe('updateTabContent', () => {
    it('should update tab content and clear loading state', () => {
      localStorageMock.getItem.mockReturnValue(null);
      const { result } = renderHook(() => useTabManager());

      act(() => {
        result.current.openTab('/src/index.ts', 'file1', 'file1');
      });

      expect(result.current.tabs[0]?.content).toBeNull();
      expect(result.current.tabs[0]?.isLoading).toBe(true);

      act(() => {
        result.current.updateTabContent('file1', 'const x = 42;');
      });

      expect(result.current.tabs[0]?.content).toBe('const x = 42;');
      expect(result.current.tabs[0]?.isLoading).toBe(false);
      expect(result.current.tabs[0]?.error).toBeUndefined();
    });
  });

  describe('setTabLoading', () => {
    it('should update loading state', () => {
      localStorageMock.getItem.mockReturnValue(null);
      const { result } = renderHook(() => useTabManager());

      act(() => {
        result.current.openTab('/src/index.ts', 'file1', 'file1');
        result.current.updateTabContent('file1', 'content');
      });

      expect(result.current.tabs[0]?.isLoading).toBe(false);

      act(() => {
        result.current.setTabLoading('file1', true);
      });

      expect(result.current.tabs[0]?.isLoading).toBe(true);
    });

    it('should clear error when setting loading to true', () => {
      localStorageMock.getItem.mockReturnValue(null);
      const { result } = renderHook(() => useTabManager());

      act(() => {
        result.current.openTab('/src/index.ts', 'file1', 'file1');
        result.current.setTabError('file1', 'File not found');
      });

      expect(result.current.tabs[0]?.error).toBe('File not found');

      act(() => {
        result.current.setTabLoading('file1', true);
      });

      expect(result.current.tabs[0]?.error).toBeUndefined();
    });
  });

  describe('setTabError', () => {
    it('should set error and clear loading state', () => {
      localStorageMock.getItem.mockReturnValue(null);
      const { result } = renderHook(() => useTabManager());

      act(() => {
        result.current.openTab('/src/index.ts', 'file1', 'file1');
      });

      expect(result.current.tabs[0]?.isLoading).toBe(true);
      expect(result.current.tabs[0]?.error).toBeUndefined();

      act(() => {
        result.current.setTabError('file1', 'Failed to load file');
      });

      expect(result.current.tabs[0]?.error).toBe('Failed to load file');
      expect(result.current.tabs[0]?.isLoading).toBe(false);
    });
  });

  describe('clearTabs', () => {
    it('should remove all tabs and clear active tab', () => {
      localStorageMock.getItem.mockReturnValue(null);
      const { result } = renderHook(() => useTabManager());

      act(() => {
        result.current.openTab('/src/index.ts', 'file1', 'file1');
        result.current.openTab('/src/app.ts', 'file2', 'file2');
        result.current.openTab('/src/utils.ts', 'file3', 'file3');
      });

      expect(result.current.tabs).toHaveLength(3);
      expect(result.current.activeTabId).toBe('file3');

      act(() => {
        result.current.clearTabs();
      });

      expect(result.current.tabs).toHaveLength(0);
      expect(result.current.activeTabId).toBeNull();
    });
  });

  describe('localStorage persistence', () => {
    it('should save state to localStorage on changes', async () => {
      localStorageMock.getItem.mockReturnValue(null);
      const { result } = renderHook(() => useTabManager());

      act(() => {
        result.current.openTab('/src/index.ts', 'file1', 'file1');
      });

      // Expect a call to the new persist key with JSON payload containing state/version
      expect(localStorageMock.setItem).toHaveBeenCalled();
      const [key, val] = localStorageMock.setItem.mock.calls.pop() as [string, string];
      expect(key).toBe('tab-manager.v1');
      const parsed = JSON.parse(val) as { state: unknown; version: number };
      expect(parsed.version).toBe(2);
      const state = parsed.state as {
        tabs: Array<{ id: string; path: string; compositeKey: string }>;
        activeTabId: string;
      };
      expect(state.activeTabId).toBe('file1');
      expect(state.tabs).toEqual([{ id: 'file1', path: '/src/index.ts', compositeKey: 'file1' }]);
    });

    it('should handle localStorage errors gracefully', async () => {
      localStorageMock.getItem.mockReturnValue(null);
      localStorageMock.setItem.mockImplementation(() => {
        throw new Error('Storage quota exceeded');
      });

      const { result } = renderHook(() => useTabManager());

      act(() => {
        result.current.openTab('/src/index.ts', 'file1', 'file1');
      });

      // The tab should still be opened despite the storage error
      expect(result.current.tabs).toHaveLength(1);
      expect(result.current.tabs[0]).toEqual({
        id: 'file1',
        path: '/src/index.ts',
        compositeKey: 'file1',
        content: null,
        isLoading: true,
      });
    });
  });
});
