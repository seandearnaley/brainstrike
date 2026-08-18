import { createServer, type Server } from 'node:http';
import {
  renderCallbackCancelledPage,
  renderCallbackErrorPage,
  renderCallbackSuccessPage,
} from './callback-pages';
import { ProviderAuthFlowCancelledError, ProviderAuthFlowError } from './errors';

/**
 * On-demand loopback OAuth callback server (BST-1355).
 *
 * - Binds 127.0.0.1 ONLY, on the provider-specified FIXED port. A busy port
 *   is a typed, visible `port_in_use` failure naming the port — NEVER a
 *   random-port fallback, because OAuth client registrations pin the exact
 *   redirect URI. (Test fixtures may pass port 0 and read the bound port.)
 * - Serves GET `<callbackPath>` and GET `/cancel` with branded, fully
 *   self-contained HTML.
 * - A state mismatch rejects as "potential CSRF" and the authorization code
 *   is never released to the caller, so no token exchange can happen.
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
  /** Reject the pending wait as cancelled and tear the server down. */
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

export async function startLoopbackServer(
  options: StartLoopbackServerOptions
): Promise<LoopbackServerHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  const pageOptions = { providerLabel: options.providerLabel } as const;

  let pending: PendingWait | undefined;
  let settled = false;
  let closed = false;
  let timeout: NodeJS.Timeout | undefined;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
    // One-shot server: force connection close so teardown is immediate.
    res.setHeader('Connection', 'close');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed');
      return;
    }

    if (url.pathname === '/cancel') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCallbackCancelledPage(pageOptions));
      settle((wait) => wait.reject(new ProviderAuthFlowCancelledError()));
      return;
    }

    if (url.pathname !== options.callbackPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
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

    const state = url.searchParams.get('state');
    if (state !== options.expectedState) {
      // Potential CSRF: the code in this request is NEVER released to the
      // caller, so no token exchange can occur for it.
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCallbackErrorPage(pageOptions, 'State check failed.'));
      settle((wait) =>
        wait.reject(
          new ProviderAuthFlowError(
            'state_mismatch',
            'Authorization callback state mismatch - potential CSRF; the authorization code was discarded.'
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
  const boundPort = address.port;

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
