/** Desktop provider metadata HTTP surface. Agent execution belongs to the shared host. */
import http from 'node:http';
import { ASSISTANT_AUTH_HEADER_NAME } from '@brainstrike/assistant-contract';
import { respondJson, respondNotFound } from '@brainstrike/assistant-service/http';
import {
  type AssistantServerAuth,
  isAuthorizedAssistantToken,
  mintAssistantServerAuthToken,
} from './assistant-server/auth';
import { closeHttpServerForShutdown } from './assistant-server/close-http-server';
import {
  applyAssistantCorsHeaders,
  hasDisallowedAssistantOrigin,
  isAssistantCorsPreflight,
  respondForbiddenOrigin,
} from './assistant-server/cors';
import { desktopAssistantServerLogger } from './assistant-server/logger';
import { resolveAssistantRoute } from './assistant-server/routing';
import type { AssistantServerOptions } from './assistant-server/server-options';
import {
  handleAssistantStatus,
  handleOpenRouterModelMetadata,
  handleVerifyProviderRequest,
} from './assistant-server/status-endpoints';
import { resolveDesktopPythonExecutable } from './python-runtime';

const logger = desktopAssistantServerLogger;

export { desktopAssistantServerLogger };

/**
 * Best-effort warm-up for the bundled-CPython capability (BST-1061, PR #2205
 * review): unpacking a ~250MB CPython tree is the only slow part of
 * `resolveDesktopPythonExecutable`, and doing it here — once, at server
 * start — means the first real `python3` skill-script call almost always
 * hits the cheap already-unpacked path instead of paying that cost inline
 * (where it used to run before `startedAt` and outside any timeout bound).
 * This is a PERFORMANCE optimization, not a correctness dependency:
 * `run-skill-script-tool.ts` still bounds a cold resolve by the caller's own
 * timeout/Stop regardless of whether this warm-up won the race. Failure is
 * logged, never thrown — an unsupported platform (win/linux) or a missing
 * archive (dev checkout that hasn't run `fetch:python-runtime`) must not
 * block the assistant server from starting.
 */
function warmBundledPythonRuntime(): void {
  const logWarmupFailure = (error: unknown) => {
    logger.warn(
      'Bundled Python runtime warm-up failed; the first python3 skill script will pay for it',
      { error: error instanceof Error ? error.message : String(error) }
    );
  };
  try {
    resolveDesktopPythonExecutable().catch(logWarmupFailure);
  } catch (error) {
    // Defensive: resolveDesktopPythonExecutable's synchronous prelude reads
    // `app.getPath`/`app.getAppPath` before it starts returning a Promise —
    // a `.catch()` alone cannot see a throw that happens before that.
    logWarmupFailure(error);
  }
}

export function startAssistantServer(portHint?: number, options: AssistantServerOptions = {}) {
  warmBundledPythonRuntime();
  const auth: AssistantServerAuth = options.auth ?? { token: mintAssistantServerAuthToken() };
  const authToken = auth === 'disabled' ? undefined : auth.token;
  const requestOptions: AssistantServerOptions = { ...options, auth };
  const server = http.createServer(async (req, res) => {
    await handleAssistantRequest(req, res, requestOptions).catch(() => {
      if (res.headersSent || res.writableEnded) {
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }

      applyAssistantCorsHeaders(req, res);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'assistant server error' }));
    });
  });

  const port = Number(process.env['BS_ASSISTANT_PORT'] ?? portHint ?? 0) || 0;
  const host = options.host ?? '127.0.0.1';
  if (options.listen === false) {
    return Promise.resolve({
      ...(authToken === undefined ? {} : { authToken }),
      stop: async () => {},
      url: `http://${host}:${port}`,
    });
  }
  return new Promise<{ url: string; stop: () => Promise<void>; authToken?: string }>((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://${host}:${actualPort}`;
      resolve({
        ...(authToken === undefined ? {} : { authToken }),
        stop: () => closeHttpServerForShutdown(server),
        url,
      });
    });
  });
}

export async function handleAssistantRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: AssistantServerOptions = {}
): Promise<void> {
  const auth = options.auth;
  if (auth === undefined) {
    // NO SILENT FALLBACKS: an unconfigured gate must fail loudly, never serve.
    throw new Error(
      'Assistant server auth is not configured. Pass options.auth ({ token } or the explicit "disabled" opt-out).'
    );
  }

  if (hasDisallowedAssistantOrigin(req)) {
    respondForbiddenOrigin(res);
    return;
  }

  applyAssistantCorsHeaders(req, res);

  if (isAssistantCorsPreflight(req)) {
    res.writeHead(204);
    res.end();
    return;
  }

  if (
    auth !== 'disabled' &&
    !isAuthorizedAssistantToken(req.headers[ASSISTANT_AUTH_HEADER_NAME], auth.token)
  ) {
    logger.warn('Rejected assistant request without a valid auth token', {
      method: req.method,
      url: req.url,
    });
    respondJson(res, 401, {
      error: 'unauthorized',
      message: 'Missing or invalid assistant auth token.',
    });
    return;
  }

  switch (resolveAssistantRoute(req)) {
    case 'status':
      await handleAssistantStatus(res, options);
      return;
    case 'openrouter-model':
      await handleOpenRouterModelMetadata(req, res, options);
      return;
    case 'verify-provider':
      await handleVerifyProviderRequest(req, res, options);
      return;
    default:
      respondNotFound(res);
  }
}
