import { act, renderHook } from '@testing-library/react';
import { usePanelPersistence } from '../hooks/use-panel-persistence';

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
    };
    localStorageMock.getItem.mockReturnValue(JSON.stringify(storedData));

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    expect(result.current.sizes).toEqual([25, 35]);
    expect(result.current.showConsole).toBe(false);
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
      result.current.saveLayout([20, 30], true);
    });

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(localStorageMock.setItem).not.toHaveBeenCalled();
  });

  it('should save layout via Electron API when available', async () => {
    localStorageMock.getItem.mockReturnValue(null);
    (window as { electronAPI?: typeof electronAPIMock }).electronAPI = electronAPIMock;

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    act(() => {
      result.current.saveLayout([25, 35], false);
    });

    await act(async () => {
      vi.advanceTimersByTime(250);
      await vi.runAllTicks();
    });

    expect(electronAPIMock.saveLayout).toHaveBeenCalledWith({
      sizes: [25, 35],
      showConsole: false,
      showLeftPanel: true,
      showRightPanel: false,
    });
    expect(localStorageMock.setItem).not.toHaveBeenCalled();
  });

  it('should load layout from Electron API on mount', async () => {
    localStorageMock.getItem.mockReturnValue(null);
    const stored = {
      sizes: [30, 40],
      showConsole: false,
      showLeftPanel: false,
      showRightPanel: true,
    };
    (window as { electronAPI?: typeof electronAPIMock }).electronAPI = {
      ...electronAPIMock,
      loadLayout: vi.fn().mockResolvedValue(stored),
    };

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    await act(async () => {
      vi.runAllTimers();
      await vi.runAllTicks();
    });

    expect(
      (window as { electronAPI?: typeof electronAPIMock }).electronAPI?.loadLayout
    ).toHaveBeenCalled();
    expect(result.current.sizes).toEqual([30, 40]);
    expect(result.current.showConsole).toBe(false);
    expect(result.current.showLeftPanel).toBe(false);
    expect(result.current.showRightPanel).toBe(true);
  });

  it('should handle invalid JSON in localStorage gracefully', () => {
    localStorageMock.getItem.mockReturnValue('invalid json');

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    expect(result.current.sizes).toEqual([20, 30]);
    expect(result.current.showConsole).toBe(true);
  });

  it('should handle localStorage errors gracefully', () => {
    localStorageMock.getItem.mockImplementation(() => {
      throw new Error('localStorage error');
    });

    const { result } = renderHook(() => usePanelPersistence([20, 30], true));

    expect(result.current.sizes).toEqual([20, 30]);
    expect(result.current.showConsole).toBe(true);
  });
});
