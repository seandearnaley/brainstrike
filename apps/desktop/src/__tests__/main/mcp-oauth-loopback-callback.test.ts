import { Server } from 'node:http';
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
});
