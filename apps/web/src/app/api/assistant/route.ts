import type {
  AssistantUiMessageStrict as AssistantUiMessage,
  RuntimeData,
  StreamChunk,
} from '@brainstrike/agent';
import {
  assistantDataStreamSessions,
  convertAssistantUiMessages,
  resolveDataStreamSession,
  toAiSdkStyleStream,
  webTools,
} from '@brainstrike/agent';
import { resolveAssistantProviderConfig } from '../../../server/assistant-config';

export async function POST(req: Request): Promise<Response> {
  const lastEventId = req.headers.get('last-event-id');
  const sessionFromResume = resolveDataStreamSession(lastEventId);
  if (sessionFromResume) {
    return sessionFromResume.createResponse(
      lastEventId ? { resumeFromEventId: lastEventId } : undefined
    );
  }

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

  const session = assistantDataStreamSessions.create(agentStream);
  return session.createResponse();
}
