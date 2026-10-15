import type http from 'node:http';
import {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  AssistantRequestBodyTooLargeError,
} from '@brainstrike/agent/hosted-web';
import { createLogger } from '@brainstrike/logging';
import {
  handleAssistantEndpoint,
  readBody,
  sendAssistantStatusResponse,
} from '../assistant-stream-helpers';
import { resolveWebAssistantRequestBodyLimitBytes } from './web-assistant-body-limit';
import {
  type LocalAssistantRequestBoundaryError,
  resolveLocalAssistantRequestBoundaryError,
} from './web-assistant-local-boundary';

const logger = createLogger('WebAssistantApiMiddleware');
const JSON_ERROR_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
} as const;

type AssistantApiMiddleware = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: () => void
) => Promise<void>;

type AssistantApiRoute = 'assistant' | 'status';

function resolveAssistantApiRoute(req: http.IncomingMessage): AssistantApiRoute | null {
  if (req.method === 'GET' && req.url?.startsWith('/api/assistant/status')) {
    return 'status';
  }
  if (req.method !== 'POST') {
    return null;
  }
  return req.url?.startsWith('/api/assistant') ? 'assistant' : null;
}

function sendKnownRequestError(res: http.ServerResponse, error: unknown): boolean {
  if (error instanceof AssistantRequestBodyTooLargeError) {
    res.writeHead(413, JSON_ERROR_HEADERS);
    res.end(JSON.stringify({ error: error.code, message: error.message }));
    return true;
  }
  return false;
}

function rejectLocalAssistantRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  error: LocalAssistantRequestBoundaryError
): void {
  req.resume();
  res.writeHead(error.status, JSON_ERROR_HEADERS);
  res.end(JSON.stringify({ error: error.error, message: error.message }));
}

export function createAssistantApiMiddleware(mode: 'dev' | 'preview'): AssistantApiMiddleware {
  const bodyLimitBytes = resolveWebAssistantRequestBodyLimitBytes(
    process.env[ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR]
  );

  return async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    next: () => void
  ): Promise<void> => {
    const route = resolveAssistantApiRoute(req);
    if (!route) {
      next();
      return;
    }

    const boundaryError = resolveLocalAssistantRequestBoundaryError(req);
    if (boundaryError) {
      logger.warn(`${mode} assistant API request rejected by local trust boundary`, {
        error: boundaryError.error,
        route,
      });
      rejectLocalAssistantRequest(req, res, boundaryError);
      return;
    }

    if (route === 'status') {
      sendAssistantStatusResponse(res);
      return;
    }

    try {
      const bodyText = await readBody(req, bodyLimitBytes);
      await handleAssistantEndpoint(req, res, bodyText);
    } catch (error) {
      if (res.headersSent) {
        logger.error(`${mode} assistant API stream failed after response headers were sent`, {
          error,
        });
        res.destroy(
          error instanceof Error
            ? error
            : new Error(`${mode} assistant API stream failed with a non-Error value.`)
        );
        return;
      }
      if (sendKnownRequestError(res, error)) {
        return;
      }

      logger.error(`${mode} assistant API handler failed`, { error });
      res.writeHead(500, JSON_ERROR_HEADERS);
      res.end(JSON.stringify({ error: `${mode} assistant route failed` }));
    }
  };
}
