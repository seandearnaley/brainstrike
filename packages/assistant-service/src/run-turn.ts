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
 *   4. THE CALLER OWNS TERMINAL BOOKKEEPING ON THROWS: if initializeStream
 *      REJECTS (vs returning ok:false), or the pump throws so completion()
 *      never runs, this module has written nothing — the caller MUST record a
 *      terminal failed/cancelled row itself (desktop: handleAssistantPost's
 *      catch -> handleAssistantPostStreamError). A caller that skips step 4
 *      accumulates silently-orphaned running rows.
 * Steering registration stays with the caller: its unregister-in-finally is
 * coupled to pump lifetime, which remains transport-owned until BST-973's
 * shared HTTP adapter takes it over.
 */
import type {
  AgentMessage,
  AssistantToolApprovalAction,
  AssistantToolResumeAction,
  assistantDataStreamSessions,
  ProviderAuthInput,
  RuntimeData,
} from '@brainstrike/agent';
import {
  ASSISTANT_STREAM_EVENT_ID_HEADER,
  ASSISTANT_STREAM_MESSAGE_ID_HEADER,
} from '@brainstrike/assistant-contract';
import type { AssistantChildFollowupAction } from '@brainstrike/assistant-contract/child-followup';
import type { RunPersistencePort, StreamInitializer } from './ports.js';
import { acquireThreadRunOwnership } from './thread-run-ownership.js';
import type { AgentStreamFailure } from './types.js';

export interface RunAssistantTurnParams {
  readonly apiKey: string | undefined;
  readonly assistantMessageId: string | undefined;
  /**
   * Provider auth input (BST-1352): a DIRECT parameter into the injected
   * stream initializer, never copied onto `runtimeData` (RequestContext.toJSON
   * drops functions — a custom_fetch closure would vanish silently).
   */
  readonly authInput?: ProviderAuthInput | undefined;
  readonly childFollowupAction?: AssistantChildFollowupAction;
  readonly executionSignal: AbortSignal;
  readonly initializeStream: StreamInitializer;
  readonly messages: AgentMessage[];
  readonly persistence: RunPersistencePort;
  readonly runId: string | undefined;
  readonly runtimeData: RuntimeData;
  /**
   * The data-stream session REGISTRY, injected (review P1 on this PR): the
   * agent package ships dual entrypoints (require -> dist/index.js, import ->
   * dist/index.mjs), so a packaged desktop would otherwise hold TWO
   * assistantDataStreamSessions singletons — sessions created by this ESM
   * module invisible to the CJS resume path's resolveDataStreamSession. The
   * host passes ITS instance; creation and lookup stay in one registry.
   */
  readonly sessions: typeof assistantDataStreamSessions;
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
  const scope = params.runtimeData.memory;
  if (!scope) {
    return runOwnedAssistantTurn(params);
  }
  const release = await acquireThreadRunOwnership(scope, params.executionSignal);
  try {
    params.executionSignal.throwIfAborted();
    const turn = await runOwnedAssistantTurn(params);
    if (!turn.ok) {
      release();
      return turn;
    }
    // Host-owned execution settles even when its HTTP subscriber disconnects.
    // Releasing after the terminal write prevents the next native manager from
    // recovering or overwriting a still-owned root.
    const completion = turn.completion().finally(release);
    completion.catch(() => {});
    return { ...turn, completion: () => completion };
  } catch (error) {
    release();
    throw error;
  }
}

async function runOwnedAssistantTurn(
  params: RunAssistantTurnParams
): Promise<RunAssistantTurnResult> {
  const {
    apiKey,
    authInput,
    assistantMessageId,
    executionSignal,
    messages,
    persistence,
    initializeStream,
    sessions,
    runId,
    runtimeData,
    childFollowupAction,
    toolApprovalAction,
    toolResumeAction,
  } = params;

  const streamResult = await initializeStream({
    apiKey,
    authInput,
    childFollowupAction,
    messages,
    runId,
    runtimeData,
    signal: executionSignal,
    toolApprovalAction,
    toolResumeAction,
  });
  if (!streamResult.ok) {
    if (runId) {
      await persistence.recordThreadRunStatus(
        runId,
        executionSignal.aborted ? 'cancelled' : 'failed',
        executionSignal.aborted ? 'Assistant run canceled by user.' : streamResult.payload.message
      );
    }
    return { ok: false, payload: streamResult.payload, status: streamResult.status };
  }

  const reasoningEffort = runtimeData.requestedReasoningEffort;
  const outputLimitContext =
    runtimeData.provider === 'openrouter' &&
    typeof runtimeData.model === 'string' &&
    typeof reasoningEffort === 'string'
      ? {
          model: runtimeData.model,
          provider: 'openrouter' as const,
          reasoningEffort,
        }
      : undefined;
  const session = sessions.create(streamResult.stream, {
    ...(assistantMessageId ? { messageId: assistantMessageId } : {}),
    ...(outputLimitContext ? { outputLimitContext } : {}),
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
