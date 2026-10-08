import { createServer, type Server, type ServerResponse } from 'node:http';
import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { createLogger } from '@brainstrike/logging';
import { Deferred, Effect, Exit, Scope } from 'effect';
import { renderCallbackErrorPage, renderCallbackSuccessPage } from './callback-pages.js';
import { ProviderAuthFlowCancelledError, ProviderAuthFlowError } from './errors.js';

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

const logger = createLogger('ProviderAuthLoopback');

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

function isServerNotRunning(error: Error): boolean {
  return isErrnoException(error) && error.code === 'ERR_SERVER_NOT_RUNNING';
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

  const scope = Scope.makeUnsafe();
  const callback = Deferred.makeUnsafe<LoopbackCallbackResult, Error>();
  let waitStarted = false;
  let settled = false;
  let closePromise: Promise<void> | undefined;
  let callbackWait: Promise<LoopbackCallbackResult> | undefined;
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
      settle(
        Effect.fail(
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
      settle(
        Effect.fail(
          new ProviderAuthFlowError('flow_failed', 'Authorization callback carried no code.')
        )
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderCallbackSuccessPage(pageOptions));
    settle(Effect.succeed({ code }));
  });

  // Keep a join handle: a scope is marked closed before asynchronous finalizers
  // finish, so calling Scope.close again alone is not a completion barrier.
  function teardown(): Promise<void> {
    closePromise ??= (async () => {
      // The wait's scoped timer finalizer is part of closing the handle too.
      const waitCleanup = callbackWait?.then(
        () => undefined,
        () => undefined
      );
      try {
        await runAtPromiseBoundary(Scope.close(scope, Exit.void));
      } finally {
        await waitCleanup;
      }
    })();
    return closePromise;
  }

  function settle(result: Effect.Effect<LoopbackCallbackResult, Error>): void {
    if (settled) {
      return;
    }
    settled = true;
    void runAtPromiseBoundary(Deferred.complete(callback, result));
    // Keep the existing response-flush ordering before closing owned sockets.
    setImmediate(() => {
      void teardown().catch(() => {
        logger.error('Provider OAuth loopback listener cleanup failed');
      });
    });
  }

  await runAtPromiseBoundary(
    Scope.addFinalizer(
      scope,
      Effect.promise(async () => {
        const closing = new Promise<void>((resolve, reject) => {
          server.close((error?: Error) => {
            if (error && !isServerNotRunning(error)) {
              reject(error);
              return;
            }
            resolve();
          });
        });
        const connections = Promise.resolve().then(() => server.closeAllConnections());
        const results = await Promise.allSettled([closing, connections]);
        const failures = results.flatMap((result): unknown[] =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, 'Provider OAuth loopback listener cleanup failed.');
        }
      })
    )
  );

  try {
    await runAtPromiseBoundary(
      Effect.callback<void, Error>((resume) => {
        const onListenError = (error: Error): void => {
          server.removeListener('error', onListenError);
          if (isErrnoException(error) && error.code === 'EADDRINUSE') {
            resume(
              Effect.fail(
                new ProviderAuthFlowError(
                  'port_in_use',
                  `OAuth loopback port ${options.port} on ${LOOPBACK_HOST} is already in use. ` +
                    'The provider registration pins this exact port, so Brainstrike cannot use another one - ' +
                    'close the application occupying it and retry.',
                  error
                )
              )
            );
            return;
          }
          resume(Effect.fail(error));
        };
        server.once('error', onListenError);
        try {
          server.listen(options.port, LOOPBACK_HOST, () => {
            server.removeListener('error', onListenError);
            resume(Effect.void);
          });
        } catch (error) {
          server.removeListener('error', onListenError);
          throw error;
        }
        return Effect.sync(() => server.removeListener('error', onListenError));
      })
    );
  } catch (error) {
    try {
      await teardown();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Provider OAuth loopback acquisition and cleanup failed.'
      );
    }
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await teardown();
    throw new ProviderAuthFlowError('flow_failed', 'Loopback server reported no bound port.');
  }
  boundPort = address.port;

  return {
    cancel: () => {
      settle(Effect.fail(new ProviderAuthFlowCancelledError()));
    },
    close: async () => {
      settle(Effect.fail(new ProviderAuthFlowCancelledError()));
      await teardown();
    },
    port: boundPort,
    redirectUri: `http://${LOOPBACK_HOST}:${boundPort}${options.callbackPath}`,
    waitForCallback: () => {
      if (settled) {
        return Promise.reject(
          new ProviderAuthFlowError('flow_failed', 'Loopback callback wait already settled.')
        );
      }
      if (waitStarted) {
        return Promise.reject(
          new ProviderAuthFlowError('flow_failed', 'Loopback callback wait already in progress.')
        );
      }
      waitStarted = true;
      callbackWait = runAtPromiseBoundary(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              setTimeout(() => {
                settle(
                  Effect.fail(
                    new ProviderAuthFlowError(
                      'callback_timeout',
                      `OAuth callback was not received within ${timeoutMs}ms.`
                    )
                  )
                );
              }, timeoutMs)
            ),
            (timer) => Effect.sync(() => clearTimeout(timer))
          );
          return yield* Deferred.await(callback);
        }).pipe(Effect.scoped)
      );
      return callbackWait;
    },
  };
}
