import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CALLBACK_PATH, startLoopbackCallback } from '../../mcp/oauth-loopback-callback';

const { loggerWarn } = vi.hoisted(() => ({ loggerWarn: vi.fn() }));

vi.mock('@brainstrike/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: loggerWarn,
  }),
}));

describe('MCP OAuth loopback callback listener faults', () => {
  /**
   * The bind-time rejector must not survive `bindLoopback`'s retry, so without a
   * permanent replacement the bound server carries zero `'error'` listeners.
   * Node throws an unhandled `'error'` event, which in Electron main is a
   * process crash rather than a failed OAuth callback (BST-1597 review).
   */
  it('absorbs and reports an accept-path failure after the listener is bound', async () => {
    loggerWarn.mockClear();
    const listen = vi.spyOn(Server.prototype, 'listen');
    const callback = await startLoopbackCallback(DEFAULT_CALLBACK_PATH, undefined);
    try {
      const server = listen.mock.contexts.at(-1);
      if (!(server instanceof Server)) {
        throw new Error('The loopback callback did not bind an HTTP server.');
      }
      expect(server.listenerCount('error')).toBeGreaterThan(0);

      expect(() =>
        server.emit('error', Object.assign(new Error('accept failed'), { code: 'EMFILE' }))
      ).not.toThrow();

      expect(loggerWarn).toHaveBeenCalledWith(
        'MCP OAuth loopback callback listener failed after binding',
        expect.objectContaining({
          cause: expect.objectContaining({ code: 'EMFILE' }),
          port: callback.port,
          reason: 'loopback-listener-error',
        })
      );
      // The listener survives the fault, so the callback stays usable.
      await expect(callback.arm('state-after-fault')).resolves.toBeUndefined();
    } finally {
      listen.mockRestore();
      await callback.close();
    }
  });

  it('rejects a duplicate waiter without orphaning the first attempt', async (): Promise<void> => {
    vi.useFakeTimers();
    const callback = await startLoopbackCallback(DEFAULT_CALLBACK_PATH, undefined);
    try {
      await callback.arm('state-one');
      const first = callback.wait();
      const duplicate = callback.wait();
      callback.cancel();
      await expect(duplicate).rejects.toThrow('MCP OAuth callback wait is already active.');
      await expect(first).rejects.toThrow('MCP OAuth authorization was cancelled.');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      callback.cancel();
      await callback.close();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('closes a queued waiter and joins its timer cleanup', async (): Promise<void> => {
    vi.useFakeTimers();
    const callback = await startLoopbackCallback(DEFAULT_CALLBACK_PATH, undefined);
    try {
      await callback.arm('state-one');
      const waiting = callback.wait();
      void waiting.catch((): void => undefined);
      await callback.close();
      expect(vi.getTimerCount()).toBe(0);
      await expect(waiting).rejects.toThrow('MCP OAuth authorization was cancelled.');
    } finally {
      callback.cancel();
      await callback.close();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps timeout terminal after closing the listener', async (): Promise<void> => {
    vi.useFakeTimers();
    const callback = await startLoopbackCallback(DEFAULT_CALLBACK_PATH, undefined);
    try {
      await callback.arm('state-one');
      const waiting = callback.wait();
      void waiting.catch((): void => undefined);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await expect(waiting).rejects.toThrow('MCP OAuth authorization callback timed out.');
      await expect(callback.arm('state-two')).rejects.toThrow(
        'MCP OAuth loopback callback is closed.'
      );
    } finally {
      await callback.close();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('removes the temporary error listener when a fresh bind throws synchronously', async (): Promise<void> => {
    let failedServer: Server | undefined;
    const listen = vi.spyOn(Server.prototype, 'listen').mockImplementation(function (
      this: Server
    ): Server {
      failedServer = this;
      throw new Error('synthetic bind failure');
    });
    try {
      await expect(startLoopbackCallback(DEFAULT_CALLBACK_PATH, undefined)).rejects.toThrow(
        'synthetic bind failure'
      );
      expect(failedServer?.listenerCount('error')).toBe(0);
      expect(failedServer?.listening).toBe(false);
    } finally {
      listen.mockRestore();
    }
  });

  it('reports an occupied persisted port and binds a fresh listener', async (): Promise<void> => {
    loggerWarn.mockClear();
    const occupied = createServer();
    await new Promise<void>((resolve): void => {
      occupied.listen(0, '127.0.0.1', resolve);
    });
    const preferredPort = (occupied.address() as AddressInfo).port;
    try {
      const callback = await startLoopbackCallback(DEFAULT_CALLBACK_PATH, preferredPort);
      try {
        expect(callback.port).not.toBe(preferredPort);
        expect(loggerWarn).toHaveBeenCalledWith(
          'MCP OAuth loopback port is unavailable; falling back to a fresh port',
          expect.objectContaining({ port: preferredPort, reason: 'loopback-port-bind-failed' })
        );
      } finally {
        await callback.close();
      }
    } finally {
      await new Promise<void>((resolve): void => {
        occupied.close((): void => resolve());
      });
    }
  });

  it('joins cleanup for a cancelled attempt and an immediate replacement', async (): Promise<void> => {
    vi.useFakeTimers();
    const callback = await startLoopbackCallback(DEFAULT_CALLBACK_PATH, undefined);
    try {
      await callback.arm('first');
      const first = callback.wait();
      void first.catch((): void => undefined);
      callback.cancel();
      await callback.arm('second');
      const second = callback.wait();
      void second.catch((): void => undefined);
      await callback.close();
      await expect(first).rejects.toThrow('MCP OAuth authorization was cancelled.');
      await expect(second).rejects.toThrow('MCP OAuth authorization was cancelled.');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      callback.cancel();
      await callback.close();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('waits for the close callback and exposes a server cleanup failure', async (): Promise<void> => {
    const listen = vi.spyOn(Server.prototype, 'listen');
    const callback = await startLoopbackCallback(DEFAULT_CALLBACK_PATH, undefined);
    const server = listen.mock.contexts.at(-1);
    listen.mockRestore();
    if (!(server instanceof Server)) {
      throw new Error('The loopback callback did not bind an HTTP server.');
    }
    const failure = new Error('synthetic connection cleanup failure');
    const closeAll = vi.spyOn(server, 'closeAllConnections').mockImplementation((): void => {
      throw failure;
    });
    try {
      await expect(callback.close()).rejects.toBe(failure);
      expect(server.listening).toBe(false);
      expect(server.listenerCount('error')).toBe(0);
    } finally {
      closeAll.mockRestore();
    }
  });

  it('keeps the timeout message and close failure cause after listener teardown', async (): Promise<void> => {
    vi.useFakeTimers();
    const listen = vi.spyOn(Server.prototype, 'listen');
    const callback = await startLoopbackCallback(DEFAULT_CALLBACK_PATH, undefined);
    const server = listen.mock.contexts.at(-1);
    listen.mockRestore();
    if (!(server instanceof Server)) {
      throw new Error('The loopback callback did not bind an HTTP server.');
    }
    const failure = new Error('synthetic connection cleanup failure');
    const closeAll = vi.spyOn(server, 'closeAllConnections').mockImplementation((): void => {
      throw failure;
    });
    try {
      await callback.arm('state-one');
      const waiting = callback.wait();
      void waiting.catch((): void => undefined);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await expect(waiting).rejects.toMatchObject({
        cause: failure,
        message: 'MCP OAuth authorization callback timed out.',
      });
      await expect(callback.close()).rejects.toBe(failure);
      expect(server.listening).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      closeAll.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('preserves a waiter started before arm and completes it from a real callback', async (): Promise<void> => {
    const callback = await startLoopbackCallback(DEFAULT_CALLBACK_PATH, undefined);
    try {
      const waiting = callback.wait();
      await callback.arm('state-one');
      const response = await fetch(`${callback.redirectUrl}?state=state-one&code=accepted`);
      expect(response.status).toBe(200);
      expect((await waiting).toString()).toBe('state=state-one&code=accepted');
    } finally {
      await callback.close();
    }
  });

  it('leaves a callback received before wait inactive', async (): Promise<void> => {
    const callback = await startLoopbackCallback(DEFAULT_CALLBACK_PATH, undefined);
    try {
      await callback.arm('state-one');
      const response = await fetch(`${callback.redirectUrl}?state=state-one&code=accepted`);
      expect(response.status).toBe(200);
      await expect(callback.wait()).rejects.toThrow('MCP OAuth callback wait is not active.');
    } finally {
      await callback.close();
    }
  });

  it('refuses a real callback after terminal close has fenced admission', async (): Promise<void> => {
    const listen = vi.spyOn(Server.prototype, 'listen');
    const callback = await startLoopbackCallback(DEFAULT_CALLBACK_PATH, undefined);
    const server = listen.mock.contexts.at(-1);
    listen.mockRestore();
    if (!(server instanceof Server)) {
      throw new Error('The loopback callback did not bind an HTTP server.');
    }
    await callback.arm('state-one');
    const originalClose = server.close.bind(server);
    let releaseClose: (() => void) | undefined;
    const close = vi.spyOn(server, 'close').mockImplementation((onClose): Server => {
      releaseClose = (): void => {
        originalClose(onClose);
      };
      return server;
    });
    try {
      const closing = callback.close();
      await vi.waitFor((): void => {
        expect(releaseClose).toBeDefined();
      });
      const response = await fetch(`${callback.redirectUrl}?state=state-one&code=late`);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Invalid state');
      const finishClose = releaseClose;
      releaseClose = undefined;
      finishClose?.();
      await closing;
    } finally {
      releaseClose?.();
      close.mockRestore();
      await callback.close();
    }
  });
});
