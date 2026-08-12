import { describe, expect, it, vi } from 'vitest';
import { createDesktopIpcRegistry } from '../../platform/desktop-ipc-registry';
import { assignWindowRole, clearWindowRoleByWebContentsId } from '../../window-role';

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
    const registry = createDesktopIpcRegistry({
      ipcMain: ipcMain as unknown as Parameters<typeof createDesktopIpcRegistry>[0]['ipcMain'],
    });
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
    const registry = createDesktopIpcRegistry({
      ipcMain: ipcMain as unknown as Parameters<typeof createDesktopIpcRegistry>[0]['ipcMain'],
    });

    registry.registerInvoke('db', 'db:query', vi.fn());

    expect(() => registry.registerInvoke('diagnostics', 'db:query', vi.fn())).toThrow(
      'Desktop IPC channel already registered: db:query'
    );
    expect(ipcMain.handle).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid channel names before registration', () => {
    const ipcMain = createMockIpcMain();
    const registry = createDesktopIpcRegistry({
      ipcMain: ipcMain as unknown as Parameters<typeof createDesktopIpcRegistry>[0]['ipcMain'],
    });

    expect(() => registry.registerInvoke('db', '  ', vi.fn())).toThrow(
      'Desktop IPC channel must be a non-empty string.'
    );
    expect(() => registry.registerInvoke('db', 'db:\0query', vi.fn())).toThrow(
      'Desktop IPC channel must not contain null bytes.'
    );
    expect(ipcMain.handle).not.toHaveBeenCalled();
  });

  it('authorizes a declared sender role before dispatching arguments', async () => {
    const ipcMain = createMockIpcMain();
    const registry = createDesktopIpcRegistry({
      ipcMain: ipcMain as unknown as Parameters<typeof createDesktopIpcRegistry>[0]['ipcMain'],
    });
    const visibleWindow = {
      isDestroyed: () => false,
      once: vi.fn(),
      webContents: { id: 8101 },
    };
    assignWindowRole(visibleWindow as never, 'visible-ui');
    const handler = vi.fn((_event: unknown, payload: string) => `accepted:${payload}`);
    registry.registerAuthorizedInvoke(
      'preferences',
      'secrets:get',
      { roles: ['visible-ui'] },
      handler
    );
    const registeredHandler = ipcMain.handle.mock.calls[0]?.[1];

    await expect(registeredHandler?.({ sender: { id: 8101 } }, 'openai')).resolves.toBe(
      'accepted:openai'
    );
    expect(handler).toHaveBeenCalledWith({ sender: { id: 8101 } }, 'openai');
    clearWindowRoleByWebContentsId(8101);
  });

  it.each([
    ['a hidden sender', 8102, 'embedding-host'],
    ['an untracked sender', 8103, null],
  ] as const)('rejects %s before invoking an authorized handler', async (_label, senderId, role) => {
    const ipcMain = createMockIpcMain();
    const registry = createDesktopIpcRegistry({
      ipcMain: ipcMain as unknown as Parameters<typeof createDesktopIpcRegistry>[0]['ipcMain'],
    });
    if (role) {
      assignWindowRole(
        {
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { id: senderId },
        } as never,
        role
      );
    }
    const handler = vi.fn();
    registry.registerAuthorizedInvoke(
      'agent',
      'assistant:get-auth',
      { roles: ['visible-ui'] },
      handler
    );
    const registeredHandler = ipcMain.handle.mock.calls[0]?.[1];

    await expect(registeredHandler?.({ sender: { id: senderId } })).rejects.toThrow(
      'Desktop IPC assistant:get-auth requires sender role visible-ui.'
    );
    expect(handler).not.toHaveBeenCalled();
    clearWindowRoleByWebContentsId(senderId);
  });

  it('rejects empty and duplicate sender-role policies at registration', () => {
    const ipcMain = createMockIpcMain();
    const registry = createDesktopIpcRegistry({
      ipcMain: ipcMain as unknown as Parameters<typeof createDesktopIpcRegistry>[0]['ipcMain'],
    });

    expect(() =>
      registry.registerAuthorizedInvoke('agent', 'assistant:get-auth', { roles: [] }, vi.fn())
    ).toThrow('Desktop IPC sender policy must allow at least one window role.');
    expect(() =>
      registry.registerAuthorizedInvoke(
        'agent',
        'assistant:get-auth',
        { roles: ['visible-ui', 'visible-ui'] },
        vi.fn()
      )
    ).toThrow('Desktop IPC sender policy must not contain duplicate window roles.');
    expect(ipcMain.handle).not.toHaveBeenCalled();
  });

  it('unregisters owned invoke and event channels', () => {
    const ipcMain = createMockIpcMain();
    const registry = createDesktopIpcRegistry({
      ipcMain: ipcMain as unknown as Parameters<typeof createDesktopIpcRegistry>[0]['ipcMain'],
    });
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
