import {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  createStatelessAssistantDataStreamResponse,
  readRequestBodyText,
} from '@brainstrike/agent/hosted-web';
import { createAssistantRejectionResponse } from '@brainstrike/assistant-service/http';
import { resolveWebAssistantRequestBodyLimitBytes } from '../../../server/web-assistant-body-limit.js';
import { runWebAssistantPost } from '../../../server/web-assistant-post.js';
import {
  describeWebAssistantInputError,
  WEB_ASSISTANT_STREAM_REPLAY_UNAVAILABLE,
} from '../../../server/web-assistant-request.js';

// Initialize logging lazily inside the request so initialization errors are
// observed by the caller rather than left as module-initialization rejections.
async function createWebAssistantLogger() {
  const { createLogger } = await import('@brainstrike/logging');
  return createLogger('WebAssistantRoute');
}

let loggerPromise: ReturnType<typeof createWebAssistantLogger> | undefined;
const getLogger = (): ReturnType<typeof createWebAssistantLogger> =>
  (loggerPromise ??= createWebAssistantLogger());
const assistantRequestBodyLimitBytes = resolveWebAssistantRequestBodyLimitBytes(
  process.env[ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR]
);

/**
 * Hosted Web assistant route: the WHATWG transport shell over the converged
 * decision core in `web-assistant-post.ts` (BST-973-2). This file owns only
 * what touches the raw Request:
 *   - the bounded body read (web's clamped limit -> 413);
 *   - `last-event-id` -> 409 — ARCHITECTURAL: stateless streams cannot replay
 *     across Vercel instances;
 * everything else — 503 gate, allow-list pre-filter, the SHARED
 * prepareAssistantPostRequest, tool-continuation 409s, stream construction —
 * is the core, shared byte-for-byte with the dev/preview middleware.
 */
export async function POST(req: Request): Promise<Response> {
  let bodyText: string;
  try {
    bodyText = await readRequestBodyText(req, assistantRequestBodyLimitBytes);
  } catch (error) {
    const inputError = describeWebAssistantInputError(error);
    if (!inputError) {
      throw error;
    }
    return createAssistantRejectionResponse(inputError);
  }

  const lastEventId = req.headers.get('last-event-id');
  if (lastEventId) {
    return createAssistantRejectionResponse({
      payload: WEB_ASSISTANT_STREAM_REPLAY_UNAVAILABLE,
      status: 409,
    });
  }

  const logger = await getLogger();
  const outcome = await runWebAssistantPost({ bodyText, logger, signal: req.signal });
  if (outcome.kind === 'rejection') {
    return createAssistantRejectionResponse({
      payload: outcome.payload,
      status: outcome.status,
    });
  }
  return createStatelessAssistantDataStreamResponse(outcome.stream);
}
