import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  reportLoopbackListenerFault,
  reportUnavailableLoopbackPort,
} from './oauth-client-registration';

export const DEFAULT_CALLBACK_PATH = '/mcp/oauth/callback';
const MAX_CALLBACK_URL_BYTES = 16 * 1024;
const AUTHORIZATION_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const LOOPBACK_HOST = '127.0.0.1';

export interface LoopbackCallback {
  arm(expectedState: string): Promise<void>;
  cancel(): void;
  readonly close: () => Promise<void>;
  /** Bound TCP port, persisted so the next launch can reuse the same redirect URI. */
  readonly port: number;
  readonly redirectUrl: string;
  wait(): Promise<URLSearchParams>;
}

interface PendingCallback {
  readonly reject: (error: Error) => void;
  readonly resolve: (params: URLSearchParams) => void;
}

function applyCallbackHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-security-policy', "default-src 'none'");
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
}

async function listenOnLoopback(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error): void => reject(cause);
    server.once('error', onError);
    server.listen(port, LOOPBACK_HOST, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

/**
 * Rebinds the persisted port so the dynamic-registration redirect URI survives a
 * relaunch. A port another process now owns forces a fresh one, which
 * invalidates the registration — reported, never absorbed.
 */
async function bindLoopback(server: Server, preferredPort: number | undefined): Promise<void> {
  if (preferredPort !== undefined) {
    try {
      await listenOnLoopback(server, preferredPort);
      return;
    } catch (cause) {
      reportUnavailableLoopbackPort(preferredPort, cause);
    }
  }
  await listenOnLoopback(server, 0);
}

export async function startLoopbackCallback(
  pathname: string,
  preferredPort: number | undefined
): Promise<LoopbackCallback> {
  let port = 0;
  let expectedState: string | undefined;
  let pending: PendingCallback | undefined;
  let pendingTimeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let closed = false;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    applyCallbackHeaders(response);
    const host = request.headers.host;
    if (host !== `${LOOPBACK_HOST}:${port}` && host !== `localhost:${port}`) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Invalid Host');
      return;
    }
    const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
    if (request.method !== 'GET' || url.pathname !== pathname) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    if (Buffer.byteLength(url.href, 'utf8') > MAX_CALLBACK_URL_BYTES) {
      response
        .writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        .end('Invalid callback');
      return;
    }
    if (expectedState === undefined || url.searchParams.get('state') !== expectedState) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Invalid state');
      return;
    }
    response.writeHead(url.searchParams.has('code') ? 200 : 400, {
      'content-type': 'text/plain; charset=utf-8',
    });
    response.end(url.searchParams.has('code') ? 'Authorization received' : 'Authorization failed');
    if (settled) {
      return;
    }
    settled = true;
    const current = pending;
    pending = undefined;
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      pendingTimeout = undefined;
    }
    current?.resolve(new URLSearchParams(url.searchParams));
  });

  const teardown = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };
  await bindLoopback(server, preferredPort);
  // `bindLoopback` must not leave its bind-time rejector attached — it would
  // survive as a stale rejector across the retry — which leaves the bound server
  // with zero `'error'` listeners. Node throws an unhandled `'error'` event, so
  // a later accept-path fault would crash Electron main instead of failing this
  // OAuth callback. Reported, never silently absorbed and never rethrown.
  server.on('error', (cause: Error) => reportLoopbackListenerFault(port, cause));
  const address = server.address();
  if (!address || typeof address === 'string') {
    await teardown();
    throw new Error('MCP OAuth loopback server did not expose a bound port.');
  }
  port = address.port;

  return {
    arm: async (state) => {
      if (expectedState !== undefined && !settled) {
        throw new Error('MCP OAuth loopback callback is already armed.');
      }
      expectedState = state;
      settled = false;
    },
    cancel: () => {
      if (settled) {
        return;
      }
      settled = true;
      const current = pending;
      pending = undefined;
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingTimeout = undefined;
      }
      current?.reject(new Error('MCP OAuth authorization was cancelled.'));
    },
    close: teardown,
    port,
    redirectUrl: `http://${LOOPBACK_HOST}:${port}${pathname}`,
    wait: () =>
      new Promise<URLSearchParams>((resolve, reject) => {
        if (settled) {
          reject(new Error('MCP OAuth callback wait is not active.'));
          return;
        }
        pending = { reject, resolve };
        pendingTimeout = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          pending = undefined;
          pendingTimeout = undefined;
          reject(new Error('MCP OAuth authorization callback timed out.'));
          void teardown();
        }, AUTHORIZATION_CALLBACK_TIMEOUT_MS);
      }),
  };
}
