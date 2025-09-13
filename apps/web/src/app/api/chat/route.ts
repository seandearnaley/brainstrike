import type { AgentMessage } from '@brainstrike/agent';
import { toAiSdkStyleStream } from '@brainstrike/agent';

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const messages = (Array.isArray(body?.messages) ? body.messages : []) as AgentMessage[];
    const stream = await toAiSdkStyleStream(messages);

    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            // naive SSE-ish framing the AI SDK can consume via Response streaming
            controller.enqueue(encoder.encode(JSON.stringify(chunk) + '\n'));
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
  } catch {
    return new Response(JSON.stringify({ error: 'Failed to process chat request' }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      status: 500,
    });
  }
}
