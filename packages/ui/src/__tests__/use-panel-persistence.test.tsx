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
});

describe('usePanelPersistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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
      vi.advanceTimersByTime(100);
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
      vi.advanceTimersByTime(100);
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
