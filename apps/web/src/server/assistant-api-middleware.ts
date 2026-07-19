import type http from 'node:http';
import {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  AssistantInvalidJsonError,
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

export function createAssistantApiMiddleware(mode: 'dev' | 'preview'): AssistantApiMiddleware {
  const bodyLimitBytes = resolveAssistantRequestBodyLimitBytes(
    process.env[ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR]
  );

  return async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    next: () => void
  ): Promise<void> => {
    if (req.method === 'GET' && req.url?.startsWith('/api/assistant/status')) {
      sendAssistantStatusResponse(res);
      return;
    }

    if (req.method !== 'POST') {
      next();
      return;
    }

    const isChatRequest = req.url?.startsWith('/api/chat') === true;
    const isAssistantRequest = req.url?.startsWith('/api/assistant') === true;
    if (!(isChatRequest || isAssistantRequest)) {
      next();
      return;
    }

    try {
      const bodyText = await readBody(req, bodyLimitBytes);
      const payload = parseAssistantRequestPayloadText(bodyText);

      if (isChatRequest) {
        await handleChatEndpoint({ data: payload.data, messages: payload.rawMessages }, res);
        return;
      }

      await handleAssistantEndpoint(req, res, {
        data: payload.data,
        messages: payload.rawMessages,
        runConfig: payload.runConfig,
      });
    } catch (error) {
      if (error instanceof AssistantRequestBodyTooLargeError) {
        res.writeHead(413, JSON_ERROR_HEADERS);
        res.end(JSON.stringify({ error: error.code, message: error.message }));
        return;
      }
      if (error instanceof AssistantInvalidJsonError) {
        res.writeHead(400, JSON_ERROR_HEADERS);
        res.end(JSON.stringify({ error: error.code, message: error.message }));
        return;
      }

      logger.error(`${mode} assistant API handler failed`, { error });
      res.writeHead(500, JSON_ERROR_HEADERS);
      res.end(JSON.stringify({ error: `${mode} chat route failed` }));
    }
  };
}
