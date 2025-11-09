import path from 'node:path';
import type { createIpcMainMock, createIpcRendererMock } from '@brainstrike/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist the Electron mock to avoid factory/temporal dead zone issues
vi.mock('electron', async () => {
  const electronUtils = await import('@brainstrike/test-utils');
  const app = electronUtils.createAppMock({
    whenReadyResolved: true,
    documentsPath: '/mock/userData',
  });
  const ipcMain = electronUtils.createIpcMainMock();
  const ipcRenderer = electronUtils.createIpcRendererMock();
  // Wire renderer invokes to main handlers for convenience
  const mockInvoke = (ipcRenderer as unknown as ReturnType<typeof createIpcRendererMock>).invoke;
  mockInvoke.mockImplementation(async (channel: string, ...args: unknown[]) =>
    (ipcMain as unknown as ReturnType<typeof createIpcMainMock>).__invoke(channel, ...args)
  );
  return {
    app,
    ipcMain,
    ipcRenderer,
    BrowserWindow: vi.fn(),
    session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
  };
});

// Import mocked Electron parts for use in assertions
import { app, ipcMain, ipcRenderer } from 'electron';

vi.mock('@brainstrike/file-system', () => ({
  ElectronFileSystemAdapter: vi.fn(() => ({})),
  createFixtureCapableAdapter: (adapter: unknown) => adapter,
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
    (ipcMain as unknown as ReturnType<typeof createIpcMainMock>).handle.mockClear();
    (ipcRenderer as unknown as ReturnType<typeof createIpcRendererMock>).invoke.mockClear();
  });

  it('returns the user database path', async () => {
    const expected = path.join(app.getPath('documents'), 'BrainStrike-dev', 'pgdata');
    const result = await ipcRenderer.invoke('db:getUserDataPath');
    expect(result).toBe(expected);
  });
});
