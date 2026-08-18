import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
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
