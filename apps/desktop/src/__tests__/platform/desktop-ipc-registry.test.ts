import { resolve } from 'node:path';
import { addLogListener, type LogRecord } from '@brainstrike/logging';
import { Schema } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { untrackAppWindow } from '../../app-windows';
import {
  APP_RENDERER_DOCUMENT_URL,
  configureDesktopRendererTarget,
  createDesktopRendererTarget,
} from '../../desktop-renderer-target';
import { DESKTOP_IPC_INVOKE_CHANNEL } from '../../platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from '../../platform/desktop-ipc-registry';
import { createDesktopIpcSenderFrameAllowlist } from '../../platform/desktop-ipc-sender-frame';
import {
  invokeDesktopIpcFrom,
  trackTestAppWindow,
} from '../helpers/desktop-ipc-sender-test-helpers';

const BUILT_RENDERER_PATH = resolve('/opt/brainstrike/dist/renderer/index.html');
const BUILT_RENDERER_URL = APP_RENDERER_DOCUMENT_URL;
const RENDERER_TARGET = createDesktopRendererTarget({
  builtRendererPath: BUILT_RENDERER_PATH,
  devRendererUrl: 'http://localhost:38181',
  launchMode: 'built',
});
const SENDER_FRAME_ALLOWLIST = createDesktopIpcSenderFrameAllowlist(RENDERER_TARGET);
const AnyArgs = Schema.Array(Schema.Unknown);

function createMockIpcMain() {
  return { handle: vi.fn() };
}

function createRegistry(ipcMain: ReturnType<typeof createMockIpcMain>) {
  return createDesktopIpcRegistry({
    ipcMain: ipcMain as never,
    senderFrameAllowlist: SENDER_FRAME_ALLOWLIST,
  });
}

function appWindowEvent(senderId: number, url: string = BUILT_RENDERER_URL) {
  trackTestAppWindow(senderId);
  return { sender: { id: senderId }, senderFrame: { url } };
}

describe('desktop IPC registry', () => {
  afterEach(() => {
    configureDesktopRendererTarget(null);
  });

  it('serves every method of every registry on one invoke channel per ipcMain', () => {
    const ipcMain = createMockIpcMain();
    const shell = createRegistry(ipcMain);
    const secrets = createRegistry(ipcMain);

    shell.handle('shell', 'shell:open-path', AnyArgs, vi.fn());
    shell.handle('shell', 'shell:open-external', AnyArgs, vi.fn());
    secrets.handle('preferences', 'secrets:get', AnyArgs, vi.fn());

    expect(ipcMain.handle).toHaveBeenCalledExactlyOnceWith(
      DESKTOP_IPC_INVOKE_CHANNEL,
      expect.any(Function)
    );
    expect(shell.getSnapshot()).toEqual([
      { channel: 'shell:open-external', domain: 'shell' },
      { channel: 'shell:open-path', domain: 'shell' },
    ]);
    expect(secrets.getSnapshot()).toEqual([{ channel: 'secrets:get', domain: 'preferences' }]);
  });

  it('dispatches an authorized call to the method handler with its arguments', async () => {
    const ipcMain = createMockIpcMain();
    const registry = createRegistry(ipcMain);
    const handler = vi.fn((_event: unknown, payload: string) => `accepted:${payload}`);
    registry.handle('preferences', 'secrets:get', Schema.Tuple([Schema.String]), handler);
    const event = appWindowEvent(8101);

    await expect(invokeDesktopIpcFrom(ipcMain, event, 'secrets:get', 'openai')).resolves.toBe(
      'accepted:openai'
    );
    expect(handler).toHaveBeenCalledExactlyOnceWith(event, 'openai');
    untrackAppWindow(8101);
  });

  it('refuses an unknown method from an authorized sender', async () => {
    const ipcMain = createMockIpcMain();
    createRegistry(ipcMain).handle('shell', 'shell:open-path', AnyArgs, vi.fn());

    await expect(
      invokeDesktopIpcFrom(ipcMain, appWindowEvent(8102), 'shell:format-disk')
    ).rejects.toThrow('No desktop IPC handler for shell:format-disk.');
    await expect(invokeDesktopIpcFrom(ipcMain, appWindowEvent(8102), 42 as never)).rejects.toThrow(
      'Desktop IPC requires a method name.'
    );
    untrackAppWindow(8102);
  });

  it('refuses an untracked sender before it learns whether a method exists', async () => {
    const ipcMain = createMockIpcMain();
    const shell = vi.fn();
    const secrets = vi.fn();
    const registry = createRegistry(ipcMain);
    registry.handle('shell', 'shell:open-external', AnyArgs, shell);
    registry.handle('preferences', 'secrets:get', AnyArgs, secrets);
    const untracked = { sender: { id: 8103 }, senderFrame: { url: BUILT_RENDERER_URL } };

    for (const method of ['shell:open-external', 'secrets:get', 'shell:format-disk']) {
      await expect(invokeDesktopIpcFrom(ipcMain, untracked, method, 'payload')).rejects.toThrow(
        `Desktop IPC ${method} requires an app window sender.`
      );
    }
    expect(shell).not.toHaveBeenCalled();
    expect(secrets).not.toHaveBeenCalled();
  });

  it.each([
    ['a foreign https origin', 'https://evil.example/index.html'],
    ['a sibling file next to the renderer', `${BUILT_RENDERER_URL}.evil.html`],
    ['the dev server while running the built renderer', 'http://localhost:38181/'],
    ['about:blank', 'about:blank'],
  ])('refuses a spoofed sender frame (%s) from a tracked app window', async (_label, url) => {
    const ipcMain = createMockIpcMain();
    const handler = vi.fn();
    createRegistry(ipcMain).handle('shell', 'shell:open-external', AnyArgs, handler);

    for (const method of ['shell:open-external', 'shell:format-disk']) {
      await expect(
        invokeDesktopIpcFrom(ipcMain, appWindowEvent(8104, url), method, { rootId: 'r1' })
      ).rejects.toThrow(`Desktop IPC ${method} rejected an unrecognized sender frame URL.`);
    }
    expect(handler).not.toHaveBeenCalled();
    untrackAppWindow(8104);
  });

  it.each([
    ['null', null],
    ['missing', undefined],
  ])('fails closed when senderFrame is %s', async (_label, senderFrame) => {
    const ipcMain = createMockIpcMain();
    const handler = vi.fn();
    createRegistry(ipcMain).handle('shell', 'shell:open-external', AnyArgs, handler);
    trackTestAppWindow(8105);
    const event =
      senderFrame === undefined ? { sender: { id: 8105 } } : { sender: { id: 8105 }, senderFrame };

    await expect(
      invokeDesktopIpcFrom(ipcMain, event, 'shell:open-external', 'https://example.com')
    ).rejects.toThrow('Desktop IPC shell:open-external requires a live sender frame.');
    expect(handler).not.toHaveBeenCalled();
    untrackAppWindow(8105);
  });

  it('fails closed with the curated error when the sender frame url getter throws (disposed frame)', async () => {
    const ipcMain = createMockIpcMain();
    const handler = vi.fn();
    createRegistry(ipcMain).handle('shell', 'shell:open-path', AnyArgs, handler);
    trackTestAppWindow(8106);
    const disposedFrame = {
      get url(): string {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      },
    };

    await expect(
      invokeDesktopIpcFrom(
        ipcMain,
        { sender: { id: 8106 }, senderFrame: disposedFrame },
        'shell:open-path'
      )
    ).rejects.toThrow('Desktop IPC shell:open-path requires a live sender frame.');
    expect(handler).not.toHaveBeenCalled();
    untrackAppWindow(8106);
  });

  it('fails closed when no allowlist was injected and no renderer target was configured process-wide', async () => {
    configureDesktopRendererTarget(null);
    const ipcMain = createMockIpcMain();
    const handler = vi.fn();
    createDesktopIpcRegistry({ ipcMain: ipcMain as never }).handle(
      'shell',
      'shell:open-path',
      AnyArgs,
      handler
    );

    await expect(
      invokeDesktopIpcFrom(ipcMain, appWindowEvent(8107), 'shell:open-path')
    ).rejects.toThrow('Desktop renderer target is not configured.');
    expect(handler).not.toHaveBeenCalled();
    untrackAppWindow(8107);
  });

  it('derives the allowlist from the process-wide renderer target when none is injected', async () => {
    configureDesktopRendererTarget(RENDERER_TARGET);
    const ipcMain = createMockIpcMain();
    createDesktopIpcRegistry({ ipcMain: ipcMain as never }).handle(
      'shell',
      'shell:open-path',
      AnyArgs,
      vi.fn(() => 'opened')
    );

    await expect(
      invokeDesktopIpcFrom(ipcMain, appWindowEvent(8108), 'shell:open-path')
    ).resolves.toBe('opened');
    untrackAppWindow(8108);
  });

  it('logs a main-process warning naming the method and the rejected frame URL', async () => {
    const ipcMain = createMockIpcMain();
    const handler = vi.fn();
    createRegistry(ipcMain).handle('shell', 'shell:open-path', AnyArgs, handler);
    const captured: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      captured.push(record);
    });

    try {
      await expect(
        invokeDesktopIpcFrom(
          ipcMain,
          appWindowEvent(8109, 'https://evil.example/'),
          'shell:open-path'
        )
      ).rejects.toThrow('Desktop IPC shell:open-path rejected an unrecognized sender frame URL.');
    } finally {
      unsubscribe();
      untrackAppWindow(8109);
    }

    const record = captured.find(
      (entry) =>
        entry.scope === 'DesktopIpcRegistry' &&
        entry.level === 'warn' &&
        entry.args.some(
          (arg) =>
            typeof arg === 'object' &&
            arg !== null &&
            (arg as Record<string, unknown>)['method'] === 'shell:open-path' &&
            (arg as Record<string, unknown>)['senderFrameUrl'] === 'https://evil.example/'
        )
    );
    expect(record).toBeDefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a method that another registry on the same ipcMain already serves', async () => {
    const ipcMain = createMockIpcMain();
    const first = vi.fn(() => 'first');
    createRegistry(ipcMain).handle('db', 'db:clearAll', AnyArgs, first);

    expect(() =>
      createRegistry(ipcMain).handle('diagnostics', 'db:clearAll', AnyArgs, vi.fn())
    ).toThrow('Desktop IPC method already registered: db:clearAll');
    await expect(invokeDesktopIpcFrom(ipcMain, appWindowEvent(8110), 'db:clearAll')).resolves.toBe(
      'first'
    );
    untrackAppWindow(8110);
  });

  it('rejects invalid method names before registration', () => {
    const registry = createRegistry(createMockIpcMain());

    expect(() => registry.handle('db', '  ', AnyArgs, vi.fn())).toThrow(
      'Desktop IPC method must be a non-empty string without null bytes.'
    );
    expect(() => registry.handle('db', 'db:\0query', AnyArgs, vi.fn())).toThrow(
      'Desktop IPC method must be a non-empty string without null bytes.'
    );
    expect(registry.getSnapshot()).toEqual([]);
  });

  it('unregisters only the methods its own registry served', async () => {
    const ipcMain = createMockIpcMain();
    const shell = createRegistry(ipcMain);
    const secrets = createRegistry(ipcMain);
    shell.handle(
      'shell',
      'shell:open-path',
      AnyArgs,
      vi.fn(() => 'opened')
    );
    secrets.handle(
      'preferences',
      'secrets:get',
      AnyArgs,
      vi.fn(() => 'secret')
    );
    const event = appWindowEvent(8111);

    shell.unregisterAll();

    expect(shell.getSnapshot()).toEqual([]);
    await expect(invokeDesktopIpcFrom(ipcMain, event, 'shell:open-path')).rejects.toThrow(
      'No desktop IPC handler for shell:open-path.'
    );
    await expect(invokeDesktopIpcFrom(ipcMain, event, 'secrets:get')).resolves.toBe('secret');

    const replacement = createRegistry(ipcMain);
    replacement.handle(
      'shell',
      'shell:open-path',
      AnyArgs,
      vi.fn(() => 'reopened')
    );
    await expect(invokeDesktopIpcFrom(ipcMain, event, 'shell:open-path')).resolves.toBe('reopened');
    expect(ipcMain.handle).toHaveBeenCalledTimes(1);
    untrackAppWindow(8111);
  });

  it('refuses arguments that do not match the method schema before the handler runs', async () => {
    const ipcMain = createMockIpcMain();
    const handler = vi.fn();
    createRegistry(ipcMain).handle(
      'preferences',
      'secrets:get',
      Schema.Tuple([Schema.String]),
      handler
    );
    const event = appWindowEvent(8112);
    const captured: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      captured.push(record);
    });

    try {
      for (const args of [[], [42], ['openai', 'extra']]) {
        await expect(invokeDesktopIpcFrom(ipcMain, event, 'secrets:get', ...args)).rejects.toThrow(
          'Desktop IPC secrets:get received invalid arguments'
        );
      }
    } finally {
      unsubscribe();
      untrackAppWindow(8112);
    }

    expect(handler).not.toHaveBeenCalled();
    expect(
      captured.filter((entry) => entry.scope === 'DesktopIpcRegistry' && entry.level === 'warn')
    ).toHaveLength(3);
  });
});
