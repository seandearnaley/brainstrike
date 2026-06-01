import path from 'node:path';
import { addLogListener } from '@brainstrike/utils';
import { app, BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWindow, noteNextWindowReload } from '../create-window';
import { DESKTOP_DEV_RENDERER_URL } from '../desktop-renderer-url';
import type { DesktopWindowState } from '../store-schema';

// Hoist mocks for Vitest 4 compatibility
const { existsSyncMock, MockBrowserWindow, screenMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  MockBrowserWindow: vi.fn(),
  screenMock: vi.fn(),
}));
vi.mock('node:fs', () => ({
  default: { existsSync: existsSyncMock },
  existsSync: existsSyncMock,
}));
vi.mock('@brainstrike/utils', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils')>('@brainstrike/utils');
  return actual;
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    on: vi.fn(),
  },
  BrowserWindow: MockBrowserWindow,
  Menu: {
    setApplicationMenu: vi.fn(),
    buildFromTemplate: vi.fn(),
  },
  screen: {
    getAllDisplays: screenMock,
  },
}));

describe('createWindow', () => {
  let mockBrowserWindow: any;
  let mockWebContents: any;
  const baseArgv = process.argv.filter((arg) => arg !== '--test-mode');

  beforeEach(() => {
    vi.clearAllMocks();
    process.argv = [...baseArgv];

    mockWebContents = {
      getURL: vi.fn(() => `${DESKTOP_DEV_RENDERER_URL}/`),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      openDevTools: vi.fn(),
      reload: vi.fn(),
    };

    mockBrowserWindow = {
      once: vi.fn(),
      show: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isFocused: vi.fn(() => true),
      loadFile: vi.fn(),
      loadURL: vi.fn(),
      maximize: vi.fn(),
      on: vi.fn(),
      webContents: mockWebContents,
    } as any;

    screenMock.mockReturnValue([{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }]);

    // Use function syntax for Vitest 4 constructor mocks
    MockBrowserWindow.mockImplementation(function (this: Record<string, unknown>) {
      Object.assign(this, mockBrowserWindow);
    });
  });

  afterEach(() => {
    process.argv = [...baseArgv];
    Reflect.deleteProperty(process.env, 'CI');
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_DESKTOP_OPEN_DEVTOOLS');
  });

  describe('window creation', () => {
    it('should create window with correct configuration (production mode with sandbox enabled)', async () => {
      existsSyncMock.mockReturnValue(true);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: true, configurable: true });
      // Ensure not in test mode - sandbox should be enabled in production
      Reflect.deleteProperty(process.env, 'CI');

      await createWindow();

      expect(BrowserWindow).toHaveBeenCalledWith({
        width: 1440,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        fullscreen: false,
        webPreferences: {
          preload: expect.stringContaining('preload.js'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          experimentalFeatures: false,
          safeDialogs: true,
          navigateOnDragDrop: false,
          backgroundThrottling: true,
        },
        titleBarStyle: 'default',
        backgroundColor: '#0b1020',
        show: false,
      });
      expect(mockBrowserWindow.maximize).toHaveBeenCalled();
    });

    it('should apply stored window bounds and maximize preference', async () => {
      existsSyncMock.mockReturnValue(true);

      const storedState: DesktopWindowState = {
        bounds: { width: 1024, height: 768, x: 120, y: 80 },
        isFullScreen: false,
        isMaximized: true,
      };

      await createWindow({ windowState: storedState });

      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 1024,
          height: 768,
          x: 120,
          y: 80,
          fullscreen: false,
        })
      );
      expect(mockBrowserWindow.maximize).toHaveBeenCalled();
    });

    it('should clamp stored window bounds to the visible work area', async () => {
      existsSyncMock.mockReturnValue(true);
      screenMock.mockReturnValue([{ workArea: { x: 0, y: 0, width: 1200, height: 800 } }]);

      const storedState: DesktopWindowState = {
        bounds: { width: 1600, height: 900, x: 100, y: 100 },
        isFullScreen: false,
        isMaximized: false,
      };

      await createWindow({ windowState: storedState });

      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 1200,
          height: 800,
          x: 0,
          y: 0,
        })
      );
    });

    it('should fall back to default bounds when stored window is off-screen', async () => {
      existsSyncMock.mockReturnValue(true);
      screenMock.mockReturnValue([{ workArea: { x: 0, y: 0, width: 1200, height: 800 } }]);

      const storedState: DesktopWindowState = {
        bounds: { width: 900, height: 700, x: 5000, y: 4000 },
        isFullScreen: false,
        isMaximized: true,
      };

      await createWindow({ windowState: storedState });

      const args = vi.mocked(BrowserWindow).mock.calls[0]?.[0] as Record<string, unknown>;

      expect(args).toEqual(
        expect.objectContaining({
          width: 1200,
          height: 800,
        })
      );
      expect('x' in args).toBe(false);
      expect('y' in args).toBe(false);
    });

    it('should clamp window size when position is undefined but size exceeds screen', async () => {
      existsSyncMock.mockReturnValue(true);
      screenMock.mockReturnValue([{ workArea: { x: 0, y: 0, width: 1200, height: 800 } }]);

      const storedState: DesktopWindowState = {
        bounds: { width: 3000, height: 2000 },
        isFullScreen: false,
        isMaximized: true,
      };

      await createWindow({ windowState: storedState });

      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 1200,
          height: 800,
        })
      );
    });

    it('should disable sandbox in CI environment for Playwright compatibility', async () => {
      existsSyncMock.mockReturnValue(true);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: true, configurable: true });
      process.env['CI'] = 'true';

      await createWindow();

      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          webPreferences: expect.objectContaining({
            sandbox: false,
          }),
        })
      );
    });

    it('keeps the primary visible renderer opted into Chromium background throttling', async () => {
      existsSyncMock.mockReturnValue(true);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: true, configurable: true });

      await createWindow();

      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          webPreferences: expect.objectContaining({
            backgroundThrottling: true,
          }),
        })
      );
    });

    it('should show window after renderer load in non-headless mode', async () => {
      existsSyncMock.mockReturnValue(true);
      Reflect.deleteProperty(process.env, 'CI');
      mockBrowserWindow.loadURL.mockResolvedValue(undefined);

      await createWindow();

      expect(mockBrowserWindow.once).toHaveBeenCalledWith('ready-to-show', expect.any(Function));
      expect(mockBrowserWindow.show).toHaveBeenCalled();
    });

    it('should not show window in headless mode (CI environment)', async () => {
      existsSyncMock.mockReturnValue(true);
      process.env['CI'] = 'true';

      await createWindow();

      expect(
        mockBrowserWindow.once.mock.calls.some(([event]: [string]) => event === 'ready-to-show')
      ).toBe(false);
      expect(mockBrowserWindow.show).not.toHaveBeenCalled();
    });

    it('should not show window in test mode', async () => {
      existsSyncMock.mockReturnValue(true);
      const originalArgv = process.argv;
      process.argv = [...originalArgv, '--test-mode'];

      await createWindow();

      expect(
        mockBrowserWindow.once.mock.calls.some(([event]: [string]) => event === 'ready-to-show')
      ).toBe(false);
      expect(mockBrowserWindow.show).not.toHaveBeenCalled();

      process.argv = originalArgv;
    });

    it('keeps desktop E2E windows hidden even when stored state is maximized', async () => {
      existsSyncMock.mockReturnValue(true);
      process.argv = [...process.argv, '--test-mode'];

      const storedState: DesktopWindowState = {
        bounds: { width: 1024, height: 768, x: 120, y: 80 },
        isFullScreen: false,
        isMaximized: true,
      };

      await createWindow({ windowState: storedState });

      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          focusable: false,
          skipTaskbar: true,
          show: false,
        })
      );
      expect(mockBrowserWindow.maximize).not.toHaveBeenCalled();
      expect(mockBrowserWindow.show).not.toHaveBeenCalled();
    });

    it('limits renderer crash recovery reloads to avoid crash loops', async () => {
      vi.useFakeTimers();
      existsSyncMock.mockReturnValue(true);

      await createWindow();

      const renderProcessGoneCall = mockWebContents.on.mock.calls.find(
        (call: [string, (...args: unknown[]) => void]) => call[0] === 'render-process-gone'
      );
      expect(renderProcessGoneCall).toBeDefined();
      const handler = renderProcessGoneCall?.[1] as (
        event: unknown,
        details: { reason: string; exitCode: number }
      ) => void;

      // Each crash defers reload to a 3s fallback timer
      handler({}, { reason: 'crashed', exitCode: 1 });
      vi.advanceTimersByTime(3500);
      handler({}, { reason: 'abnormal-exit', exitCode: 1 });
      vi.advanceTimersByTime(3500);
      handler({}, { reason: 'crashed', exitCode: 1 });
      vi.advanceTimersByTime(3500);
      // 4th crash exceeds the limit — no reload scheduled
      handler({}, { reason: 'crashed', exitCode: 1 });
      vi.advanceTimersByTime(3500);

      expect(mockWebContents.reload).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });

    it('triggers reload when window gains focus while recovery is pending', async () => {
      vi.useFakeTimers();
      existsSyncMock.mockReturnValue(true);

      await createWindow();

      const rpcHandler = mockWebContents.on.mock.calls.find(
        (call: [string, (...args: unknown[]) => void]) => call[0] === 'render-process-gone'
      )?.[1] as (event: unknown, details: { reason: string; exitCode: number }) => void;
      const focusHandler = mockBrowserWindow.on.mock.calls.find(
        (call: [string, (...args: unknown[]) => void]) => call[0] === 'focus'
      )?.[1] as () => void;

      expect(rpcHandler).toBeDefined();
      expect(focusHandler).toBeDefined();

      // Crash defers recovery
      rpcHandler({}, { reason: 'crashed', exitCode: 5 });
      expect(mockWebContents.reload).not.toHaveBeenCalled();

      // Focus triggers reload before the 3s timer
      focusHandler();
      expect(mockWebContents.reload).toHaveBeenCalledTimes(1);

      // Timer fires later but pendingRendererRecovery is already false — no double reload
      vi.advanceTimersByTime(3500);
      expect(mockWebContents.reload).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('attributes the next renderer navigation when a reload reason is provided', async () => {
      existsSyncMock.mockReturnValue(true);
      const captured: Array<{ args: readonly unknown[]; message?: string; scope?: string }> = [];
      const unsubscribe = addLogListener((record) => {
        captured.push(record);
      });

      try {
        await createWindow();

        const createdWindow = vi.mocked(BrowserWindow).mock.instances.at(-1) as
          | Electron.BrowserWindow
          | undefined;

        expect(createdWindow).toBeDefined();

        noteNextWindowReload(createdWindow as Electron.BrowserWindow, {
          reason: 'factory-reset',
          source: 'renderer',
        });

        const didStartLoadingHandler = mockWebContents.on.mock.calls.find(
          (call: [string, (...args: unknown[]) => void]) => call[0] === 'did-start-loading'
        )?.[1] as (() => void) | undefined;

        expect(didStartLoadingHandler).toBeDefined();
        didStartLoadingHandler?.();

        const record = [...captured]
          .reverse()
          .find(
            (entry) =>
              entry.scope === 'CreateWindow' &&
              entry.message === 'Window startup: did-start-loading'
          );

        expect(record?.args).toContainEqual(
          expect.objectContaining({
            reloadReason: 'factory-reset',
            reloadSource: 'renderer',
          })
        );
      } finally {
        unsubscribe();
      }
    });

    it('ignores post-startup loading churn without reload intent or top-level navigation', async () => {
      existsSyncMock.mockReturnValue(true);
      const captured: Array<{ args: readonly unknown[]; message?: string; scope?: string }> = [];
      const unsubscribe = addLogListener((record) => {
        captured.push(record);
      });

      try {
        await createWindow();

        const didFinishLoadHandler = mockWebContents.on.mock.calls.find(
          (call: [string, (...args: unknown[]) => void]) => call[0] === 'did-finish-load'
        )?.[1] as (() => void) | undefined;
        const didStartLoadingHandler = mockWebContents.on.mock.calls.find(
          (call: [string, (...args: unknown[]) => void]) => call[0] === 'did-start-loading'
        )?.[1] as (() => void) | undefined;

        expect(didFinishLoadHandler).toBeDefined();
        expect(didStartLoadingHandler).toBeDefined();

        didFinishLoadHandler?.();
        didStartLoadingHandler?.();

        const postStartupDidStartLoadingRecords = captured.filter(
          (entry) =>
            entry.scope === 'CreateWindow' && entry.message === 'Window startup: did-start-loading'
        );

        expect(postStartupDidStartLoadingRecords).toHaveLength(0);
      } finally {
        unsubscribe();
      }
    });

    it('marks post-startup top-level navigation without recorded intent', async () => {
      existsSyncMock.mockReturnValue(true);
      const captured: Array<{ args: readonly unknown[]; message?: string; scope?: string }> = [];
      const unsubscribe = addLogListener((record) => {
        captured.push(record);
      });

      try {
        await createWindow();

        const didFinishLoadHandler = mockWebContents.on.mock.calls.find(
          (call: [string, (...args: unknown[]) => void]) => call[0] === 'did-finish-load'
        )?.[1] as (() => void) | undefined;
        const didStartNavigationHandler = mockWebContents.on.mock.calls.find(
          (call: [string, (...args: unknown[]) => void]) => call[0] === 'did-start-navigation'
        )?.[1] as
          | ((event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void)
          | undefined;
        const didStartLoadingHandler = mockWebContents.on.mock.calls.find(
          (call: [string, (...args: unknown[]) => void]) => call[0] === 'did-start-loading'
        )?.[1] as (() => void) | undefined;

        expect(didFinishLoadHandler).toBeDefined();
        expect(didStartNavigationHandler).toBeDefined();
        expect(didStartLoadingHandler).toBeDefined();

        didFinishLoadHandler?.();
        didStartNavigationHandler?.(
          {},
          `${DESKTOP_DEV_RENDERER_URL}/#settings/database`,
          false,
          true
        );
        didStartLoadingHandler?.();

        const record = [...captured]
          .reverse()
          .find(
            (entry) =>
              entry.scope === 'CreateWindow' &&
              entry.message === 'Window startup: did-start-loading'
          );

        expect(record?.args).toContainEqual(
          expect.objectContaining({
            reloadReason: 'top-level-navigation',
            reloadSource: 'unknown',
            url: `${DESKTOP_DEV_RENDERER_URL}/#settings/database`,
            windowRole: 'visible-ui',
          })
        );
      } finally {
        unsubscribe();
      }
    });

    it('triggers reload on app activate while recovery is pending', async () => {
      vi.useFakeTimers();
      existsSyncMock.mockReturnValue(true);

      await createWindow();

      const rpcHandler = mockWebContents.on.mock.calls.find(
        (call: [string, (...args: unknown[]) => void]) => call[0] === 'render-process-gone'
      )?.[1] as (event: unknown, details: { reason: string; exitCode: number }) => void;
      const activateHandler = vi
        .mocked(app)
        .on.mock.calls.find((call) => call[0] === 'activate')?.[1] as () => void;

      expect(rpcHandler).toBeDefined();
      expect(activateHandler).toBeDefined();

      rpcHandler({}, { reason: 'crashed', exitCode: 5 });
      activateHandler();
      expect(mockWebContents.reload).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('does NOT trigger reload for killed or clean-exit reasons', async () => {
      vi.useFakeTimers();
      existsSyncMock.mockReturnValue(true);

      await createWindow();

      const rpcHandler = mockWebContents.on.mock.calls.find(
        (call: [string, (...args: unknown[]) => void]) => call[0] === 'render-process-gone'
      )?.[1] as (event: unknown, details: { reason: string; exitCode: number }) => void;

      rpcHandler({}, { reason: 'killed', exitCode: 0 });
      rpcHandler({}, { reason: 'clean-exit', exitCode: 0 });

      vi.advanceTimersByTime(5000);
      expect(mockWebContents.reload).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('resets crash count after the 30-second window elapses', async () => {
      vi.useFakeTimers();
      existsSyncMock.mockReturnValue(true);

      await createWindow();

      const rpcHandler = mockWebContents.on.mock.calls.find(
        (call: [string, (...args: unknown[]) => void]) => call[0] === 'render-process-gone'
      )?.[1] as (event: unknown, details: { reason: string; exitCode: number }) => void;

      // Fill the crash window (3 crashes)
      for (let i = 0; i < 3; i++) {
        rpcHandler({}, { reason: 'crashed', exitCode: 1 });
        vi.advanceTimersByTime(3500);
      }
      expect(mockWebContents.reload).toHaveBeenCalledTimes(3);

      // Advance past the 30s crash window
      vi.advanceTimersByTime(30_001);

      // 4th crash after window reset should reload again
      rpcHandler({}, { reason: 'crashed', exitCode: 1 });
      vi.advanceTimersByTime(3500);
      expect(mockWebContents.reload).toHaveBeenCalledTimes(4);

      vi.useRealTimers();
    });

    it('skips reload if window is destroyed before fallback timer fires', async () => {
      vi.useFakeTimers();
      existsSyncMock.mockReturnValue(true);

      await createWindow();

      const rpcHandler = mockWebContents.on.mock.calls.find(
        (call: [string, (...args: unknown[]) => void]) => call[0] === 'render-process-gone'
      )?.[1] as (event: unknown, details: { reason: string; exitCode: number }) => void;

      rpcHandler({}, { reason: 'crashed', exitCode: 5 });

      // Window destroyed before the 3s timer fires
      mockBrowserWindow.isDestroyed.mockReturnValue(true);
      vi.advanceTimersByTime(3500);
      expect(mockWebContents.reload).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('security configuration', () => {
    it('should configure window open handler', async () => {
      existsSyncMock.mockReturnValue(true);

      await createWindow();

      expect(mockWebContents.setWindowOpenHandler).toHaveBeenCalled();

      const handler = mockWebContents.setWindowOpenHandler.mock.calls[0][0];

      expect(handler({ url: 'http://localhost:3000' })).toEqual({ action: 'allow' });
      expect(handler({ url: 'file://some/path' })).toEqual({ action: 'allow' });
      expect(handler({ url: 'https://evil.com' })).toEqual({ action: 'deny' });
    });

    it('should prevent navigation to external URLs', async () => {
      existsSyncMock.mockReturnValue(true);

      await createWindow();

      expect(mockWebContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function));

      const willNavigateCall = mockWebContents.on.mock.calls.find(
        (call: [string, (event: unknown, url: string) => void]) => call[0] === 'will-navigate'
      );
      expect(willNavigateCall).toBeDefined();
      const handler = willNavigateCall?.[1];
      const mockEvent = { preventDefault: vi.fn() };

      // Should allow localhost
      handler?.(mockEvent, 'http://localhost:3000/path');
      expect(mockEvent.preventDefault).not.toHaveBeenCalled();

      // Should allow file protocol
      handler?.(mockEvent, 'file:///some/path');
      expect(mockEvent.preventDefault).not.toHaveBeenCalled();

      // Should prevent external navigation
      handler?.(mockEvent, 'https://external.com');
      expect(mockEvent.preventDefault).toHaveBeenCalled();
    });
  });

  describe('renderer loading', () => {
    it('should load production renderer when packaged', async () => {
      existsSyncMock.mockReturnValue(true);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: true, configurable: true });

      await createWindow();

      expect(mockBrowserWindow.loadFile).toHaveBeenCalledWith(
        expect.stringContaining(path.join('renderer', 'index.html'))
      );
      expect(mockBrowserWindow.loadURL).not.toHaveBeenCalled();
    });

    it('should load built renderer by default when unpackaged', async () => {
      existsSyncMock.mockReturnValue(true);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });

      await createWindow();

      expect(mockBrowserWindow.loadFile).toHaveBeenCalledWith(
        expect.stringContaining(path.join('renderer', 'index.html'))
      );
      expect(mockBrowserWindow.loadURL).not.toHaveBeenCalled();
    });

    it('should connect to dev server only when dev-server mode is explicit', async () => {
      existsSyncMock.mockReturnValue(false);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });
      mockBrowserWindow.loadURL.mockResolvedValue(undefined);
      process.argv.push('--brainstrike-desktop-launch-mode=dev-server');

      await createWindow();

      expect(mockBrowserWindow.loadURL).toHaveBeenCalledWith(DESKTOP_DEV_RENDERER_URL);
      expect(mockWebContents.openDevTools).not.toHaveBeenCalled();
      expect(mockBrowserWindow.loadFile).not.toHaveBeenCalled();
    });

    it('should throw when built renderer is missing in default built mode', async () => {
      existsSyncMock.mockReturnValue(false);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });

      await expect(createWindow()).rejects.toThrow(
        'Built renderer is required in packaged/test mode but was not found'
      );

      expect(mockBrowserWindow.loadURL).not.toHaveBeenCalled();
      expect(mockBrowserWindow.loadFile).not.toHaveBeenCalled();
    });

    it('should load built renderer in CI test mode when not packaged', async () => {
      existsSyncMock.mockReturnValue(true);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });
      process.env['CI'] = 'true';

      await createWindow();

      expect(mockBrowserWindow.loadFile).toHaveBeenCalledWith(
        expect.stringContaining(path.join('renderer', 'index.html'))
      );
      expect(mockBrowserWindow.loadURL).not.toHaveBeenCalled();
      expect(mockWebContents.openDevTools).not.toHaveBeenCalled();
    });

    it('should throw in CI test mode if built renderer is missing', async () => {
      existsSyncMock.mockReturnValue(false);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });
      process.env['CI'] = 'true';

      await expect(createWindow()).rejects.toThrow(
        'Built renderer is required in packaged/test mode but was not found'
      );

      expect(mockBrowserWindow.loadFile).not.toHaveBeenCalled();
      expect(mockBrowserWindow.loadURL).not.toHaveBeenCalled();
    });

    it('should open devtools only when explicitly enabled', async () => {
      existsSyncMock.mockReturnValue(false);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });
      process.env['BRAINSTRIKE_DESKTOP_OPEN_DEVTOOLS'] = '1';
      process.argv.push('--brainstrike-desktop-launch-mode=dev-server');
      await createWindow();

      expect(mockBrowserWindow.loadURL).toHaveBeenCalledWith(DESKTOP_DEV_RENDERER_URL);
      expect(mockWebContents.openDevTools).toHaveBeenCalledTimes(1);
    });

    it('should refuse production fallback when dev server fails even with built files', async () => {
      existsSyncMock.mockReturnValue(true);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });
      mockBrowserWindow.loadURL.mockRejectedValue(new Error('Dev server unavailable'));
      process.argv.push('--brainstrike-desktop-launch-mode=dev-server');

      await expect(createWindow()).rejects.toThrow(
        'Dev renderer unavailable in non-packaged mode; refusing production fallback'
      );
      expect(mockBrowserWindow.loadURL).toHaveBeenCalled();
      expect(mockBrowserWindow.loadURL).toHaveBeenNthCalledWith(1, DESKTOP_DEV_RENDERER_URL);
      const attemptedUrls = mockBrowserWindow.loadURL.mock.calls.map((call: [string]) => call[0]);
      for (const url of attemptedUrls) {
        expect(url).toBe(DESKTOP_DEV_RENDERER_URL);
      }
      expect(mockBrowserWindow.loadFile).not.toHaveBeenCalled();
      expect(mockWebContents.openDevTools).not.toHaveBeenCalled();
    });

    it('should attempt the deterministic dev server URL in test runtime', async () => {
      existsSyncMock.mockReturnValue(false);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });
      process.argv.push('--brainstrike-desktop-launch-mode=dev-server');

      mockBrowserWindow.loadURL.mockResolvedValueOnce(undefined);

      await createWindow();

      expect(mockBrowserWindow.loadURL).toHaveBeenCalledTimes(1);
      expect(mockBrowserWindow.loadURL).toHaveBeenCalledWith(DESKTOP_DEV_RENDERER_URL);
    });

    it('should not probe the legacy web-adjacent port in dev-server mode', async () => {
      existsSyncMock.mockReturnValue(false);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });
      process.argv.push('--brainstrike-desktop-launch-mode=dev-server');

      mockBrowserWindow.loadURL.mockResolvedValueOnce(undefined);

      await createWindow();

      const attemptedUrls = mockBrowserWindow.loadURL.mock.calls.map((call: [string]) => call[0]);
      expect(attemptedUrls).toEqual([DESKTOP_DEV_RENDERER_URL]);
      for (const url of attemptedUrls) {
        expect(url).not.toContain(':8081');
      }
      expect(mockBrowserWindow.loadFile).not.toHaveBeenCalled();
    });

    it('should throw error if deterministic dev renderer URL fails repeatedly', async () => {
      existsSyncMock.mockReturnValue(false);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });
      process.argv.push('--brainstrike-desktop-launch-mode=dev-server');

      const error = new Error('All ports unavailable');
      mockBrowserWindow.loadURL.mockRejectedValue(error);

      await expect(createWindow()).rejects.toThrow(
        'Dev renderer unavailable in non-packaged mode; refusing production fallback'
      );
      expect(mockBrowserWindow.loadURL).toHaveBeenCalled();
      const attemptedUrls = mockBrowserWindow.loadURL.mock.calls.map((call: [string]) => call[0]);
      for (const url of attemptedUrls) {
        expect(url).toBe(DESKTOP_DEV_RENDERER_URL);
      }
      expect(mockBrowserWindow.loadFile).not.toHaveBeenCalled();
    });
  });
});
