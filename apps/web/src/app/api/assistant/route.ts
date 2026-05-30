import type {
  AssistantUiMessageStrict as AssistantUiMessage,
  RuntimeData,
  StreamChunk,
} from '@brainstrike/agent';
import {
  assistantDataStreamSessions,
  convertAssistantUiMessages,
  readToolApprovalRunConfigAction,
  resolveDataStreamSession,
  toAiSdkStyleStream,
} from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import { resolveAssistantProviderConfig } from '../../../server/assistant-config';

const logger = createLogger('WebAssistantRoute');

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
  const rawRunConfig = (body as Record<string, unknown>)['runConfig'];
  const toolApprovalResponse = resolveToolApprovalResponse(rawRunConfig);
  if (toolApprovalResponse) {
    return toolApprovalResponse;
  }
  const data = (body as Record<string, unknown>)['data'] as RuntimeData | undefined;
  const agentMessages = convertAssistantUiMessages(rawMessages);

  const provider = resolveAssistantProviderConfig();
  if (!(provider.enabled && provider.apiKey)) {
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
      apiKey: provider.apiKey,
    });
  } catch (error) {
    logger.error('Failed to initialize assistant stream', { error });
    return new Response(
      JSON.stringify({
        error: 'agent_stream_init_failed',
        message: 'Assistant stream initialization failed',
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

function resolveToolApprovalResponse(runConfig: unknown): Response | undefined {
  const toolApprovalAction = readToolApprovalRunConfigAction(runConfig);
  if (!toolApprovalAction) {
    return;
  }

  if ('invalid' in toolApprovalAction) {
    return new Response(
      JSON.stringify({
        error: 'invalid_tool_approval_action',
        message: 'Tool approval action must include action, runId, and toolCallId.',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }
    );
  }

  return new Response(
    JSON.stringify({
      error: 'tool_approval_resume_unsupported',
      message: 'Tool approval resume requires the desktop assistant backend.',
    }),
    {
      status: 501,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }
  );
}
