import {
  type AssistantResilienceConfig,
  StreamStalledError,
  type ToolCallInputStreamingTimeoutError,
  type ToolExecutions,
  withInactivityTimeout,
  withToolCallInputTimeout,
} from '@brainstrike/agent/provider-runtime';
import { createLogger } from '@brainstrike/logging';
import type { TextStreamPart, ToolSet } from 'ai';
import type { HostRunState } from './core-state.ts';

const logger = createLogger('AgentHost');

type Part = TextStreamPart<ToolSet>;
export type HostStreamWatchdogError = StreamStalledError | ToolCallInputStreamingTimeoutError;

/**
 * AI SDK 7 parts that are not provider output: the stream's own start, and the
 * step boundaries the SDK emits around each provider call. A CLOSED list, so a
 * new SDK part type counts as output (the tight window), never as free time.
 */
const SCAFFOLDING_PARTS: ReadonlySet<Part['type']> = new Set([
  'start',
  'start-step',
  'finish-step',
  'finish',
  'abort',
  'error',
  'raw',
]);

/**
 * The phase-aware watchdogs over one SDK `fullStream`: first-output,
 * reasoning-gap and inter-output windows whenever no tool is running, plus the
 * absolute streamed tool-input deadline. Expiry rejects the iteration with the
 * typed error and reports it to `onTimeout` first, so the caller can abort the
 * provider before the stream unwinds.
 *
 * `streamText`'s `timeout` (ai 7.0.160) covers none of these windows as the
 * host needs them, so none is handed to it:
 * - `firstChunkMs` starts only once the provider call has returned its
 *   response headers, so it never ends a provider that holds them.
 * - `chunkMs` is one window for every output gap: it cannot keep reasoning
 *   pauses wide and answer gaps tight.
 * - `stepMs` includes local tool execution, which this watchdog never judges.
 * - Nothing bounds the assembly of one streamed tool input.
 */
export function watchHostStream(
  source: AsyncIterable<Part>,
  config: AssistantResilienceConfig,
  toolExecutions: ToolExecutions,
  onTimeout: (error: HostStreamWatchdogError) => void
): AsyncIterable<Part> {
  return withToolCallInputTimeout(
    withInactivityTimeout(
      source,
      {
        firstOutputMs: config.streamFirstOutputMs,
        interOutputMs: config.streamInactivityMs,
        reasoningGapMs: config.streamReasoningGapMs,
      },
      {
        countsAsProviderOutput: (part) => !SCAFFOLDING_PARTS.has(part.type),
        describePart: (part) => part.type,
        onTimeout,
        reasoningPartKind: (part) =>
          part.type === 'reasoning-delta' || part.type === 'reasoning-file'
            ? 'content'
            : part.type === 'reasoning-start' || part.type === 'reasoning-end'
              ? 'marker'
              : undefined,
        toolExecutions,
      }
    ),
    config.toolCallInputMs,
    onTimeout
  );
}

/** Settle provider work before the watched stream unwinds. */
export function stopHostStreamAttempt(
  run: HostRunState,
  attempt: AbortController,
  error: HostStreamWatchdogError
): void {
  logger.error('Host run stream exceeded its watchdog window', {
    code: error.code,
    runId: run.id,
    threadId: run.threadId,
    ...(error instanceof StreamStalledError
      ? {
          ...(error.lastPartType ? { lastPartType: error.lastPartType } : {}),
          partsSeen: error.partsSeen,
          phase: error.phase,
          windowMs: error.inactivityMs,
        }
      : { timeoutMs: error.timeoutMs, toolCallId: error.toolCallId }),
  });
  attempt.abort(error);
}
