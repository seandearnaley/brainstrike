import { act, renderHook } from '@testing-library/react';
import {
  getElectronAPI,
  hasElectronAPI,
  usePanelPersistence,
} from '../hooks/use-panel-persistence';

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
  configurable: true,
});

const electronAPIMock = {
  saveLayout: vi.fn().mockResolvedValue(undefined),
  loadLayout: vi.fn().mockResolvedValue(undefined),
};

// Mock window.addEventListener and removeEventListener
const mockAddEventListener = vi.fn();
const mockRemoveEventListener = vi.fn();

Object.defineProperty(window, 'addEventListener', {
  value: mockAddEventListener,
  configurable: true,
});
Object.defineProperty(window, 'removeEventListener', {
  value: mockRemoveEventListener,
  configurable: true,
});

describe('usePanelPersistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Remove electronAPI by default
    // Each test can set it as needed
    (window as { electronAPI?: unknown }).electronAPI = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    (window as { electronAPI?: unknown }).electronAPI = undefined;
  });

  describe('Electron API helpers', () => {
    it('returns undefined and false when electronAPI is absent', () => {
      (window as { electronAPI?: unknown }).electronAPI = undefined;
      expect(getElectronAPI()).toBeUndefined();
      expect(hasElectronAPI()).toBe(false);
    });

    it('returns the object and true when electronAPI is defined', () => {
      const api = {} as unknown as typeof electronAPIMock;
      (window as { electronAPI?: unknown }).electronAPI = api;
      expect(getElectronAPI()).toBe(api);
      expect(hasElectronAPI()).toBe(true);
    });
  });

  it('should initialize with default values when no stored data', () => {
    localStorageMock.getItem.mockReturnValue(null);

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    expect(result.current.sizes).toEqual([20, 30]);
    expect(result.current.showConsole).toBe(true);
  });

  it('should initialize with stored values when available', () => {
    const storedData = {
      sizes: [25, 35],
      showConsole: false,
      showLeftPanel: true,
      showRightPanel: false,
    };
    localStorageMock.getItem.mockReturnValue(JSON.stringify(storedData));

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    expect(result.current.sizes).toEqual([25, 35]);
    expect(result.current.showConsole).toBe(false);
  });

  it('should normalize invalid sizes', () => {
    const storedData = {
      sizes: [60, 60], // Total 120%, should be normalized to 100%
      showConsole: false,
      showLeftPanel: true,
      showRightPanel: false,
    };
    localStorageMock.getItem.mockReturnValue(JSON.stringify(storedData));

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    // Should be normalized to [50, 50] (proportional to 100%)
    expect(result.current.sizes).toEqual([50, 50]);
  });

  it('should not normalize sizes when total is less than 100%', () => {
    const storedData = {
      sizes: [25, 35], // Total 60%, should not normalize
      showConsole: false,
      showLeftPanel: true,
      showRightPanel: false,
    };
    localStorageMock.getItem.mockReturnValue(JSON.stringify(storedData));

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    // Should keep original values since they're valid
    expect(result.current.sizes).toEqual([25, 35]);
  });

  it('should handle zero total sizes', () => {
    const storedData = {
      sizes: [0, 0], // Total 0%, should default to equal distribution
      showConsole: false,
      showLeftPanel: true,
      showRightPanel: false,
    };
    localStorageMock.getItem.mockReturnValue(JSON.stringify(storedData));

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    // Should default to equal distribution [50, 50]
    expect(result.current.sizes).toEqual([50, 50]);
  });

  it('should save layout to localStorage', async () => {
    localStorageMock.getItem.mockReturnValue(null);

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    act(() => {
      result.current.saveLayout([25, 35], false);
    });

    // State should update immediately
    expect(result.current.sizes).toEqual([25, 35]);
    expect(result.current.showConsole).toBe(false);

    // Advance timers to trigger the debounced save
    act(() => {
      vi.advanceTimersByTime(250);
    });

    // Now localStorage should have been called
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'panelLayout.v1',
      JSON.stringify({
        sizes: [25, 35],
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: false,
      })
    );
  });

  it('should normalize sizes when saving layout if needed', async () => {
    localStorageMock.getItem.mockReturnValue(null);

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    act(() => {
      result.current.saveLayout([60, 60], false); // Total 120%, should be normalized
    });

    // State should be normalized immediately
    expect(result.current.sizes).toEqual([50, 50]); // Normalized to 100%

    // Advance timers to trigger the debounced save
    act(() => {
      vi.advanceTimersByTime(250);
    });

    // localStorage should receive normalized values
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'panelLayout.v1',
      JSON.stringify({
        sizes: [50, 50],
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: false,
      })
    );
  });

  it('should toggle console visibility', async () => {
    localStorageMock.getItem.mockReturnValue(null);

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    act(() => {
      result.current.toggleConsole();
    });

    expect(result.current.showConsole).toBe(false);

    // Advance timers to trigger the debounced save
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'panelLayout.v1',
      JSON.stringify({
        sizes: [20, 30],
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: false,
      })
    );
  });

  it('should not persist when layout is unchanged', async () => {
    localStorageMock.getItem.mockReturnValue(null);

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    act(() => {
      result.current.saveLayout([20, 30], true, true, false);
    });

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(localStorageMock.setItem).not.toHaveBeenCalled();
  });

  it('should save to Electron API when available', async () => {
    (window as { electronAPI?: unknown }).electronAPI = electronAPIMock;
    localStorageMock.getItem.mockReturnValue(null);

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    act(() => {
      result.current.saveLayout([25, 35], false);
    });

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(electronAPIMock.saveLayout).toHaveBeenCalledWith({
      sizes: [25, 35],
      showConsole: false,
      showLeftPanel: true,
      showRightPanel: false,
    });
    expect(localStorageMock.setItem).not.toHaveBeenCalled();
  });

  it('should load from Electron API on mount', async () => {
    const electronData = {
      sizes: [30, 40],
      showConsole: true,
      showLeftPanel: false,
      showRightPanel: true,
    };
    electronAPIMock.loadLayout.mockResolvedValue(electronData);
    (window as { electronAPI?: unknown }).electronAPI = electronAPIMock;

    const { result } = renderHook(() => usePanelPersistence([20, 30], false));

    // Wait for the effect to run
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.sizes).toEqual([30, 40]);
    expect(result.current.showConsole).toBe(true);
    expect(result.current.showLeftPanel).toBe(false);
    expect(result.current.showRightPanel).toBe(true);
  });

  it('should not load from Electron API when unavailable', async () => {
    localStorageMock.getItem.mockReturnValue(null);
    (window as { electronAPI?: unknown }).electronAPI = undefined;

    const { result } = renderHook(() => usePanelPersistence([20, 30], false));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(electronAPIMock.loadLayout).not.toHaveBeenCalled();
    expect(result.current.sizes).toEqual([20, 30]);
  });

  it('should handle localStorage errors gracefully', () => {
    localStorageMock.getItem.mockImplementation(() => {
      throw new Error('localStorage error');
    });

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    expect(result.current.sizes).toEqual([20, 30]);
    expect(result.current.showConsole).toBe(true);
  });

  it('should handle invalid JSON in localStorage gracefully', () => {
    localStorageMock.getItem.mockReturnValue('invalid json');

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    expect(result.current.sizes).toEqual([20, 30]);
    expect(result.current.showConsole).toBe(true);
  });

  it('should save pending changes on beforeunload', () => {
    localStorageMock.getItem.mockReturnValue(null);
    const { result, unmount } = renderHook(() => usePanelPersistence([20, 30], true));

    act(() => {
      result.current.saveLayout([25, 35], false); // This creates a pending save
    });

    // Simulate beforeunload event
    // The event listener should have been added by the hook
    const beforeUnloadCallback = mockAddEventListener.mock.calls.find(
      (call) => call[0] === 'beforeunload'
    )?.[1];

    expect(beforeUnloadCallback).toBeDefined();

    if (beforeUnloadCallback) {
      act(() => {
        beforeUnloadCallback();
      });
    }

    // localStorage.setItem should have been called synchronously
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'panelLayout.v1',
      JSON.stringify({
        sizes: [25, 35],
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: false,
      })
    );

    // Ensure timer is cleared
    expect(vi.getTimerCount()).toBe(0);

    // Test unmount cleanup
    act(() => {
      unmount();
    });
    const removeListenerCall = mockRemoveEventListener.mock.calls.find(
      (call) => call[0] === 'beforeunload'
    );
    expect(removeListenerCall).toBeDefined();
    if (removeListenerCall) {
      expect(removeListenerCall[1]).toBe(beforeUnloadCallback);
    }
  });

  it('warns when Electron save fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Mock isDevEnv to return true for this test
    const utilsModule = await import('@brainstrike/utils');
    const isDevEnvSpy = vi.spyOn(utilsModule, 'isDevEnv').mockReturnValue(true);

    (window as { electronAPI?: unknown }).electronAPI = {
      ...electronAPIMock,
      saveLayout: vi.fn().mockRejectedValue(new Error('fail')),
    };
    localStorageMock.getItem.mockReturnValue(null);

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    act(() => {
      result.current.saveLayout([25, 35], false);
    });

    await act(async () => {
      vi.advanceTimersByTime(250);
      await vi.runAllTicks();
    });

    expect(warnSpy).toHaveBeenCalled();
    expect(localStorageMock.setItem).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    isDevEnvSpy.mockRestore();
  });

  it('cleans up pending save on unmount', () => {
    localStorageMock.getItem.mockReturnValue(null);
    const { result, unmount } = renderHook(() => usePanelPersistence([20, 30], true));

    act(() => {
      result.current.saveLayout([25, 35], false);
    });

    const beforeUnloadCallback = mockAddEventListener.mock.calls.find(
      (call) => call[0] === 'beforeunload'
    )?.[1];

    expect(beforeUnloadCallback).toBeDefined();

    act(() => {
      unmount();
    });

    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'panelLayout.v1',
      JSON.stringify({
        sizes: [25, 35],
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: false,
      })
    );
    expect(vi.getTimerCount()).toBe(0);
    const removeCall = mockRemoveEventListener.mock.calls.find(
      (call) => call[0] === 'beforeunload'
    );
    expect(removeCall?.[1]).toBe(beforeUnloadCallback);
  });

  it('toggleLeftPanel persists updated state', () => {
    localStorageMock.getItem.mockReturnValue(null);

    const { result } = renderHook(() => usePanelPersistence([20, 30], true, true, false));

    act(() => {
      result.current.toggleLeftPanel();
    });

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(result.current.showLeftPanel).toBe(false);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'panelLayout.v1',
      JSON.stringify({
        sizes: [20, 30],
        showConsole: true,
        showLeftPanel: false,
        showRightPanel: false,
      })
    );
  });

  it('toggleRightPanel persists updated state', () => {
    localStorageMock.getItem.mockReturnValue(null);

    const { result } = renderHook(() => usePanelPersistence([20, 30], true, true, false));

    act(() => {
      result.current.toggleRightPanel();
    });

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(result.current.showRightPanel).toBe(true);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'panelLayout.v1',
      JSON.stringify({
        sizes: [20, 30],
        showConsole: true,
        showLeftPanel: true,
        showRightPanel: true,
      })
    );
  });

  it('adds and removes beforeunload listener', () => {
    localStorageMock.getItem.mockReturnValue(null);
    const { unmount } = renderHook(() => usePanelPersistence([20, 30], true));

    const beforeUnloadCallback = mockAddEventListener.mock.calls.find(
      (call) => call[0] === 'beforeunload'
    )?.[1];

    expect(beforeUnloadCallback).toBeDefined();

    act(() => {
      unmount();
    });

    const removeCall = mockRemoveEventListener.mock.calls.find(
      (call) => call[0] === 'beforeunload'
    );
    expect(removeCall?.[1]).toBe(beforeUnloadCallback);
  });
});
