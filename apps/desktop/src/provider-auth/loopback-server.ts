import { createServer, type Server, type ServerResponse } from 'node:http';
import { renderCallbackErrorPage, renderCallbackSuccessPage } from './callback-pages';
import { ProviderAuthFlowCancelledError, ProviderAuthFlowError } from './errors';

/**
 * On-demand loopback OAuth callback server (BST-1355, hardened per the
 * security review of PR #2520).
 *
 * - Binds 127.0.0.1 ONLY, on the provider-specified FIXED port. A busy port
 *   is a typed, visible `port_in_use` failure naming the port — NEVER a
 *   random-port fallback, because OAuth client registrations pin the exact
 *   redirect URI. (Test fixtures may pass port 0 and read the bound port.)
 * - Serves GET `<callbackPath>` with branded, fully self-contained HTML and
 *   hardened headers (CSP `default-src 'none'`, nosniff, no-referrer).
 * - Host allow-list: requests must target `127.0.0.1:<port>` or
 *   `localhost:<port>` — anything else (DNS rebinding) is 400.
 * - A callback whose `state` does not match is answered 400, its code is
 *   DISCARDED, and the flow KEEPS WAITING for the legitimate callback: an
 *   attacker who can reach the loopback port must not be able to terminate
 *   (or complete) someone else's flow. Only a state-matching callback — or
 *   the timeout / the IPC-driven programmatic cancel — settles the wait.
 * - There is deliberately NO HTTP /cancel route: cancellation flows solely
 *   through the role-gated provider-auth IPC channel (engine.cancel ->
 *   handle.cancel). An unauthenticated HTTP endpoint must not cancel flows.
 * - Torn down on the first result, timeout, or cancel (default 5 minutes).
 */

const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface StartLoopbackServerOptions {
  readonly callbackPath: string;
  readonly expectedState: string;
  /** Fixed provider-registered port; 0 is reserved for test fixtures. */
  readonly port: number;
  /** Friendly provider name for the branded pages. */
  readonly providerLabel: string;
  readonly timeoutMs?: number;
}

export interface LoopbackCallbackResult {
  readonly code: string;
}

export interface LoopbackServerHandle {
  /** Reject the pending wait as cancelled and tear the server down. Reached
   * ONLY via the role-gated IPC cancel — there is no HTTP cancel route. */
  readonly cancel: () => void;
  /** Tear down unconditionally (idempotent). */
  readonly close: () => Promise<void>;
  /** Actual bound port (== options.port for real descriptors). */
  readonly port: number;
  /** `http://127.0.0.1:<port><callbackPath>` — the redirect_uri to register. */
  readonly redirectUri: string;
  /** Resolves with the authorization code, or rejects with a typed error
   * (`ProviderAuthFlowError` / `ProviderAuthFlowCancelledError`). */
  readonly waitForCallback: () => Promise<LoopbackCallbackResult>;
}

const LOOPBACK_HOST = '127.0.0.1';

interface PendingWait {
  readonly reject: (error: Error) => void;
  readonly resolve: (result: LoopbackCallbackResult) => void;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** Hardened headers on EVERY response (security-review finding 6). */
function applyBaselineHeaders(res: ServerResponse): void {
  res.setHeader('Connection', 'close');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

export async function startLoopbackServer(
  options: StartLoopbackServerOptions
): Promise<LoopbackServerHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  const pageOptions = { providerLabel: options.providerLabel } as const;

  let pending: PendingWait | undefined;
  let settled = false;
  let closed = false;
  let timeout: NodeJS.Timeout | undefined;
  let boundPort = options.port;

  function isAllowedHost(hostHeader: string | undefined): boolean {
    return (
      hostHeader === `${LOOPBACK_HOST}:${boundPort}` || hostHeader === `localhost:${boundPort}`
    );
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
    applyBaselineHeaders(res);

    if (!isAllowedHost(req.headers.host)) {
      // DNS rebinding: a page on an attacker origin resolving to 127.0.0.1
      // carries the attacker's Host. Refuse without settling the flow.
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Invalid Host');
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed');
      return;
    }

    if (url.pathname !== options.callbackPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const state = url.searchParams.get('state');
    if (state !== options.expectedState) {
      // Potential CSRF / injected callback. NON-TERMINAL by design
      // (security-review finding 2): discard whatever this request carried
      // (code or error), answer 400, and keep waiting for the legitimate
      // state-matching callback until the timeout.
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCallbackErrorPage(pageOptions, 'State check failed.'));
      return;
    }

    const errorParam = url.searchParams.get('error');
    if (errorParam !== null) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCallbackErrorPage(pageOptions, 'The provider reported an error.'));
      settle((wait) =>
        wait.reject(
          new ProviderAuthFlowError(
            'flow_failed',
            `Authorization callback returned error "${errorParam}".`
          )
        )
      );
      return;
    }

    const code = url.searchParams.get('code');
    if (code === null || code.length === 0) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCallbackErrorPage(pageOptions, 'The callback carried no authorization code.'));
      settle((wait) =>
        wait.reject(
          new ProviderAuthFlowError('flow_failed', 'Authorization callback carried no code.')
        )
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderCallbackSuccessPage(pageOptions));
    settle((wait) => wait.resolve({ code }));
  });

  function teardown(): Promise<void> {
    if (closed) {
      return Promise.resolve();
    }
    closed = true;
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Drop keep-alive sockets so close() completes promptly.
      server.closeAllConnections();
    });
  }

  function settle(complete: (wait: PendingWait) => void): void {
    if (settled) {
      return;
    }
    settled = true;
    const wait = pending;
    pending = undefined;
    if (wait) {
      complete(wait);
    }
    // Teardown AFTER the response above has been queued; close() lets the
    // in-flight response finish (closeAllConnections only severs sockets once
    // res.end has flushed on the same tick ordering used here).
    setImmediate(() => {
      void teardown();
    });
  }

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error) => {
      if (isErrnoException(error) && error.code === 'EADDRINUSE') {
        reject(
          new ProviderAuthFlowError(
            'port_in_use',
            `OAuth loopback port ${options.port} on ${LOOPBACK_HOST} is already in use. ` +
              'The provider registration pins this exact port, so Brainstrike cannot use another one - ' +
              'close the application occupying it and retry.',
            error
          )
        );
        return;
      }
      reject(error);
    };
    server.once('error', onListenError);
    server.listen(options.port, LOOPBACK_HOST, () => {
      server.removeListener('error', onListenError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await teardown();
    throw new ProviderAuthFlowError('flow_failed', 'Loopback server reported no bound port.');
  }
  boundPort = address.port;

  return {
    cancel: () => {
      settle((wait) => wait.reject(new ProviderAuthFlowCancelledError()));
    },
    close: async () => {
      settle((wait) => wait.reject(new ProviderAuthFlowCancelledError()));
      await teardown();
    },
    port: boundPort,
    redirectUri: `http://${LOOPBACK_HOST}:${boundPort}${options.callbackPath}`,
    waitForCallback: () =>
      new Promise<LoopbackCallbackResult>((resolve, reject) => {
        if (settled) {
          reject(
            new ProviderAuthFlowError('flow_failed', 'Loopback callback wait already settled.')
          );
          return;
        }
        pending = { reject, resolve };
        timeout = setTimeout(() => {
          settle((wait) =>
            wait.reject(
              new ProviderAuthFlowError(
                'callback_timeout',
                `OAuth callback was not received within ${timeoutMs}ms.`
              )
            )
          );
        }, timeoutMs);
      }),
  };
}
