import type http from 'node:http';
import {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  AssistantInvalidJsonError,
  AssistantMessageValidationError,
  AssistantRequestBodyTooLargeError,
  parseAssistantRequestPayloadText,
  resolveAssistantRequestBodyLimitBytes,
} from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import {
  handleAssistantEndpoint,
  handleChatEndpoint,
  readBody,
  sendAssistantStatusResponse,
} from '../assistant-stream-helpers';

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

type AssistantApiRoute = 'assistant' | 'chat' | 'status';

function resolveAssistantApiRoute(req: http.IncomingMessage): AssistantApiRoute | null {
  if (req.method === 'GET' && req.url?.startsWith('/api/assistant/status')) {
    return 'status';
  }
  if (req.method !== 'POST') {
    return null;
  }
  if (req.url?.startsWith('/api/chat')) {
    return 'chat';
  }
  return req.url?.startsWith('/api/assistant') ? 'assistant' : null;
}

function sendKnownRequestError(res: http.ServerResponse, error: unknown): boolean {
  if (error instanceof AssistantRequestBodyTooLargeError) {
    res.writeHead(413, JSON_ERROR_HEADERS);
    res.end(JSON.stringify({ error: error.code, message: error.message }));
    return true;
  }
  if (
    error instanceof AssistantInvalidJsonError ||
    error instanceof AssistantMessageValidationError
  ) {
    res.writeHead(400, JSON_ERROR_HEADERS);
    res.end(JSON.stringify({ error: error.code, message: error.message }));
    return true;
  }
  return false;
}

export function createAssistantApiMiddleware(mode: 'dev' | 'preview'): AssistantApiMiddleware {
  const bodyLimitBytes = resolveAssistantRequestBodyLimitBytes(
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
    if (route === 'status') {
      sendAssistantStatusResponse(res);
      return;
    }

    try {
      const bodyText = await readBody(req, bodyLimitBytes);
      const payload = parseAssistantRequestPayloadText(bodyText);

      if (route === 'chat') {
        await handleChatEndpoint({ data: payload.data, messages: payload.rawMessages }, res);
        return;
      }

      await handleAssistantEndpoint(req, res, {
        data: payload.data,
        messages: payload.rawMessages,
        runConfig: payload.runConfig,
      });
    } catch (error) {
      if (sendKnownRequestError(res, error)) {
        return;
      }

      logger.error(`${mode} assistant API handler failed`, { error });
      res.writeHead(500, JSON_ERROR_HEADERS);
      res.end(JSON.stringify({ error: `${mode} chat route failed` }));
    }
  };
}
