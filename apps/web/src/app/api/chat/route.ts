import type { AgentMessage, RuntimeData } from '@brainstrike/agent';
import { toAiSdkStyleStream } from '@brainstrike/agent';
import { z } from 'zod';

// zod schemas for `{ messages, data }`
const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1).max(16000),
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

// Export helper for tests
export function __parseChatBodyForTests(body: unknown): {
  messages: AgentMessage[];
  data?: RuntimeData;
} {
  const parsed = ChatBodySchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new Error(JSON.stringify({ code: 'invalid_body', issues }));
  }
  return parsed.data as { messages: AgentMessage[]; data?: RuntimeData };
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const { messages, data } = __parseChatBodyForTests(body);
    const stream = await toAiSdkStyleStream(messages, data);

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
    if (err instanceof Error) {
      try {
        const payload = JSON.parse(err.message) as { code?: string; issues?: unknown };
        if (payload?.code === 'invalid_body') {
          return new Response(JSON.stringify(payload), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            status: 400,
          });
        }
      } catch {}
    }
    return new Response(JSON.stringify({ error: 'Failed to process chat request' }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      status: 500,
    });
  }
}
