import { createServer, Server as HttpServer, request as httpRequest, type Server } from 'node:http';
import { addLogListener } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isProviderAuthFlowCancelled, ProviderAuthFlowError } from '../../provider-auth/errors';
import { startLoopbackServer } from '../../provider-auth/loopback-server';

/**
 * Real-socket lane for the loopback callback server (BST-1355 + security
 * review). Fixtures bind port 0 (ephemeral) and read the bound port from the
 * handle — the fixed-port rule applies to real provider descriptors, not test
 * fixtures.
 */

type LoopbackHandle = Awaited<ReturnType<typeof startLoopbackServer>>;

const openHandles: LoopbackHandle[] = [];
const openServers: Server[] = [];

async function start(
  overrides: Partial<Parameters<typeof startLoopbackServer>[0]> = {}
): Promise<LoopbackHandle> {
  const handle = await startLoopbackServer({
    callbackPath: '/callback',
    expectedState: 'expected-state',
    port: 0,
    providerLabel: 'Fake Provider',
    ...overrides,
  });
  openHandles.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(openHandles.splice(0).map((handle) => handle.close()));
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

/** Attach the rejection handler BEFORE the flow settles so the expected
 * rejection is never momentarily unhandled (vitest flags those). */
function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => {
      throw new Error(`expected rejection, resolved with ${JSON.stringify(value)}`);
    },
    (error: unknown) => error
  );
}

/** Raw HTTP GET with an arbitrary Host header (fetch forbids overriding it). */
function rawGet(
  port: number,
  path: string,
  hostHeader: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        headers: { host: hostHeader },
        host: '127.0.0.1',
        method: 'GET',
        path,
        port,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        res.on('end', () => resolve({ body, status: res.statusCode ?? 0 }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('startLoopbackServer', () => {
  it('rejects a duplicate wait without replacing the original callback owner', async () => {
    const handle = await start();
    const first = handle.waitForCallback();
    const firstOutcome = first.then(
      (value) => value,
      (error: unknown) => error
    );
    let duplicateSettled = false;
    const duplicate = captureRejection(handle.waitForCallback()).then((error) => {
      duplicateSettled = true;
      return error;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(duplicateSettled).toBe(true);
    await expect(duplicate).resolves.toMatchObject({ code: 'flow_failed' });
    const response = await fetch(`${handle.redirectUri}?code=original-owner&state=expected-state`);
    await response.text();
    await expect(firstOutcome).resolves.toEqual({ code: 'original-owner' });
  });

  it('joins the original server close from every concurrent close call', async () => {
    const handle = await start();
    const originalClose = HttpServer.prototype.close;
    let releaseClose: (() => void) | undefined;
    const closeSpy = vi.spyOn(HttpServer.prototype, 'close').mockImplementation(function (
      this: Server,
      callback?: (error?: Error) => void
    ): Server {
      expect(this.listenerCount('error')).toBe(0);
      return originalClose.call(this, (error?: Error) => {
        releaseClose = () => callback?.(error);
      });
    });
    const first = handle.close();
    let secondCompleted = false;
    const second = handle.close().then(() => {
      secondCompleted = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(releaseClose).toBeTypeOf('function');
      expect(secondCompleted).toBe(false);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      releaseClose?.();
      closeSpy.mockRestore();
      await Promise.all([first, second]);
    }
    await expect(fetch(handle.redirectUri)).rejects.toThrow();
  });

  it('keeps an early callback terminal and rejects a later wait with the existing error', async () => {
    const handle = await start();
    const response = await fetch(`${handle.redirectUri}?code=early-code&state=expected-state`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Authorization successful');
    await expect(handle.waitForCallback()).rejects.toMatchObject({
      code: 'flow_failed',
      message: 'Loopback callback wait already settled.',
    });
    await handle.close();
    await expect(fetch(handle.redirectUri)).rejects.toThrow();
  });

  it('cancel before a wait closes the listener and keeps the settled-wait error', async () => {
    const handle = await start();
    handle.cancel();
    await handle.close();
    await expect(handle.waitForCallback()).rejects.toMatchObject({
      code: 'flow_failed',
      message: 'Loopback callback wait already settled.',
    });
    await expect(fetch(handle.redirectUri)).rejects.toThrow();
  });

  it('close cancels the active wait and joins listener shutdown and timer release', async () => {
    const handle = await start();
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
    const outcome = captureRejection(handle.waitForCallback());
    try {
      await handle.close();
      expect(clearTimer).toHaveBeenCalledTimes(1);
      await expect(outcome).resolves.toSatisfy(isProviderAuthFlowCancelled);
    } finally {
      clearTimer.mockRestore();
    }
    await expect(fetch(handle.redirectUri)).rejects.toThrow();
  });

  it('timeout owns the terminal outcome when cancel and close arrive afterward', async () => {
    const handle = await start({ timeoutMs: 20 });
    const outcome = captureRejection(handle.waitForCallback());
    const error = await outcome;
    handle.cancel();
    await handle.close();
    expect(error).toMatchObject({
      code: 'callback_timeout',
      message: 'OAuth callback was not received within 20ms.',
    });
    await expect(outcome).resolves.toBe(error);
    await expect(fetch(handle.redirectUri)).rejects.toThrow();
  });

  it('cancel keeps its error identity across repeated cancel and close calls', async () => {
    const handle = await start({ timeoutMs: 20 });
    const outcome = captureRejection(handle.waitForCallback());
    handle.cancel();
    const error = await outcome;
    handle.cancel();
    await Promise.all([handle.close(), handle.close()]);
    expect(isProviderAuthFlowCancelled(error)).toBe(true);
    await expect(outcome).resolves.toBe(error);
  });

  it('a completed callback remains successful when cancellation arrives afterward', async () => {
    const handle = await start();
    const pending = handle.waitForCallback();
    const response = await fetch(`${handle.redirectUri}?code=winner&state=expected-state`);
    expect(await response.text()).toContain('Authorization successful');
    const result = await pending;
    handle.cancel();
    await handle.close();
    expect(result).toEqual({ code: 'winner' });
    await expect(pending).resolves.toBe(result);
    await expect(handle.waitForCallback()).rejects.toThrow('already settled');
  });

  it('ignores duplicate waits without replacing the original timeout owner', async () => {
    const handle = await start({ timeoutMs: 20 });
    const original = captureRejection(handle.waitForCallback());
    await expect(handle.waitForCallback()).rejects.toThrow('already in progress');
    await expect(handle.waitForCallback()).rejects.toThrow('already in progress');
    await expect(original).resolves.toMatchObject({ code: 'callback_timeout' });
    await handle.close();
  });

  it('removes the acquisition error listener when listen throws synchronously', async () => {
    const originalClose = HttpServer.prototype.close;
    const errorListenerCounts: number[] = [];
    const closeSpy = vi.spyOn(HttpServer.prototype, 'close').mockImplementation(function (
      this: Server,
      callback?: (error?: Error) => void
    ): Server {
      errorListenerCounts.push(this.listenerCount('error'));
      return originalClose.call(this, callback);
    });
    try {
      await expect(start({ port: -1 })).rejects.toBeInstanceOf(RangeError);
      expect(errorListenerCounts).toEqual([0]);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it('retains acquisition and cleanup failures together when both fail', async () => {
    const cleanupError = new Error('synthetic close failure');
    const originalClose = HttpServer.prototype.close;
    const closeSpy = vi.spyOn(HttpServer.prototype, 'close').mockImplementation(function (
      this: Server,
      callback?: (error?: Error) => void
    ): Server {
      return originalClose.call(this, () => callback?.(cleanupError));
    });
    try {
      const error = await captureRejection(start({ port: -1 }));
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) {
        throw new Error('expected acquisition and cleanup failure');
      }
      expect(error.errors[0]).toBeInstanceOf(RangeError);
      expect(error.errors[1]).toBe(cleanupError);
      expect(error.message).toBe('Provider OAuth loopback acquisition and cleanup failed.');
    } finally {
      closeSpy.mockRestore();
    }
  });

  it('every close caller observes a cleanup failure and automatic cleanup logs no token material', async () => {
    const handle = await start();
    // This fixture deliberately fails close, so its failure is asserted here.
    openHandles.splice(openHandles.indexOf(handle), 1);
    const secret = 'sensitive-callback-code-not-for-logs';
    const cleanupError = new Error(secret);
    const originalClose = HttpServer.prototype.close;
    const records: string[] = [];
    const removeLogListener = addLogListener((record) => records.push(JSON.stringify(record)));
    const closeSpy = vi.spyOn(HttpServer.prototype, 'close').mockImplementation(function (
      this: Server,
      callback?: (error?: Error) => void
    ): Server {
      return originalClose.call(this, () => callback?.(cleanupError));
    });
    const outcome = captureRejection(handle.waitForCallback());
    try {
      const first = captureRejection(handle.close());
      const second = captureRejection(handle.close());
      await expect(first).resolves.toBe(cleanupError);
      await expect(second).resolves.toBe(cleanupError);
      await expect(outcome).resolves.toSatisfy(isProviderAuthFlowCancelled);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeSpy).toHaveBeenCalledTimes(1);
      const cleanupRecords = records.filter((record) =>
        record.includes('Provider OAuth loopback listener cleanup failed')
      );
      expect(cleanupRecords).toHaveLength(1);
      expect(cleanupRecords.join('')).not.toContain(secret);
    } finally {
      removeLogListener();
      closeSpy.mockRestore();
    }
    await expect(fetch(handle.redirectUri)).rejects.toThrow();
  });

  it('joins the close callback even when dropping connections throws and retains both failures', async () => {
    const handle = await start();
    openHandles.splice(openHandles.indexOf(handle), 1);
    const callbackError = new Error('close callback failure');
    const connectionsError = new Error('close connections failure');
    const originalClose = HttpServer.prototype.close;
    let releaseClose: (() => void) | undefined;
    const closeSpy = vi.spyOn(HttpServer.prototype, 'close').mockImplementation(function (
      this: Server,
      callback?: (error?: Error) => void
    ): Server {
      return originalClose.call(this, () => {
        releaseClose = () => callback?.(callbackError);
      });
    });
    const connectionsSpy = vi
      .spyOn(HttpServer.prototype, 'closeAllConnections')
      .mockImplementation(() => {
        throw connectionsError;
      });
    let completed = false;
    const outcome = captureRejection(handle.close()).then((error) => {
      completed = true;
      return error;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(releaseClose).toBeTypeOf('function');
      expect(completed).toBe(false);
      expect(connectionsSpy).toHaveBeenCalledTimes(1);
    } finally {
      releaseClose?.();
      closeSpy.mockRestore();
      connectionsSpy.mockRestore();
    }
    const error = await outcome;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) {
      throw new Error('expected both listener cleanup failures');
    }
    expect(error.errors).toEqual([callbackError, connectionsError]);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('resolves the authorization code and serves the branded success page with hardened headers', async () => {
    const handle = await start();
    const pending = handle.waitForCallback();

    const response = await fetch(`${handle.redirectUri}?code=auth-code-1&state=expected-state`);
    const html = await response.text();

    await expect(pending).resolves.toEqual({ code: 'auth-code-1' });
    expect(response.status).toBe(200);
    expect(html).toContain('Brainstrike');
    expect(html).toContain('Authorization successful');
    // Self-contained page: no external assets.
    expect(html).not.toMatch(/src="http/);
    expect(html).not.toMatch(/href="http/);
    // Security-review finding 6: hardened response headers.
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('tears the server down after the first result', async () => {
    const handle = await start();
    const pending = handle.waitForCallback();
    await fetch(`${handle.redirectUri}?code=auth-code-2&state=expected-state`);
    await pending;

    await expect(fetch(`${handle.redirectUri}?code=late&state=expected-state`)).rejects.toThrow();
  });

  it('discards a bogus-state code, KEEPS WAITING, and still completes on the legitimate callback', async () => {
    // Security-review finding 2: an attacker-injected callback must not be
    // able to terminate the flow — only a state-matching callback settles.
    const handle = await start();
    const pending = handle.waitForCallback();

    const attack = await fetch(`${handle.redirectUri}?code=stolen-code&state=attacker-state`);
    const attackHtml = await attack.text();
    expect(attack.status).toBe(400);
    expect(attackHtml).toContain('Authorization failed');
    // The injected code must never surface anywhere the flow could exchange it.
    expect(attackHtml).not.toContain('stolen-code');

    const legit = await fetch(`${handle.redirectUri}?code=real-code&state=expected-state`);
    expect(legit.status).toBe(200);
    await expect(pending).resolves.toEqual({ code: 'real-code' });
  });

  it('a missing state is 400 and non-terminal', async () => {
    const handle = await start();
    const pending = handle.waitForCallback();

    const response = await fetch(`${handle.redirectUri}?code=some-code`);
    expect(response.status).toBe(400);

    const legit = await fetch(`${handle.redirectUri}?code=real-code&state=expected-state`);
    expect(legit.status).toBe(200);
    await expect(pending).resolves.toEqual({ code: 'real-code' });
  });

  it('rejects provider-reported authorization errors on a state-matching callback', async () => {
    const handle = await start();
    const outcome = captureRejection(handle.waitForCallback());

    const response = await fetch(
      `${handle.redirectUri}?error=access_denied&error_description=nope&state=expected-state`
    );

    await expect(outcome).resolves.toMatchObject({ code: 'flow_failed' });
    expect(response.status).toBe(400);
  });

  it('a provider error WITHOUT a valid state is non-terminal (no injected denial)', async () => {
    const handle = await start();
    const pending = handle.waitForCallback();

    const injected = await fetch(`${handle.redirectUri}?error=access_denied&state=wrong`);
    expect(injected.status).toBe(400);

    const legit = await fetch(`${handle.redirectUri}?code=real-code&state=expected-state`);
    expect(legit.status).toBe(200);
    await expect(pending).resolves.toEqual({ code: 'real-code' });
  });

  it('has NO HTTP /cancel route: 404 and the flow keeps waiting (cancel is IPC-only)', async () => {
    // Security-review finding 1: an unauthenticated HTTP endpoint must not be
    // able to cancel a flow. Cancellation goes through the role-gated IPC
    // channel (engine.cancel -> handle.cancel) exclusively.
    const handle = await start();
    const pending = handle.waitForCallback();

    const response = await fetch(new URL('/cancel', handle.redirectUri));
    expect(response.status).toBe(404);

    const legit = await fetch(`${handle.redirectUri}?code=real-code&state=expected-state`);
    expect(legit.status).toBe(200);
    await expect(pending).resolves.toEqual({ code: 'real-code' });
  });

  it('rejects with a cancellation error on programmatic cancel', async () => {
    const handle = await start();
    const outcome = captureRejection(handle.waitForCallback());

    handle.cancel();

    await expect(outcome).resolves.toSatisfy(isProviderAuthFlowCancelled);
  });

  it('times out the callback wait', async () => {
    const handle = await start({ timeoutMs: 40 });
    const outcome = captureRejection(handle.waitForCallback());

    await expect(outcome).resolves.toMatchObject({ code: 'callback_timeout' });
  });

  it('serves 404 for unknown paths', async () => {
    const handle = await start();
    void handle.waitForCallback().catch(() => {
      // Cancelled by afterEach close; irrelevant to this assertion.
    });

    const response = await fetch(new URL('/definitely-not-a-callback', handle.redirectUri));
    expect(response.status).toBe(404);
  });

  it('rejects a foreign Host header with 400 and leaves the flow waiting (DNS-rebinding guard)', async () => {
    const handle = await start();
    const pending = handle.waitForCallback();

    const spoofed = await rawGet(
      handle.port,
      '/callback?code=rebind-code&state=expected-state',
      'evil.example'
    );
    expect(spoofed.status).toBe(400);

    const legit = await fetch(`${handle.redirectUri}?code=real-code&state=expected-state`);
    expect(legit.status).toBe(200);
    await expect(pending).resolves.toEqual({ code: 'real-code' });
  });

  it('accepts localhost:<port> as a Host alongside 127.0.0.1:<port>', async () => {
    const handle = await start();
    const pending = handle.waitForCallback();

    const viaLocalhost = await rawGet(
      handle.port,
      '/callback?code=local-code&state=expected-state',
      `localhost:${handle.port}`
    );
    expect(viaLocalhost.status).toBe(200);
    await expect(pending).resolves.toEqual({ code: 'local-code' });
  });

  it('throws a typed port-in-use error naming the pinned port', async () => {
    const blocker = createServer();
    openServers.push(blocker);
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => resolve());
    });
    const address = blocker.address();
    if (address === null || typeof address === 'string') {
      throw new Error('blocker server has no bound port');
    }

    const attempt = start({ port: address.port });
    await expect(attempt).rejects.toBeInstanceOf(ProviderAuthFlowError);
    await expect(attempt).rejects.toMatchObject({ code: 'port_in_use' });
    await expect(attempt).rejects.toThrow(String(address.port));
  });
});
