import { describe, expect, it, vi } from 'vitest';
import { createDesktopIpcRegistry } from '../../platform/desktop-ipc-registry';

type MockInvokeHandler = (event: unknown, ...args: unknown[]) => unknown;
type MockEventHandler = (event: unknown, payload: unknown) => void;

function createMockIpcMain() {
  return {
    handle: vi.fn<(channel: string, handler: MockInvokeHandler) => void>(),
    on: vi.fn<(channel: string, handler: MockEventHandler) => void>(),
    removeHandler: vi.fn<(channel: string) => void>(),
    removeListener: vi.fn<(channel: string, handler: MockEventHandler) => void>(),
  };
}

describe('desktop IPC registry', () => {
  it('registers invoke and event channels with stable domain metadata', () => {
    const ipcMain = createMockIpcMain();
    const registry = createDesktopIpcRegistry({ ipcMain });
    const invokeHandler = vi.fn();
    const eventHandler = vi.fn();

    registry.registerInvoke('llm-host', 'llm-host:warmup', invokeHandler);
    registry.registerEvent('llm-host', 'llm-host:report-status', eventHandler);

    expect(ipcMain.handle).toHaveBeenCalledWith('llm-host:warmup', invokeHandler);
    expect(ipcMain.on).toHaveBeenCalledWith('llm-host:report-status', eventHandler);
    expect(registry.getSnapshot()).toEqual([
      { channel: 'llm-host:report-status', domain: 'llm-host', kind: 'event' },
      { channel: 'llm-host:warmup', domain: 'llm-host', kind: 'invoke' },
    ]);
  });

  it('rejects duplicate channel registration instead of silently replacing handlers', () => {
    const ipcMain = createMockIpcMain();
    const registry = createDesktopIpcRegistry({ ipcMain });

    registry.registerInvoke('db', 'db:query', vi.fn());

    expect(() => registry.registerInvoke('diagnostics', 'db:query', vi.fn())).toThrow(
      'Desktop IPC channel already registered: db:query'
    );
    expect(ipcMain.handle).toHaveBeenCalledTimes(1);
  });

  it('unregisters owned invoke and event channels', () => {
    const ipcMain = createMockIpcMain();
    const registry = createDesktopIpcRegistry({ ipcMain });
    const eventHandler = vi.fn();

    registry.registerInvoke('embeddings', 'embedding-host:ensure-started', vi.fn());
    registry.registerEvent('embeddings', 'embedding-host:report-status', eventHandler);
    registry.unregisterAll();

    expect(ipcMain.removeHandler).toHaveBeenCalledWith('embedding-host:ensure-started');
    expect(ipcMain.removeListener).toHaveBeenCalledWith(
      'embedding-host:report-status',
      eventHandler
    );
    expect(registry.getSnapshot()).toEqual([]);
  });
});
