import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIpcMain, mockIpcRenderer, mockApp } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockIpcMain = {
    handle: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
      handlers.set(channel, listener);
    }),
  };

  const mockIpcRenderer = {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler for ${channel}`);
      return await handler({} as unknown, ...args);
    }),
  };

  const mockApp = {
    getPath: vi.fn((_name?: string) => '/mock/userData'),
    whenReady: vi.fn(() => new Promise<void>(() => {})),
    isPackaged: false,
    on: vi.fn(),
  };

  return { handlers, mockIpcMain, mockIpcRenderer, mockApp };
});

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  ipcRenderer: mockIpcRenderer,
  BrowserWindow: vi.fn(),
  app: mockApp,
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
}));

vi.mock('@brainstrike/file-system', () => ({
  ElectronFileSystemAdapter: vi.fn(() => ({})),
}));

vi.mock('@brainstrike/storage', () => ({
  ElectronStorageAdapter: vi.fn(() => ({})),
}));

vi.mock('electron-store', () => ({
  default: vi.fn(() => ({})),
}));

import '../main';

describe('db:getUserDataPath IPC handler', () => {
  beforeEach(() => {
    mockIpcMain.handle.mockClear();
    mockIpcRenderer.invoke.mockClear();
  });

  it('returns the user database path', async () => {
    const expected = path.join(mockApp.getPath('documents'), 'BrainStrike-dev', 'pgdata');
    const result = await mockIpcRenderer.invoke('db:getUserDataPath');
    expect(result).toBe(expected);
  });
});
