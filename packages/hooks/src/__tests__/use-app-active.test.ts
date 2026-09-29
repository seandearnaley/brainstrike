import type { LogRecord } from '@brainstrike/logging';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

let hasFocus: MockInstance<() => boolean>;

/**
 * Both stubs are undone after every test: `hasFocus` is a spy that
 * `vi.restoreAllMocks()` restores (assigning `document.hasFocus` would leave an
 * own property behind), and the `hidden` own-property override is deleted so the
 * next test sees jsdom's prototype getter again.
 */
function setDocument({ focused, visible }: { focused: boolean; visible: boolean }): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: !visible });
  hasFocus.mockReturnValue(focused);
}

beforeEach(() => {
  hasFocus = vi.spyOn(document, 'hasFocus');
});

afterEach(() => {
  Reflect.deleteProperty(document, 'hidden');
});

describe('useAppActive', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when document is focused and visible', async () => {
    setDocument({ focused: true, visible: true });
    const { isAppActive } = await import('../use-app-active.js');
    expect(isAppActive()).toBe(true);
  });

  it('returns false when document is hidden', async () => {
    setDocument({ focused: false, visible: false });
    const { isAppActive } = await import('../use-app-active.js');
    expect(isAppActive()).toBe(false);
  });

  it('returns false when document is visible but not focused', async () => {
    setDocument({ focused: false, visible: true });
    const { isAppActive } = await import('../use-app-active.js');
    expect(isAppActive()).toBe(false);
  });

  it('updates when visibilitychange fires', async () => {
    setDocument({ focused: true, visible: true });
    const { isAppActive } = await import('../use-app-active.js');
    expect(isAppActive()).toBe(true);

    // Simulate going hidden
    setDocument({ focused: false, visible: false });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(isAppActive()).toBe(false);
  });

  it('updates when window blur/focus fires', async () => {
    setDocument({ focused: true, visible: true });
    const { isAppActive } = await import('../use-app-active.js');
    expect(isAppActive()).toBe(true);

    // Simulate blur
    setDocument({ focused: false, visible: true });
    window.dispatchEvent(new Event('blur'));
    expect(isAppActive()).toBe(false);

    // Simulate focus
    setDocument({ focused: true, visible: true });
    window.dispatchEvent(new Event('focus'));
    expect(isAppActive()).toBe(true);
  });
});

/**
 * BST-1864: on desktop, keyboard focus inside the browser pane's
 * `WebContentsView` (or docked DevTools) makes THIS renderer's
 * `document.hasFocus()` false while the BrowserWindow is still the focused OS
 * window (verified in Electron 44: the host window emits no `blur` and
 * `isFocused()` stays true). With the preload's `windowFocus` capability the
 * native window answers instead. The fake below delivers the runtime shape of
 * that bridge: `isFocused` is a real Promise, `onChange` returns an unsubscribe.
 */
describe('useAppActive with the native window-focus capability', () => {
  interface FakeWindowFocusBridge {
    readonly emit: (focused: boolean) => void;
    readonly isFocused: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
    readonly onChange: ReturnType<typeof vi.fn>;
    readonly unsubscribe: ReturnType<typeof vi.fn>;
  }

  function installBridge(readInitial: () => Promise<boolean>): FakeWindowFocusBridge {
    const listeners = new Set<(focused: boolean) => void>();
    const unsubscribe = vi.fn();
    const isFocused = vi.fn<() => Promise<boolean>>(readInitial);
    const onChange = vi.fn((callback: (focused: boolean) => void) => {
      listeners.add(callback);
      return () => {
        unsubscribe();
        listeners.delete(callback);
      };
    });
    Object.defineProperty(window, 'windowFocus', {
      configurable: true,
      value: { isFocused, onChange },
    });
    return {
      emit: (focused) => {
        for (const listener of listeners) {
          listener(focused);
        }
      },
      isFocused,
      onChange,
      unsubscribe,
    };
  }

  /** Lets the resolved `isFocused()` promise settle inside the module. */
  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'windowFocus');
    vi.restoreAllMocks();
  });

  it('reads active while the native window is focused even though the document is not (focus in the pane)', async () => {
    setDocument({ focused: false, visible: true });
    installBridge(() => Promise.resolve(true));
    const { isAppActive } = await import('../use-app-active.js');
    await settle();
    expect(isAppActive()).toBe(true);
  });

  it('reads inactive when the native window is blurred, whatever the document says', async () => {
    setDocument({ focused: true, visible: true });
    installBridge(() => Promise.resolve(false));
    const { isAppActive } = await import('../use-app-active.js');
    await settle();
    expect(isAppActive()).toBe(false);
  });

  it('reads inactive while the document is hidden even if the native window is focused', async () => {
    setDocument({ focused: false, visible: false });
    installBridge(() => Promise.resolve(true));
    const { isAppActive } = await import('../use-app-active.js');
    await settle();
    expect(isAppActive()).toBe(false);
  });

  it('follows pushed native focus changes, and the pane taking DOM focus does not flip it', async () => {
    setDocument({ focused: true, visible: true });
    const bridge = installBridge(() => Promise.resolve(true));
    const { isAppActive } = await import('../use-app-active.js');
    await settle();
    expect(isAppActive()).toBe(true);

    bridge.emit(false);
    expect(isAppActive()).toBe(false);
    bridge.emit(true);
    expect(isAppActive()).toBe(true);

    // Focus moves into the pane: the renderer's own window fires `blur` and
    // `document.hasFocus()` goes false, but the native window is still focused.
    setDocument({ focused: false, visible: true });
    window.dispatchEvent(new Event('blur'));
    expect(isAppActive()).toBe(true);
  });

  it('tracks visibility changes on top of the native focus', async () => {
    setDocument({ focused: false, visible: true });
    installBridge(() => Promise.resolve(true));
    const { isAppActive } = await import('../use-app-active.js');
    await settle();
    expect(isAppActive()).toBe(true);

    setDocument({ focused: false, visible: false });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(isAppActive()).toBe(false);
    setDocument({ focused: false, visible: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(isAppActive()).toBe(true);
  });

  it('re-renders a useAppActive consumer when the native focus is pushed', async () => {
    setDocument({ focused: true, visible: true });
    const bridge = installBridge(() => Promise.resolve(true));
    const { useAppActive } = await import('../use-app-active.js');
    const { act, renderHook } = await import('@testing-library/react');
    const { result } = renderHook(() => useAppActive());
    await act(settle);
    expect(result.current).toBe(true);

    act(() => {
      bridge.emit(false);
    });
    expect(result.current).toBe(false);
  });

  describe('before the native value has arrived', () => {
    it('bridges on the renderer own reading so a focused startup never flashes inactive', async () => {
      setDocument({ focused: true, visible: true });
      installBridge(() => new Promise<boolean>(() => undefined));
      const { isAppActive } = await import('../use-app-active.js');
      expect(isAppActive()).toBe(true);
    });

    it('bridges on the renderer own reading for a background startup too', async () => {
      setDocument({ focused: false, visible: true });
      installBridge(() => new Promise<boolean>(() => undefined));
      const { isAppActive } = await import('../use-app-active.js');
      expect(isAppActive()).toBe(false);
    });

    it('replaces the bridged reading with the native value, notifying subscribers', async () => {
      setDocument({ focused: true, visible: true });
      let resolveInitial: (focused: boolean) => void = () => undefined;
      installBridge(
        () =>
          new Promise<boolean>((resolve) => {
            resolveInitial = resolve;
          })
      );
      const { isAppActive } = await import('../use-app-active.js');
      expect(isAppActive()).toBe(true);

      resolveInitial(false);
      await settle();
      expect(isAppActive()).toBe(false);
    });

    it('lets a pushed change that landed first win over the older initial read', async () => {
      setDocument({ focused: false, visible: true });
      let resolveInitial: (focused: boolean) => void = () => undefined;
      const bridge = installBridge(
        () =>
          new Promise<boolean>((resolve) => {
            resolveInitial = resolve;
          })
      );
      const { isAppActive } = await import('../use-app-active.js');

      bridge.emit(true);
      expect(isAppActive()).toBe(true);
      // The initial read was taken BEFORE the push; its reply must not undo it.
      resolveInitial(false);
      await settle();
      expect(isAppActive()).toBe(true);
    });
  });

  describe('when the initial native read fails', () => {
    it('reports the failure, keeps the bridged reading, and still follows pushes', async () => {
      setDocument({ focused: true, visible: true });
      const bridge = installBridge(() =>
        Promise.reject(new Error('Window is gone (window-focus · window_unavailable)'))
      );
      const logged: string[] = [];
      const { addLogListener, configureLogger, LogLevel, resetLogger } = await import(
        '@brainstrike/logging'
      );
      configureLogger({ console: false });
      const removeListener = addLogListener((record) => {
        if (record.level === LogLevel.ERROR) {
          logged.push(`${record.message ?? ''} ${JSON.stringify(record.args)}`);
        }
      });
      try {
        const { isAppActive } = await import('../use-app-active.js');
        await settle();
        expect(logged.join('\n')).toContain('window_unavailable');
        expect(isAppActive()).toBe(true);

        bridge.emit(false);
        expect(isAppActive()).toBe(false);
      } finally {
        removeListener();
        resetLogger();
      }
    });
  });

  it('reports a present-but-malformed bridge and uses the document focus instead', async () => {
    setDocument({ focused: true, visible: true });
    Object.defineProperty(window, 'windowFocus', {
      configurable: true,
      value: { isFocused: () => Promise.resolve(false) },
    });
    const { addLogListener, configureLogger, LogLevel, resetLogger } = await import(
      '@brainstrike/logging'
    );
    configureLogger({ console: false });
    const records: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      records.push(record);
    });
    try {
      const { isAppActive } = await import('../use-app-active.js');
      await settle();
      const malformed = records.find(
        (record) =>
          record.level === LogLevel.ERROR &&
          record.scope === 'WindowFocusBridge' &&
          record.message?.includes('window.windowFocus bridge is malformed')
      );
      expect(malformed?.args).toContainEqual({ missing: ['onChange'] });
      // Not the bridge's `false`: the malformed object is never consulted.
      expect(isAppActive()).toBe(true);
    } finally {
      removeListener();
      resetLogger();
    }
  });
});
