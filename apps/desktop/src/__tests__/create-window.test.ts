import fs from 'node:fs';
import { app, BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWindow } from '../create-window';

vi.mock('node:fs');
vi.mock('@brainstrike/utils', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils')>('@brainstrike/utils');
  return actual;
});
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
  BrowserWindow: vi.fn(),
}));

describe('createWindow', () => {
  // biome-ignore lint/suspicious/noExplicitAny: Mock objects in tests need flexible typing
  let mockBrowserWindow: any;
  // biome-ignore lint/suspicious/noExplicitAny: Mock objects in tests need flexible typing
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
      loadFile: vi.fn(),
      loadURL: vi.fn(),
      webContents: mockWebContents,
      // biome-ignore lint/suspicious/noExplicitAny: Mock objects in tests need flexible typing
    } as any;

    vi.mocked(BrowserWindow).mockImplementation(() => mockBrowserWindow);
  });

  afterEach(() => {
    process.env['CI'] = undefined;
  });

  describe('window creation', () => {
    it('should create window with correct configuration', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: true, configurable: true });

      await createWindow();

      expect(BrowserWindow).toHaveBeenCalledWith({
        width: 1536,
        height: 800,
        minWidth: 800,
        minHeight: 600,
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
    });

    it('should show window when ready in non-headless mode', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      process.env['CI'] = undefined;

      await createWindow();

      expect(mockBrowserWindow.once).toHaveBeenCalledWith('ready-to-show', expect.any(Function));

      // Trigger the ready-to-show callback
      const readyCallback = mockBrowserWindow.once.mock.calls[0][1];
      readyCallback();

      expect(mockBrowserWindow.show).toHaveBeenCalled();
    });

    it('should not show window in headless mode (CI environment)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      process.env['CI'] = 'true';

      await createWindow();

      expect(mockBrowserWindow.once).not.toHaveBeenCalled();
      expect(mockBrowserWindow.show).not.toHaveBeenCalled();
    });

    it('should not show window in test mode', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
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
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await createWindow();

      expect(mockWebContents.setWindowOpenHandler).toHaveBeenCalled();

      const handler = mockWebContents.setWindowOpenHandler.mock.calls[0][0];

      expect(handler({ url: 'http://localhost:3000' })).toEqual({ action: 'allow' });
      expect(handler({ url: 'file://some/path' })).toEqual({ action: 'allow' });
      expect(handler({ url: 'https://evil.com' })).toEqual({ action: 'deny' });
    });

    it('should prevent navigation to external URLs', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

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
      vi.mocked(fs.existsSync).mockReturnValue(true);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: true, configurable: true });

      await createWindow();

      expect(mockBrowserWindow.loadFile).toHaveBeenCalledWith(
        expect.stringContaining('renderer/index.html')
      );
      expect(mockBrowserWindow.loadURL).not.toHaveBeenCalled();
    });

    it('should load production renderer when built files exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });

      await createWindow();

      expect(mockBrowserWindow.loadFile).toHaveBeenCalledWith(
        expect.stringContaining('renderer/index.html')
      );
      expect(mockBrowserWindow.loadURL).not.toHaveBeenCalled();
    });

    it('should connect to dev server when not packaged and no built files', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });
      mockBrowserWindow.loadURL.mockResolvedValue(undefined);

      await createWindow();

      expect(mockBrowserWindow.loadURL).toHaveBeenCalledWith('http://localhost:8081');
      expect(mockWebContents.openDevTools).toHaveBeenCalled();
      expect(mockBrowserWindow.loadFile).not.toHaveBeenCalled();
    });

    it('should try multiple ports for dev server', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });

      // First two ports fail, third succeeds
      mockBrowserWindow.loadURL
        .mockRejectedValueOnce(new Error('Port 8081 unavailable'))
        .mockRejectedValueOnce(new Error('Port 8082 unavailable'))
        .mockResolvedValueOnce(undefined);

      await createWindow();

      expect(mockBrowserWindow.loadURL).toHaveBeenCalledTimes(3);
      expect(mockBrowserWindow.loadURL).toHaveBeenNthCalledWith(1, 'http://localhost:8081');
      expect(mockBrowserWindow.loadURL).toHaveBeenNthCalledWith(2, 'http://localhost:8082');
      expect(mockBrowserWindow.loadURL).toHaveBeenNthCalledWith(3, 'http://localhost:8083');
    });

    it('should throw error if all dev server ports fail', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      Object.defineProperty(vi.mocked(app), 'isPackaged', { value: false, configurable: true });

      const error = new Error('All ports unavailable');
      mockBrowserWindow.loadURL.mockRejectedValue(error);

      await expect(createWindow()).rejects.toThrow('All ports unavailable');
    });
  });
});
