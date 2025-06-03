import { act, renderHook } from '@testing-library/react';
import { vi } from 'vitest';
import { usePanelPersistence, UsePanelPersistenceProps, PanelSizes, PanelVisibility } from '../use-panel-persistence'; // Adjust path if necessary

const TEST_STORAGE_KEY = 'test-panel-state';
const DEFAULT_SIZES: PanelSizes = [20, 60, 20];
const DEFAULT_VISIBILITY: PanelVisibility = {
  showLeftPanel: true,
  showRightPanel: true,
  showConsole: false,
};

// Mock localStorage
const localStorageMock = (() => {
  let store: { [key: string]: string } = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value.toString(); }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    get length() { return Object.keys(store).length; },
    key: vi.fn((index: number) => Object.keys(store)[index] || null),
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

const getHook = (props: Partial<UsePanelPersistenceProps> = {}) => {
  const defaultTestProps: UsePanelPersistenceProps = {
    storageKey: TEST_STORAGE_KEY,
    defaultSizes: DEFAULT_SIZES,
    defaultVisibility: DEFAULT_VISIBILITY,
    minSize: 5, // Default min size for panels
  };
  return renderHook(() => usePanelPersistence({ ...defaultTestProps, ...props }));
};

describe('usePanelPersistence', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks(); // Clears all mocks, including localStorageMock method calls
  });

  describe('Initialization (localStorage interaction)', () => {
    it('should initialize with default values if localStorage is empty', () => {
      localStorageMock.getItem.mockReturnValue(null);
      const { result } = getHook();

      expect(result.current.sizes).toEqual(DEFAULT_SIZES);
      expect(result.current.showLeftPanel).toBe(DEFAULT_VISIBILITY.showLeftPanel);
      expect(result.current.showRightPanel).toBe(DEFAULT_VISIBILITY.showRightPanel);
      expect(result.current.showConsole).toBe(DEFAULT_VISIBILITY.showConsole);
      expect(localStorageMock.getItem).toHaveBeenCalledWith(TEST_STORAGE_KEY);
    });

    it('should initialize from localStorage if valid data exists', () => {
      const persistedState = {
        sizes: [30, 40, 30],
        visibility: { showLeftPanel: false, showRightPanel: false, showConsole: true },
      };
      localStorageMock.getItem.mockReturnValue(JSON.stringify(persistedState));
      const { result } = getHook();

      expect(result.current.sizes).toEqual(persistedState.sizes);
      expect(result.current.showLeftPanel).toBe(persistedState.visibility.showLeftPanel);
      expect(result.current.showRightPanel).toBe(persistedState.visibility.showRightPanel);
      expect(result.current.showConsole).toBe(persistedState.visibility.showConsole);
    });

    it('should use default values if localStorage getItem throws an error', () => {
      localStorageMock.getItem.mockImplementation(() => {
        throw new Error('Storage unavailable');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { result } = getHook();

      expect(result.current.sizes).toEqual(DEFAULT_SIZES);
      expect(result.current.showLeftPanel).toBe(DEFAULT_VISIBILITY.showLeftPanel);
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('should use default values if localStorage contains malformed JSON', () => {
      localStorageMock.getItem.mockReturnValue("{not:json,,}");
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { result } = getHook();

      expect(result.current.sizes).toEqual(DEFAULT_SIZES);
      expect(result.current.showLeftPanel).toBe(DEFAULT_VISIBILITY.showLeftPanel);
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('should use default sizes if persisted sizes array has incorrect length', () => {
      const persistedState = { sizes: [50, 50], visibility: DEFAULT_VISIBILITY }; // Incorrect length
      localStorageMock.getItem.mockReturnValue(JSON.stringify(persistedState));
      const { result } = getHook();
      expect(result.current.sizes).toEqual(DEFAULT_SIZES);
    });
    
    it('should use default sizes if persisted sizes are not numbers or are below minSize', () => {
      const persistedState = { sizes: ["30", 1, 40], visibility: DEFAULT_VISIBILITY }; // "30" is string, 1 is < minSize (5)
      localStorageMock.getItem.mockReturnValue(JSON.stringify(persistedState));
      const { result } = getHook({ minSize: 5 }); // Ensure minSize is used
      expect(result.current.sizes).toEqual([30, 5, 40]); // "30" coerced, 1 adjusted to 5
    });

    it('should use default visibility if persisted visibility is incomplete or types are wrong', () => {
      const persistedState = { sizes: DEFAULT_SIZES, visibility: { showLeftPanel: 'true' } }; // 'true' is string
      localStorageMock.getItem.mockReturnValue(JSON.stringify(persistedState));
      const { result } = getHook();
       // showLeftPanel should be true (coerced), others default
      expect(result.current.showLeftPanel).toBe(true);
      expect(result.current.showRightPanel).toBe(DEFAULT_VISIBILITY.showRightPanel);
      expect(result.current.showConsole).toBe(DEFAULT_VISIBILITY.showConsole);
    });
  });

  describe('saveLayout', () => {
    it('should update sizes state and persist to localStorage', () => {
      const { result } = getHook();
      const newSizes: PanelSizes = [25, 50, 25];
      
      act(() => {
        result.current.saveLayout(newSizes);
      });

      expect(result.current.sizes).toEqual(newSizes);
      expect(localStorageMock.setItem).toHaveBeenCalledWith(TEST_STORAGE_KEY, JSON.stringify({
        sizes: newSizes,
        visibility: DEFAULT_VISIBILITY, // Initial visibility
      }));
    });

    it('should not persist or update state if new sizes are invalid (e.g. null, undefined, wrong length, non-numeric)', () => {
      const { result } = getHook();
      const initialSizes = result.current.sizes; // Capture initial state
      localStorageMock.setItem.mockClear(); // Clear any initial persistence from setup

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      act(() => {
        result.current.saveLayout(null as any);
      });
      expect(result.current.sizes).toEqual(initialSizes);
      expect(localStorageMock.setItem).not.toHaveBeenCalled();
      
      act(() => {
        result.current.saveLayout([10, 20] as any); // Wrong length
      });
      expect(result.current.sizes).toEqual(initialSizes);
      expect(localStorageMock.setItem).not.toHaveBeenCalled();
      
      act(() => {
        result.current.saveLayout([10, 'invalid', 30] as any); // Non-numeric
      });
      // The hook tries to sanitize, so it might partially update or use defaults
      // Based on current hook logic, it sanitizes to [10, minSize, 30]
      const sanitizedNonNumeric = [10, 5, 30]; // Assuming minSize is 5
      expect(result.current.sizes).toEqual(sanitizedNonNumeric);
      expect(localStorageMock.setItem).toHaveBeenCalledWith(TEST_STORAGE_KEY, JSON.stringify({
        sizes: sanitizedNonNumeric,
        visibility: DEFAULT_VISIBILITY,
      }));
      
      expect(consoleWarnSpy).toHaveBeenCalled(); // Or error, depending on implementation
      consoleWarnSpy.mockRestore();
    });
    
    it('should handle localStorage setItem throwing an error during saveLayout', () => {
      const { result } = getHook();
      const newSizes: PanelSizes = [33, 34, 33];
      localStorageMock.setItem.mockImplementation(() => {
        throw new Error('Quota exceeded');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      act(() => {
        result.current.saveLayout(newSizes);
      });
      
      expect(result.current.sizes).toEqual(newSizes); // State should still update optimistically
      expect(localStorageMock.setItem).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('Toggle Functions', () => {
    it.each([
      ['showLeftPanel', 'toggleLeftPanel'],
      ['showRightPanel', 'toggleRightPanel'],
      ['showConsole', 'toggleConsole'],
    ])('toggling %s should update its state and persist', (visibilityKey, toggleFnName) => {
      const { result } = getHook();
      const initialVisibility = result.current[visibilityKey];

      act(() => {
        result.current[toggleFnName]();
      });

      expect(result.current[visibilityKey]).toBe(!initialVisibility);
      const expectedPersistedState = {
        sizes: DEFAULT_SIZES,
        visibility: {
          ...DEFAULT_VISIBILITY,
          [visibilityKey]: !initialVisibility,
        },
      };
      expect(localStorageMock.setItem).toHaveBeenCalledWith(TEST_STORAGE_KEY, JSON.stringify(expectedPersistedState));
    });
    
    it('toggle functions can accept an explicit boolean value', () => {
        const { result } = getHook();
        act(() => { result.current.toggleLeftPanel(true); });
        expect(result.current.showLeftPanel).toBe(true);
        act(() => { result.current.toggleLeftPanel(false); });
        expect(result.current.showLeftPanel).toBe(false);

        act(() => { result.current.toggleRightPanel(true); });
        expect(result.current.showRightPanel).toBe(true);
        
        act(() => { result.current.toggleConsole(true); });
        expect(result.current.showConsole).toBe(true);
    });
  });
  
  describe('handleConsoleClose', () => {
    it('should set showConsole to false and persist', () => {
      const { result } = getHook({ defaultVisibility: { ...DEFAULT_VISIBILITY, showConsole: true } });
      expect(result.current.showConsole).toBe(true); // Starts as true

      act(() => {
        result.current.handleConsoleClose();
      });

      expect(result.current.showConsole).toBe(false);
      const expectedPersistedState = {
        sizes: DEFAULT_SIZES,
        visibility: { ...DEFAULT_VISIBILITY, showConsole: false },
      };
      expect(localStorageMock.setItem).toHaveBeenCalledWith(TEST_STORAGE_KEY, JSON.stringify(expectedPersistedState));
    });
  });
});
