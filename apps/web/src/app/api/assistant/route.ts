import type { AssistantUiMessage, RuntimeData } from '@brainstrike/agent';
import { convertAssistantUiMessages, toAiSdkStyleStream, webTools } from '@brainstrike/agent';
import { createAssistantStreamResponse } from 'assistant-stream';
import {
  type StreamChunk,
  type StreamController,
  processAgentStream as streamAssistantMessages,
} from '../../../assistant-stream-helpers';
import { resolveAssistantProviderConfig } from '../../../server/assistant-config';

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const rawMessages = Array.isArray((body as Record<string, unknown>)['messages'])
    ? ((body as Record<string, unknown>)['messages'] as AssistantUiMessage[])
    : [];
  const data = (body as Record<string, unknown>)['data'] as RuntimeData | undefined;
  const agentMessages = convertAssistantUiMessages(rawMessages);

  const provider = resolveAssistantProviderConfig();
  if (!provider.enabled || !provider.apiKey) {
    return new Response(
      JSON.stringify({
        error: 'assistant_disabled',
        reason: provider.disabledReason ?? 'missing_api_key',
      }),
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }
    );
  }

  let agentStream: AsyncIterable<StreamChunk>;
  try {
    agentStream = await toAiSdkStyleStream(agentMessages, {
      ...(data ?? {}),
      mastraTools: webTools,
      apiKey: provider.apiKey,
    });
  } catch (error) {
    console.error('[api/assistant] failed to initialize assistant stream', error);
    return new Response(
      JSON.stringify({
        error: 'agent_stream_init_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }
    );
  }

  return createAssistantStreamResponse(async (ctrl) => {
    // Ensure an assistant message container is present immediately on request
    // so tests can observe the label without waiting for the first delta.
    ctrl.addTextPart();
    await streamAssistantMessages(ctrl as StreamController, agentStream);
  });
}
