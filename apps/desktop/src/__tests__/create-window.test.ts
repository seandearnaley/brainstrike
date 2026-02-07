import { app, BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWindow } from '../create-window';
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

  beforeEach(() => {
    vi.clearAllMocks();

    mockWebContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      openDevTools: vi.fn(),
    };

    mockBrowserWindow = {
      once: vi.fn(),
      show: vi.fn(),
      isDestroyed: vi.fn(() => false),
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
    Reflect.deleteProperty(process.env, 'CI');
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
        },
        titleBarStyle: 'default',
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

    it('should show window when ready in non-headless mode', async () => {
      existsSyncMock.mockReturnValue(true);
      Reflect.deleteProperty(process.env, 'CI');

      await createWindow();

      expect(mockBrowserWindow.once).toHaveBeenCalledWith('ready-to-show', expect.any(Function));

      // Trigger the ready-to-show callback
      const readyCallback = mockBrowserWindow.once.mock.calls[0][1];
      readyCallback();

      expect(mockBrowserWindow.show).toHaveBeenCalled();
    });

    it('should not show window in headless mode (CI environment)', async () => {
      existsSyncMock.mockReturnValue(true);
      process.env['CI'] = 'true';

      await createWindow();

      expect(mockBrowserWindow.once).not.toHaveBeenCalled();
      expect(mockBrowserWindow.show).not.toHaveBeenCalled();
    });

    it('should not show window in test mode', async () => {
      existsSyncMock.mockReturnValue(true);
      const originalArgv = process.argv;
      process.argv = [...originalArgv, '--test-mode'];

      await createWindow();

      expect(mockBrowserWindow.once).not.toHaveBeenCalled();
      expect(mockBrowserWindow.show).not.toHaveBeenCalled();

      process.argv = originalArgv;
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

      const handler = mockWebContents.on.mock.calls[0][1];
      const mockEvent = { preventDefault: vi.fn() };

      // Should allow localhost
      handler(mockEvent, 'http://localhost:3000/path');
      expect(mockEvent.preventDefault).not.toHaveBeenCalled();

      // Should allow file protocol
      handler(mockEvent, 'file:///some/path');
      expect(mockEvent.preventDefault).not.toHaveBeenCalled();

      // Should prevent external navigation
      handler(mockEvent, 'https://external.com');
      expect(mockEvent.preventDefault).toHaveBeenCalled();
    });
  });

  describe('renderer loading', () => {
    it('should load production renderer when packaged', async () => {
      existsSyncMock.mockReturnValue(true);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: true, configurable: true });

      await createWindow();

      expect(mockBrowserWindow.loadFile).toHaveBeenCalledWith(
        expect.stringContaining('renderer/index.html')
      );
      expect(mockBrowserWindow.loadURL).not.toHaveBeenCalled();
    });

    it('should load production renderer when built files exist', async () => {
      existsSyncMock.mockReturnValue(true);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });
      mockBrowserWindow.loadURL.mockResolvedValue(undefined);

      await createWindow();

      expect(mockBrowserWindow.loadURL).toHaveBeenCalledWith('http://localhost:8081');
      expect(mockWebContents.openDevTools).toHaveBeenCalled();
      expect(mockBrowserWindow.loadFile).not.toHaveBeenCalled();
    });

    it('should connect to dev server when not packaged and no built files', async () => {
      existsSyncMock.mockReturnValue(false);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });
      mockBrowserWindow.loadURL.mockResolvedValue(undefined);

      await createWindow();

      expect(mockBrowserWindow.loadURL).toHaveBeenCalledWith('http://localhost:8081');
      expect(mockWebContents.openDevTools).toHaveBeenCalled();
      expect(mockBrowserWindow.loadFile).not.toHaveBeenCalled();
    });

    it('should refuse production fallback when dev server fails even with built files', async () => {
      existsSyncMock.mockReturnValue(true);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });
      mockBrowserWindow.loadURL.mockRejectedValue(new Error('Dev server unavailable'));

      await expect(createWindow()).rejects.toThrow(
        'Dev renderer unavailable in non-packaged mode; refusing production fallback'
      );
      expect(mockBrowserWindow.loadURL).toHaveBeenCalled();
      expect(mockBrowserWindow.loadURL).toHaveBeenNthCalledWith(1, 'http://localhost:8081');
      const attemptedUrls = mockBrowserWindow.loadURL.mock.calls.map((call: [string]) => call[0]);
      for (const url of attemptedUrls) {
        expect(url).toBe('http://localhost:8081');
      }
      expect(mockBrowserWindow.loadFile).not.toHaveBeenCalled();
      expect(mockWebContents.openDevTools).not.toHaveBeenCalled();
    });

    it('should attempt the deterministic dev server URL in test runtime', async () => {
      existsSyncMock.mockReturnValue(false);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });

      mockBrowserWindow.loadURL.mockResolvedValueOnce(undefined);

      await createWindow();

      expect(mockBrowserWindow.loadURL).toHaveBeenCalledTimes(1);
      expect(mockBrowserWindow.loadURL).toHaveBeenCalledWith('http://localhost:8081');
    });

    it('should throw error if deterministic dev renderer URL fails repeatedly', async () => {
      existsSyncMock.mockReturnValue(false);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });

      const error = new Error('All ports unavailable');
      mockBrowserWindow.loadURL.mockRejectedValue(error);

      await expect(createWindow()).rejects.toThrow(
        'Dev renderer unavailable in non-packaged mode; refusing production fallback'
      );
      expect(mockBrowserWindow.loadURL).toHaveBeenCalled();
      const attemptedUrls = mockBrowserWindow.loadURL.mock.calls.map((call: [string]) => call[0]);
      for (const url of attemptedUrls) {
        expect(url).toBe('http://localhost:8081');
      }
      expect(mockBrowserWindow.loadFile).not.toHaveBeenCalled();
    });
  });
});
