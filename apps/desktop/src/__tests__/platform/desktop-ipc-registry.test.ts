import { resolve } from 'node:path';
import { addLogListener, type LogRecord } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_RENDERER_DOCUMENT_URL,
  configureDesktopRendererTarget,
  createDesktopRendererTarget,
} from '../../desktop-renderer-target';
import { createDesktopIpcRegistry } from '../../platform/desktop-ipc-registry';
import { createDesktopIpcSenderFrameAllowlist } from '../../platform/desktop-ipc-sender-frame';
import { assignWindowRole, clearWindowRoleByWebContentsId } from '../../window-role';

type MockInvokeHandler = (event: unknown, ...args: unknown[]) => unknown;
type MockEventHandler = (event: unknown, payload: unknown) => void;

const BUILT_RENDERER_PATH = resolve('/opt/brainstrike/dist/renderer/index.html');
const BUILT_RENDERER_URL = APP_RENDERER_DOCUMENT_URL;
const RENDERER_TARGET = createDesktopRendererTarget({
  builtRendererPath: BUILT_RENDERER_PATH,
  devRendererUrl: 'http://localhost:38181',
  launchMode: 'built',
});
const SENDER_FRAME_ALLOWLIST = createDesktopIpcSenderFrameAllowlist(RENDERER_TARGET);
const UNAUTHENTICATED = { reason: 'test registration' } as const;

function createMockIpcMain() {
  return {
    handle: vi.fn<(channel: string, handler: MockInvokeHandler) => void>(),
    on: vi.fn<(channel: string, handler: MockEventHandler) => void>(),
    removeHandler: vi.fn<(channel: string) => void>(),
    removeListener: vi.fn<(channel: string, handler: MockEventHandler) => void>(),
  };
}

function createRegistry(ipcMain: ReturnType<typeof createMockIpcMain>) {
  return createDesktopIpcRegistry({
    ipcMain: ipcMain as unknown as Parameters<typeof createDesktopIpcRegistry>[0]['ipcMain'],
    senderFrameAllowlist: SENDER_FRAME_ALLOWLIST,
  });
}

function trackWindowRole(webContentsId: number, role: 'embedding-host' | 'visible-ui'): void {
  assignWindowRole(
    {
      isDestroyed: () => false,
      once: vi.fn(),
      webContents: { id: webContentsId },
    } as never,
    role
  );
}

describe('desktop IPC registry', () => {
  afterEach(() => {
    configureDesktopRendererTarget(null);
  });

  it('registers invoke and event channels with stable domain metadata', () => {
    const ipcMain = createMockIpcMain();
    const registry = createRegistry(ipcMain);
    const invokeHandler = vi.fn();
    const eventHandler = vi.fn();

    registry.registerUnauthenticatedInvoke(
      'embeddings',
      'embedding-host:warmup',
      UNAUTHENTICATED,
      invokeHandler
    );
    registry.registerEvent('embeddings', 'embedding-host:report-status', eventHandler);

    expect(ipcMain.handle).toHaveBeenCalledWith('embedding-host:warmup', invokeHandler);
    expect(ipcMain.on).toHaveBeenCalledWith('embedding-host:report-status', eventHandler);
    expect(registry.getSnapshot()).toEqual([
      { channel: 'embedding-host:report-status', domain: 'embeddings', kind: 'event' },
      { channel: 'embedding-host:warmup', domain: 'embeddings', kind: 'invoke' },
    ]);
  });

  it('requires an explicit non-empty reason for an unauthenticated registration', () => {
    const ipcMain = createMockIpcMain();
    const registry = createRegistry(ipcMain);

    expect(() =>
      registry.registerUnauthenticatedInvoke('db', 'db:ping', { reason: '   ' }, vi.fn())
    ).toThrow('Desktop IPC unauthenticated registration requires a non-empty reason.');
    expect(ipcMain.handle).not.toHaveBeenCalled();
  });

  it('rejects duplicate channel registration instead of silently replacing handlers', () => {
    const ipcMain = createMockIpcMain();
    const registry = createRegistry(ipcMain);

    registry.registerUnauthenticatedInvoke('db', 'db:query', UNAUTHENTICATED, vi.fn());

    expect(() =>
      registry.registerUnauthenticatedInvoke('diagnostics', 'db:query', UNAUTHENTICATED, vi.fn())
    ).toThrow('Desktop IPC channel already registered: db:query');
    expect(ipcMain.handle).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid channel names before registration', () => {
    const ipcMain = createMockIpcMain();
    const registry = createRegistry(ipcMain);

    expect(() =>
      registry.registerUnauthenticatedInvoke('db', '  ', UNAUTHENTICATED, vi.fn())
    ).toThrow('Desktop IPC channel must be a non-empty string.');
    expect(() =>
      registry.registerUnauthenticatedInvoke('db', 'db:\0query', UNAUTHENTICATED, vi.fn())
    ).toThrow('Desktop IPC channel must not contain null bytes.');
    expect(ipcMain.handle).not.toHaveBeenCalled();
  });

  it('authorizes a declared sender role with an allowlisted sender frame before dispatching arguments', async () => {
    const ipcMain = createMockIpcMain();
    const registry = createRegistry(ipcMain);
    trackWindowRole(8101, 'visible-ui');
    const handler = vi.fn((_event: unknown, payload: string) => `accepted:${payload}`);
    registry.registerAuthorizedInvoke(
      'preferences',
      'secrets:get',
      { roles: ['visible-ui'] },
      handler
    );
    const registeredHandler = ipcMain.handle.mock.calls[0]?.[1];
    const event = { sender: { id: 8101 }, senderFrame: { url: BUILT_RENDERER_URL } };

    await expect(registeredHandler?.(event, 'openai')).resolves.toBe('accepted:openai');
    expect(handler).toHaveBeenCalledWith(event, 'openai');
    clearWindowRoleByWebContentsId(8101);
  });

  it('accepts a hidden-host sender frame that differs from the visible renderer only by query', async () => {
    const ipcMain = createMockIpcMain();
    const registry = createRegistry(ipcMain);
    trackWindowRole(8104, 'embedding-host');
    const handler = vi.fn(() => 'ok');
    registry.registerAuthorizedInvoke(
      'db',
      'db:exec',
      { roles: ['embedding-host', 'visible-ui'] },
      handler
    );
    const registeredHandler = ipcMain.handle.mock.calls[0]?.[1];

    await expect(
      registeredHandler?.({
        sender: { id: 8104 },
        senderFrame: { url: `${BUILT_RENDERER_URL}?mode=embedding-host&runtimeId=018f-1` },
      })
    ).resolves.toBe('ok');
    expect(handler).toHaveBeenCalledTimes(1);
    clearWindowRoleByWebContentsId(8104);
  });

  it.each([
    ['a hidden sender', 8102, 'embedding-host'],
    ['an untracked sender', 8103, null],
  ] as const)(
    'rejects %s before invoking an authorized handler',
    async (_label, senderId, role) => {
      const ipcMain = createMockIpcMain();
      const registry = createRegistry(ipcMain);
      if (role) {
        trackWindowRole(senderId, role);
      }
      const handler = vi.fn();
      registry.registerAuthorizedInvoke(
        'agent',
        'agent:host-connect',
        { roles: ['visible-ui'] },
        handler
      );
      const registeredHandler = ipcMain.handle.mock.calls[0]?.[1];

      await expect(
        registeredHandler?.({ sender: { id: senderId }, senderFrame: { url: BUILT_RENDERER_URL } })
      ).rejects.toThrow('Desktop IPC agent:host-connect requires sender role visible-ui.');
      expect(handler).not.toHaveBeenCalled();
      clearWindowRoleByWebContentsId(senderId);
    }
  );

  it.each([
    ['a foreign https origin', 'https://evil.example/index.html'],
    ['a sibling file next to the renderer', `${BUILT_RENDERER_URL}.evil.html`],
    ['the dev server while running the built renderer', 'http://localhost:38181/'],
    ['about:blank', 'about:blank'],
  ])(
    'rejects a spoofed sender frame (%s) even when sender.id maps to an allowed role',
    async (_label, url) => {
      const ipcMain = createMockIpcMain();
      const registry = createRegistry(ipcMain);
      trackWindowRole(8105, 'visible-ui');
      const handler = vi.fn();
      registry.registerAuthorizedInvoke(
        'terminal',
        'terminal:create',
        { roles: ['visible-ui'] },
        handler
      );
      const registeredHandler = ipcMain.handle.mock.calls[0]?.[1];

      await expect(
        registeredHandler?.({ sender: { id: 8105 }, senderFrame: { url } }, { rootId: 'r1' })
      ).rejects.toThrow('Desktop IPC terminal:create rejected an unrecognized sender frame URL.');
      expect(handler).not.toHaveBeenCalled();
      clearWindowRoleByWebContentsId(8105);
    }
  );

  it.each([
    ['null', null],
    ['missing', undefined],
  ])('fails closed when senderFrame is %s', async (_label, senderFrame) => {
    const ipcMain = createMockIpcMain();
    const registry = createRegistry(ipcMain);
    trackWindowRole(8106, 'visible-ui');
    const handler = vi.fn();
    registry.registerAuthorizedInvoke(
      'shell',
      'shell:open-external',
      { roles: ['visible-ui'] },
      handler
    );
    const registeredHandler = ipcMain.handle.mock.calls[0]?.[1];
    const event =
      senderFrame === undefined ? { sender: { id: 8106 } } : { sender: { id: 8106 }, senderFrame };

    await expect(registeredHandler?.(event, 'https://example.com')).rejects.toThrow(
      'Desktop IPC shell:open-external requires a live sender frame.'
    );
    expect(handler).not.toHaveBeenCalled();
    clearWindowRoleByWebContentsId(8106);
  });

  it('fails closed when no allowlist was injected and no renderer target was configured process-wide', async () => {
    const ipcMain = createMockIpcMain();
    const registry = createDesktopIpcRegistry({
      ipcMain: ipcMain as unknown as Parameters<typeof createDesktopIpcRegistry>[0]['ipcMain'],
    });
    trackWindowRole(8107, 'visible-ui');
    const handler = vi.fn();
    registry.registerAuthorizedInvoke('git', 'git:push', { roles: ['visible-ui'] }, handler);
    const registeredHandler = ipcMain.handle.mock.calls[0]?.[1];

    await expect(
      registeredHandler?.({ sender: { id: 8107 }, senderFrame: { url: BUILT_RENDERER_URL } })
    ).rejects.toThrow('Desktop renderer target is not configured.');
    expect(handler).not.toHaveBeenCalled();
    clearWindowRoleByWebContentsId(8107);
  });

  it('derives the allowlist from the process-wide renderer target when none is injected', async () => {
    configureDesktopRendererTarget(RENDERER_TARGET);
    const ipcMain = createMockIpcMain();
    const registry = createDesktopIpcRegistry({
      ipcMain: ipcMain as unknown as Parameters<typeof createDesktopIpcRegistry>[0]['ipcMain'],
    });
    trackWindowRole(8108, 'visible-ui');
    const handler = vi.fn(() => 'pushed');
    registry.registerAuthorizedInvoke('git', 'git:push', { roles: ['visible-ui'] }, handler);
    const registeredHandler = ipcMain.handle.mock.calls[0]?.[1];

    await expect(
      registeredHandler?.({ sender: { id: 8108 }, senderFrame: { url: BUILT_RENDERER_URL } })
    ).resolves.toBe('pushed');
    clearWindowRoleByWebContentsId(8108);
  });

  it('fails closed with the curated error when the sender frame url getter throws (disposed frame)', async () => {
    const ipcMain = createMockIpcMain();
    const registry = createRegistry(ipcMain);
    trackWindowRole(8109, 'visible-ui');
    const handler = vi.fn();
    registry.registerAuthorizedInvoke('git', 'git:push', { roles: ['visible-ui'] }, handler);
    const registeredHandler = ipcMain.handle.mock.calls[0]?.[1];
    const disposedFrame = {
      get url(): string {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      },
    };

    await expect(
      registeredHandler?.({ sender: { id: 8109 }, senderFrame: disposedFrame })
    ).rejects.toThrow('Desktop IPC git:push requires a live sender frame.');
    expect(handler).not.toHaveBeenCalled();
    clearWindowRoleByWebContentsId(8109);
  });

  it('logs a main-process warning naming the channel and the rejected frame URL', async () => {
    const ipcMain = createMockIpcMain();
    const registry = createRegistry(ipcMain);
    trackWindowRole(8110, 'visible-ui');
    const handler = vi.fn();
    registry.registerAuthorizedInvoke('git', 'git:push', { roles: ['visible-ui'] }, handler);
    const registeredHandler = ipcMain.handle.mock.calls[0]?.[1];
    const captured: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      captured.push(record);
    });

    try {
      await expect(
        registeredHandler?.({ sender: { id: 8110 }, senderFrame: { url: 'https://evil.example/' } })
      ).rejects.toThrow('Desktop IPC git:push rejected an unrecognized sender frame URL.');
    } finally {
      unsubscribe();
      clearWindowRoleByWebContentsId(8110);
    }

    const record = captured.find(
      (entry) =>
        entry.scope === 'DesktopIpcRegistry' &&
        entry.level === 'warn' &&
        entry.args.some(
          (arg) =>
            typeof arg === 'object' &&
            arg !== null &&
            (arg as Record<string, unknown>)['channel'] === 'git:push' &&
            (arg as Record<string, unknown>)['senderFrameUrl'] === 'https://evil.example/'
        )
    );
    expect(record).toBeDefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects empty and duplicate sender-role policies at registration', () => {
    const ipcMain = createMockIpcMain();
    const registry = createRegistry(ipcMain);

    expect(() =>
      registry.registerAuthorizedInvoke('agent', 'agent:host-connect', { roles: [] }, vi.fn())
    ).toThrow('Desktop IPC sender policy must allow at least one window role.');
    expect(() =>
      registry.registerAuthorizedInvoke(
        'agent',
        'agent:host-connect',
        { roles: ['visible-ui', 'visible-ui'] },
        vi.fn()
      )
    ).toThrow('Desktop IPC sender policy must not contain duplicate window roles.');
    expect(ipcMain.handle).not.toHaveBeenCalled();
  });

  it('unregisters owned invoke and event channels', () => {
    const ipcMain = createMockIpcMain();
    const registry = createRegistry(ipcMain);
    const eventHandler = vi.fn();

    registry.registerUnauthenticatedInvoke(
      'embeddings',
      'embedding-host:ensure-started',
      UNAUTHENTICATED,
      vi.fn()
    );
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
