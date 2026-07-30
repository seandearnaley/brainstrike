/**
 * Transport-independent assistant turn orchestration (BST-972 B3): stream
 * initialization -> data-stream session -> WHATWG Response -> terminal run-row
 * bookkeeping, extracted from the desktop root's streamAssistantPostResponse.
 *
 * The transport contract, in order (byte-for-byte the pre-B3 sequence):
 *   1. runAssistantTurn(...) — creates the session and its Response BEFORE
 *      returning (a stream-init failure records the failed run row here and
 *      returns the rejection-shaped failure instead);
 *   2. the transport pumps `response` into its own connection;
 *   3. the transport awaits `completion()` — whenClosed, then the terminal
 *      status write with the cancelled/terminalStatus/session-outcome
 *      precedence unchanged.
 * Steering registration stays with the caller: its unregister-in-finally is
 * coupled to pump lifetime, which remains transport-owned until BST-973's
 * shared HTTP adapter takes it over.
 */
import type {
  AgentMessage,
  AssistantToolApprovalAction,
  AssistantToolResumeAction,
  RuntimeData,
} from '@brainstrike/agent';
import { assistantDataStreamSessions } from '@brainstrike/agent';
import {
  ASSISTANT_STREAM_EVENT_ID_HEADER,
  ASSISTANT_STREAM_MESSAGE_ID_HEADER,
} from '@brainstrike/assistant-contract';
import type { RunPersistencePort, StreamInitializer } from './ports.js';
import type { AgentStreamFailure } from './types.js';

export interface RunAssistantTurnParams {
  readonly apiKey: string | undefined;
  readonly assistantMessageId: string | undefined;
  readonly executionSignal: AbortSignal;
  readonly initializeStream: StreamInitializer;
  readonly messages: AgentMessage[];
  readonly persistence: RunPersistencePort;
  readonly runId: string | undefined;
  readonly runtimeData: RuntimeData;
  readonly toolApprovalAction?: AssistantToolApprovalAction | undefined;
  readonly toolResumeAction?: AssistantToolResumeAction | undefined;
}

export type RunAssistantTurnResult =
  | {
      readonly ok: false;
      readonly status: number;
      readonly payload: AgentStreamFailure['payload'];
    }
  | {
      readonly ok: true;
      readonly response: Response;
      readonly completion: () => Promise<void>;
    };

export async function runAssistantTurn(
  params: RunAssistantTurnParams
): Promise<RunAssistantTurnResult> {
  const {
    apiKey,
    assistantMessageId,
    executionSignal,
    messages,
    persistence,
    initializeStream,
    runId,
    runtimeData,
    toolApprovalAction,
    toolResumeAction,
  } = params;

  const streamResult = await initializeStream({
    apiKey,
    messages,
    runId,
    runtimeData,
    signal: executionSignal,
    toolApprovalAction,
    toolResumeAction,
  });
  if (!streamResult.ok) {
    if (runId) {
      await persistence.recordThreadRunStatus(runId, 'failed', streamResult.payload.message);
    }
    return { ok: false, payload: streamResult.payload, status: streamResult.status };
  }

  const session = assistantDataStreamSessions.create(streamResult.stream, {
    ...(assistantMessageId ? { messageId: assistantMessageId } : {}),
  });
  const response = session.createResponse({
    headers: {
      [ASSISTANT_STREAM_EVENT_ID_HEADER]: `${session.id}:-1`,
      [ASSISTANT_STREAM_MESSAGE_ID_HEADER]: session.messageId,
    },
  });

  return {
    completion: async () => {
      await session.whenClosed();
      if (runId) {
        const sessionOutcome = session.getTerminalOutcome();
        await persistence.recordThreadRunStatus(
          runId,
          executionSignal.aborted
            ? 'cancelled'
            : (streamResult.terminalStatus ?? sessionOutcome.status),
          executionSignal.aborted
            ? 'Assistant run canceled by user.'
            : (streamResult.terminalError ?? sessionOutcome.error)
        );
      }
    },
    ok: true,
    response,
  };
}
