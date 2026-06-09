import type { AgentMessage, RuntimeData } from '@brainstrike/agent';
import {
  AssistantRequestBodyTooLargeError,
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR as BODY_LIMIT_ENV_VAR,
  isMastraAgentError,
  readRequestBodyText,
  resolveAssistantRequestBodyLimitBytes as resolveBodyLimit,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import { z } from 'zod';
import type { AssistantProviderConfig } from '../../../server/assistant-config';
import { resolveAssistantProviderConfig } from '../../../server/assistant-config';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const RATE_LIMIT_MAX_CLIENTS = 1024;
const logger = createLogger('WebChatRoute');
const chatRequestBodyLimitBytes = resolveBodyLimit(process.env[BODY_LIMIT_ENV_VAR]);

interface RateLimitEntry {
  blockedUntil?: number;
  count: number;
  windowStartedAt: number;
}

const rateLimitState = new Map<string, RateLimitEntry>();

// zod schemas for `{ messages, data }`
const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1).max(16_000),
});
const ToolPartSchema = z.object({
  type: z.string().regex(/^tool-/),
  state: z.enum(['input-available', 'input-streaming', 'output-available', 'output-error']),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  errorText: z.string().optional(),
});

const AgentMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(z.union([TextPartSchema, ToolPartSchema])).min(1),
});

const RuntimeDataSchema = z
  .object({
    projectId: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    mcpEnabled: z.boolean().optional(),
  })
  .strict()
  .optional();

const ChatBodySchema = z.object({
  messages: z.array(AgentMessageSchema).min(1),
  data: RuntimeDataSchema,
});

function formatZodIssue(issue: z.ZodIssue): { path: string; message: string } {
  const path = Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path);
  return { path, message: issue.message };
}

// Export helper for tests
export function __parseChatBodyForTests(body: unknown): {
  messages: AgentMessage[];
  data?: RuntimeData;
} {
  const parsed = ChatBodySchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => formatZodIssue(issue));
    throw new Error(JSON.stringify({ code: 'invalid_body', issues }));
  }
  return parsed.data as { messages: AgentMessage[]; data?: RuntimeData };
}

export async function POST(req: Request): Promise<Response> {
  try {
    const clientIdentifier = resolveClientIdentifier(req);
    const limitResult = applyRateLimit(clientIdentifier);
    if (!limitResult.allowed) {
      return createRateLimitResponse(limitResult.retryAfterMs);
    }

    const body = parseJsonRequestBody(await readRequestBodyText(req, chatRequestBodyLimitBytes));
    const { messages, data } = __parseChatBodyForTests(body);

    const provider = resolveAssistantProviderConfig();
    if (!providerHasApiKey(provider)) {
      return new Response(
        JSON.stringify({
          error: 'assistant_disabled',
          reason: provider.disabledReason ?? 'missing_api_key',
        }),
        {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          },
          status: 503,
        }
      );
    }

    const stream = await toAiSdkStyleStream(messages, {
      ...(data ?? {}),
      apiKey: provider.apiKey,
    });

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
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
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
    pruneRateLimitState(now);
    if (rateLimitState.size >= RATE_LIMIT_MAX_CLIENTS) {
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

function pruneRateLimitState(now: number): void {
  for (const [identifier, entry] of rateLimitState) {
    const windowExpired = now - entry.windowStartedAt >= RATE_LIMIT_WINDOW_MS;
    const blockExpired = entry.blockedUntil === undefined || now >= entry.blockedUntil;
    if (windowExpired && blockExpired) {
      rateLimitState.delete(identifier);
    }
  }
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
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': String(retryAfterSeconds),
      },
      status: 429,
    }
  );
}

function parseJsonRequestBody(body: string): unknown {
  try {
    return JSON.parse(body || '{}') as unknown;
  } catch {
    return {};
  }
}

export function __resetRateLimiterForTests(): void {
  rateLimitState.clear();
}

function createErrorResponse(err: unknown): Response {
  if (err instanceof AssistantRequestBodyTooLargeError) {
    return new Response(JSON.stringify({ error: err.code, message: err.message }), {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      },
      status: 413,
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
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        status: 502,
      }
    );
  }
  if (err instanceof Error) {
    const message = err.message ?? '';
    const parsed = parseInvalidBodyError(message);
    if (parsed) {
      return parsed;
    }
  }
  return new Response(JSON.stringify({ error: 'Failed to process chat request' }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    status: 500,
  });
}

function parseInvalidBodyError(message: string): Response | null {
  try {
    const payload = JSON.parse(message) as { code?: string; issues?: unknown };
    if (payload?.code === 'invalid_body') {
      return new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        status: 400,
      });
    }
  } catch {}
  return null;
}
