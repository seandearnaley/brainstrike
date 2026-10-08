import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { Data, Effect, Exit, Scope } from 'effect';
import {
  reportLoopbackListenerFault,
  reportUnavailableLoopbackPort,
} from './oauth-client-registration.js';

export const DEFAULT_CALLBACK_PATH = '/mcp/oauth/callback';
const MAX_CALLBACK_URL_BYTES = 16 * 1024;
const AUTHORIZATION_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const LOOPBACK_HOST = '127.0.0.1';
const CANCELLED_MESSAGE = 'MCP OAuth authorization was cancelled.';
const TIMEOUT_MESSAGE = 'MCP OAuth authorization callback timed out.';

/** The callback window elapsed; a failed server close stays its cause. */
class McpOAuthCallbackTimeoutError extends Data.TaggedError('McpOAuthCallbackTimeoutError')<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

export interface LoopbackCallback {
  arm(expectedState: string): Promise<void>;
  cancel(): void;
  readonly close: () => Promise<void>;
  /** Bound TCP port, persisted so the next launch can reuse the same redirect URI. */
  readonly port: number;
  readonly redirectUrl: string;
  wait(): Promise<URLSearchParams>;
}

type AttemptOutcome =
  | { readonly kind: 'success'; readonly params: URLSearchParams }
  | { readonly kind: 'failure'; readonly error: Error }
  | { readonly kind: 'closing-timeout' };

interface Attempt {
  claimed: boolean;
  expectedState?: string;
  outcome?: AttemptOutcome;
  resume?: ((effect: Effect.Effect<URLSearchParams, Error>) => void) | undefined;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

function applyCallbackHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-security-policy', "default-src 'none'");
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
}

async function listenOnLoopback(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const removeErrorListener = (): void => {
      server.removeListener('error', onError);
    };
    const onError = (cause: Error): void => {
      removeErrorListener();
      reject(cause);
    };
    server.once('error', onError);
    try {
      server.listen(port, LOOPBACK_HOST, () => {
        removeErrorListener();
        resolve();
      });
    } catch (cause) {
      removeErrorListener();
      reject(cause);
    }
  });
}

/** Rebind the persisted port; a busy port is reported before retrying fresh. */
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
  let closed = false;
  let bound = false;
  let attempt: Attempt = { claimed: false };
  let closeServerPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let reportBoundError: ((cause: Error) => void) | undefined;
  const activeWaits = new Set<Promise<URLSearchParams>>();
  const scope = Scope.makeUnsafe();

  const deliver = (current: Attempt): void => {
    const outcome = current.outcome;
    if (!outcome || outcome.kind === 'closing-timeout' || !current.resume) {
      return;
    }
    current.resume(
      outcome.kind === 'success' ? Effect.succeed(outcome.params) : Effect.fail(outcome.error)
    );
  };
  const settle = (current: Attempt, outcome: AttemptOutcome): void => {
    if (current.outcome) {
      return;
    }
    current.outcome = outcome;
    deliver(current);
  };
  const releaseServer = async (server: Server): Promise<void> => {
    let closeCallbackCompleted = false;
    try {
      if (!bound) {
        return;
      }
      const closing = new Promise<void>((resolve, reject) => {
        try {
          server.close((error?: Error) => {
            closeCallbackCompleted = true;
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        } catch (error) {
          reject(error);
        }
      });
      const connections = Promise.resolve().then((): void => server.closeAllConnections());
      const results = await Promise.allSettled([closing, connections]);
      const failures = results.flatMap((result): unknown[] =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, 'MCP OAuth listener cleanup failed');
      }
    } finally {
      if (closeCallbackCompleted && reportBoundError) {
        server.removeListener('error', reportBoundError);
      }
    }
  };
  const closeServer = (): Promise<void> => {
    closeServerPromise ??= runAtPromiseBoundary(Scope.close(scope, Exit.void));
    return closeServerPromise;
  };

  const serverHandler = (request: IncomingMessage, response: ServerResponse): void => {
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
    if (
      closed ||
      attempt.expectedState === undefined ||
      url.searchParams.get('state') !== attempt.expectedState
    ) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Invalid state');
      return;
    }
    response.writeHead(url.searchParams.has('code') ? 200 : 400, {
      'content-type': 'text/plain; charset=utf-8',
    });
    response.end(url.searchParams.has('code') ? 'Authorization received' : 'Authorization failed');
    settle(attempt, { kind: 'success', params: new URLSearchParams(url.searchParams) });
  };

  let server: Server;
  try {
    server = await runAtPromiseBoundary(
      Effect.provideService(
        Effect.acquireRelease(
          Effect.sync(() => createServer(serverHandler)),
          (owned: Server) => Effect.promise(() => releaseServer(owned))
        ),
        Scope.Scope,
        scope
      )
    );
    await bindLoopback(server, preferredPort);
    bound = true;
    reportBoundError = (cause: Error): void => reportLoopbackListenerFault(port, cause);
    server.on('error', reportBoundError);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('MCP OAuth loopback server did not expose a bound port.');
    }
    port = address.port;
  } catch (error) {
    try {
      await closeServer();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'MCP OAuth loopback startup and cleanup failed'
      );
    }
    throw error;
  }

  return {
    arm: async (state: string): Promise<void> => {
      if (closed) {
        throw new Error('MCP OAuth loopback callback is closed.');
      }
      if (attempt.expectedState !== undefined && !attempt.outcome) {
        throw new Error('MCP OAuth loopback callback is already armed.');
      }
      if (attempt.outcome) {
        attempt = { claimed: false, expectedState: state };
      } else {
        attempt.expectedState = state;
      }
    },
    cancel: (): void => settle(attempt, { error: new Error(CANCELLED_MESSAGE), kind: 'failure' }),
    close: (): Promise<void> => {
      if (closePromise) {
        return closePromise;
      }
      closed = true;
      settle(attempt, { error: new Error(CANCELLED_MESSAGE), kind: 'failure' });
      const serverClose = closeServer();
      const waits = [...activeWaits];
      closePromise = Promise.allSettled([serverClose, ...waits]).then((results): void => {
        const result = results[0];
        if (result?.status === 'rejected') {
          throw result.reason;
        }
      });
      return closePromise;
    },
    port,
    redirectUrl: `http://${LOOPBACK_HOST}:${port}${pathname}`,
    wait: (): Promise<URLSearchParams> => {
      if (closed || attempt.outcome) {
        return Promise.reject(new Error('MCP OAuth callback wait is not active.'));
      }
      if (attempt.claimed) {
        return Promise.reject(new Error('MCP OAuth callback wait is already active.'));
      }
      const current = attempt;
      current.claimed = true;
      const waitEffect = Effect.ensuring(
        Effect.callback<URLSearchParams, Error>((resume) => {
          current.resume = resume;
          if (current.outcome) {
            deliver(current);
            return;
          }
          current.timer = setTimeout(() => {
            if (current.outcome) {
              return;
            }
            closed = true;
            current.outcome = { kind: 'closing-timeout' };
            void closeServer().then(
              (): void => {
                current.outcome = {
                  error: new McpOAuthCallbackTimeoutError({ message: TIMEOUT_MESSAGE }),
                  kind: 'failure',
                };
                deliver(current);
              },
              (cause: unknown): void => {
                current.outcome = {
                  error: new McpOAuthCallbackTimeoutError({ cause, message: TIMEOUT_MESSAGE }),
                  kind: 'failure',
                };
                deliver(current);
              }
            );
          }, AUTHORIZATION_CALLBACK_TIMEOUT_MS);
        }),
        Effect.sync((): void => {
          if (current.timer) {
            clearTimeout(current.timer);
            current.timer = undefined;
          }
          current.resume = undefined;
        })
      );
      const waiting = runAtPromiseBoundary(waitEffect);
      activeWaits.add(waiting);
      void waiting.then(
        (): void => {
          activeWaits.delete(waiting);
        },
        (): void => {
          activeWaits.delete(waiting);
        }
      );
      return waiting;
    },
  };
}
