import {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR as BODY_LIMIT_ENV_VAR,
  isMastraAgentError,
  readRequestBodyText,
  resolveAssistantRequestBodyLimitBytes as resolveBodyLimit,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import type { AssistantProviderConfig } from '../../../server/assistant-config';
import { resolveAssistantProviderConfig } from '../../../server/assistant-config';
import {
  describeWebAssistantInputError,
  resolveWebAssistantChatTurn,
  type WebAssistantInputError,
} from '../../../server/web-assistant-request';
import {
  InvalidWebAssistantRuntimeDataError,
  resolveWebAssistantRuntime,
} from '../../../server/web-assistant-runtime';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const RATE_LIMIT_MAX_CLIENTS = 1024;
const logger = createLogger('WebChatRoute');
const JSON_ERROR_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
} as const;
const chatRequestBodyLimitBytes = resolveBodyLimit(process.env[BODY_LIMIT_ENV_VAR]);
let lastRateLimitSaturationWarnAt = 0;

interface RateLimitEntry {
  blockedUntil?: number;
  count: number;
  windowStartedAt: number;
}

const rateLimitState = new Map<string, RateLimitEntry>();

export async function POST(req: Request): Promise<Response> {
  try {
    const clientIdentifier = resolveClientIdentifier(req);
    const limitResult = applyRateLimit(clientIdentifier);
    if (!limitResult.allowed) {
      return createRateLimitResponse(limitResult.retryAfterMs);
    }

    const bodyText = await readRequestBodyText(req, chatRequestBodyLimitBytes);
    const { agentMessages, payload } = resolveWebAssistantChatTurn(bodyText);

    const provider = resolveAssistantProviderConfig();
    if (!providerHasApiKey(provider)) {
      return new Response(
        JSON.stringify({
          error: 'assistant_disabled',
          reason: provider.disabledReason ?? 'missing_api_key',
        }),
        {
          headers: JSON_ERROR_HEADERS,
          status: 503,
        }
      );
    }

    const stream = await toAiSdkStyleStream(
      agentMessages,
      resolveWebAssistantRuntime(payload.data, provider.apiKey)
    );

    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            // naive SSE-ish framing the AI SDK can consume via Response streaming
            controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(readable, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      },
      status: 200,
    });
  } catch (err) {
    return createErrorResponse(err);
  }
}

function providerHasApiKey(
  provider: AssistantProviderConfig
): provider is AssistantProviderConfig & { apiKey: string } {
  return Boolean(provider.enabled && provider.apiKey);
}

function resolveClientIdentifier(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) {
      return first;
    }
  }
  const realIp = req.headers.get('x-real-ip');
  if (realIp && realIp.trim().length > 0) {
    return realIp.trim();
  }
  const cfConnectingIp = req.headers.get('cf-connecting-ip');
  if (cfConnectingIp && cfConnectingIp.trim().length > 0) {
    return cfConnectingIp.trim();
  }
  const userHash = req.headers.get('brainstrike-client-id');
  if (userHash && userHash.trim().length > 0) {
    return userHash.trim();
  }
  return 'anonymous';
}

function applyRateLimit(
  identifier: string,
  now: number = Date.now()
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const existing = rateLimitState.get(identifier);

  if (existing?.blockedUntil !== undefined && now < existing.blockedUntil) {
    return { allowed: false, retryAfterMs: existing.blockedUntil - now };
  }

  if (!existing) {
    if (rateLimitState.size >= RATE_LIMIT_MAX_CLIENTS) {
      pruneRateLimitState(now);
    }
    if (rateLimitState.size >= RATE_LIMIT_MAX_CLIENTS && !evictOldestUnblockedRateLimitEntry(now)) {
      // All tracked clients are actively blocked. Rejecting new identifiers preserves the memory
      // bound, but can deny new clients until a block expires, so keep this path observable.
      logRateLimitSaturation(now);
      return { allowed: false, retryAfterMs: RATE_LIMIT_WINDOW_MS };
    }
    rateLimitState.set(identifier, {
      count: 1,
      windowStartedAt: now,
    });
    return { allowed: true };
  }

  const elapsed = now - existing.windowStartedAt;
  if (elapsed >= RATE_LIMIT_WINDOW_MS) {
    rateLimitState.set(identifier, {
      count: 1,
      windowStartedAt: now,
    });
    return { allowed: true };
  }

  if (existing.count < RATE_LIMIT_MAX_REQUESTS) {
    existing.count += 1;
    rateLimitState.set(identifier, existing);
    return { allowed: true };
  }

  const blockedUntil = existing.windowStartedAt + RATE_LIMIT_WINDOW_MS;
  existing.blockedUntil = blockedUntil;
  rateLimitState.set(identifier, existing);
  const retryAfterMs = Math.max(0, blockedUntil - now);
  return { allowed: false, retryAfterMs };
}

function evictOldestUnblockedRateLimitEntry(now: number): boolean {
  for (const [identifier, entry] of rateLimitState) {
    if (entry.blockedUntil === undefined || now >= entry.blockedUntil) {
      rateLimitState.delete(identifier);
      return true;
    }
  }
  return false;
}

function pruneRateLimitState(now: number): void {
  for (const [identifier, entry] of rateLimitState) {
    const windowExpired = now - entry.windowStartedAt >= RATE_LIMIT_WINDOW_MS;
    const blockExpired = entry.blockedUntil === undefined || now >= entry.blockedUntil;
    if (windowExpired && blockExpired) {
      rateLimitState.delete(identifier);
    }
  }
}

function logRateLimitSaturation(now: number): void {
  if (now - lastRateLimitSaturationWarnAt < RATE_LIMIT_WINDOW_MS) {
    return;
  }
  lastRateLimitSaturationWarnAt = now;
  logger.warn('Chat rate limiter rejected a new client because all entries are blocked', {
    maxClients: RATE_LIMIT_MAX_CLIENTS,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
}

function createRateLimitResponse(retryAfterMs: number): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new Response(
    JSON.stringify({
      error: 'rate_limited',
      retryAfterMs,
    }),
    {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': String(retryAfterSeconds),
      },
      status: 429,
    }
  );
}

export function __resetRateLimiterForTests(): void {
  rateLimitState.clear();
  lastRateLimitSaturationWarnAt = 0;
}

export function __setRateLimiterEntryForTests(
  identifier: string,
  entry: { blockedUntil?: number; count: number; windowStartedAt: number }
): void {
  rateLimitState.set(identifier, entry);
}

function createErrorResponse(err: unknown): Response {
  const inputError = describeWebAssistantInputError(err);
  if (inputError) {
    return createInputErrorResponse(inputError);
  }
  if (err instanceof InvalidWebAssistantRuntimeDataError) {
    return new Response(JSON.stringify({ error: 'invalid_runtime_data', message: err.message }), {
      headers: JSON_ERROR_HEADERS,
      status: 400,
    });
  }
  if (isMastraAgentError(err)) {
    logger.error('Failed to initialize chat stream', { code: err.code, error: err.message });
    return new Response(
      JSON.stringify({
        error: 'agent_stream_init_failed',
        message: 'Assistant stream initialization failed',
      }),
      {
        headers: JSON_ERROR_HEADERS,
        status: 502,
      }
    );
  }
  return new Response(JSON.stringify({ error: 'Failed to process chat request' }), {
    headers: JSON_ERROR_HEADERS,
    status: 500,
  });
}

function createInputErrorResponse(error: WebAssistantInputError): Response {
  return new Response(JSON.stringify(error.payload), {
    headers: JSON_ERROR_HEADERS,
    status: error.status,
  });
}
