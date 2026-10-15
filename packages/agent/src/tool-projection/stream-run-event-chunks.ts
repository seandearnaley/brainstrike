/**
 * BST-986: run-event and finish chunk MINTING — the smallest impure layer of the
 * Mastra stream boundary.
 *
 * Every function here mints a fresh {@link StreamChunk}: a run-event id
 * (`generateUUID`) and a wall-clock timestamp (`new Date()`) per call. That is
 * why they could not move into `mastra-chunk-decoding.ts`, whose contract is
 * referential transparency (BST-985). They read no stream state and mutate
 * nothing, so this module is the leaf every other streaming concern
 * (tool lifecycle, approval pauses, terminations) depends on.
 *
 * See docs/agents/mastra-boundary.md R6 and docs/agents/assistant-runtime.md.
 */
import { generateUUID } from '@brainstrike/utils';
import type {
  AssistantRunEventKind,
  AssistantRunEventMetadata,
  AssistantRunEventStatus,
} from '../run-events';
import type { StreamChunk } from '../types';

export function makeSyntheticFinishChunk(): StreamChunk {
  return {
    finishReason: 'other',
    path: [],
    type: 'message-finish',
    usage: { completionTokens: 0, promptTokens: 0 },
  };
}

export function makeErrorFinishChunk(): StreamChunk {
  return {
    finishReason: 'error',
    path: [],
    type: 'message-finish',
    usage: { completionTokens: 0, promptTokens: 0 },
  };
}

export function makeToolCallsFinishChunk(): StreamChunk {
  return {
    finishReason: 'tool-calls',
    path: [],
    type: 'message-finish',
    usage: { completionTokens: 0, promptTokens: 0 },
  };
}

export function makeRunEventChunk(
  kind: AssistantRunEventKind,
  status: AssistantRunEventStatus,
  label: string,
  metadata?: AssistantRunEventMetadata,
  timestamp?: string
): StreamChunk {
  return {
    event: {
      id: `run-event-${generateUUID()}`,
      kind,
      label,
      status,
      timestamp: timestamp ?? new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    },
    type: 'run-event',
  };
}

/**
 * Any run-event chunk that carries a SPECIFIC `detail`.
 *
 * Same reasoning as {@link makeRunFailedChunk}: `detail` is deliberately its
 * own REQUIRED positional rather than another optional on `makeRunEventChunk`,
 * whose trailing optionals are `metadata` and `timestamp` — both `string`-ish
 * enough that a positional slip would type-check while writing a timestamp into
 * the detail field. Used by the stall/resume events (BST-1409), whose whole
 * value is the detail: "attempt 1 of 2, no output for 120000ms (inter-part)".
 */
export function makeRunDetailEventChunk(
  kind: AssistantRunEventKind,
  status: AssistantRunEventStatus,
  label: string,
  detail: string,
  metadata?: AssistantRunEventMetadata
): StreamChunk {
  return {
    event: {
      detail,
      id: `run-event-${generateUUID()}`,
      kind,
      label,
      status,
      timestamp: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    },
    type: 'run-event',
  };
}

/**
 * A `run.failed` chunk that also carries a SPECIFIC `detail`.
 *
 * The three stream terminations all use the same generic label ("Assistant run
 * failed"), which is fine for the run-event timeline but useless as durable
 * failure text: `data-stream-mapper` derives `thread_runs.error` from this
 * event, so without a detail every provider failure, stall, and tool-input
 * timeout persists the same signal-free string, and the debug bundle's Failure
 * summary cannot say WHY a run failed.
 *
 * Deliberately a separate helper rather than another optional parameter on
 * `makeRunEventChunk`: that function's trailing optionals are `metadata` and
 * `timestamp`, and `detail`/`timestamp` are both `string`, so a positional
 * mistake between them would type-check cleanly while silently writing a
 * timestamp into the detail field.
 */
export function makeRunFailedChunk(
  label: string,
  detail: string,
  metadata?: AssistantRunEventMetadata
): StreamChunk {
  // Built directly rather than by spreading `makeRunEventChunk(...)`: its return
  // type is the `StreamChunk` union, so `chunk.event` is not accessible without
  // narrowing and the spread widens the result off the union. The small overlap
  // with that function's body is the price of staying type-safe here.
  return {
    event: {
      detail,
      id: `run-event-${generateUUID()}`,
      kind: 'run.failed',
      label,
      status: 'failed',
      timestamp: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    },
    type: 'run-event',
  };
}
