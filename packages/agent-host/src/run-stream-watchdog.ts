import {
  type AssistantResilienceConfig,
  StreamStalledError,
  type ToolCallInputStreamingTimeoutError,
  withInactivityTimeout,
  withToolCallInputTimeout,
} from '@brainstrike/agent/provider-runtime';
import { createLogger } from '@brainstrike/logging';
import type { TextStreamPart, ToolSet } from 'ai';
import type { HostRunState } from './core-state.js';

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

function toolExecutionPartKind(
  part: Part,
  executesInHost: (toolName: string) => boolean
): { readonly kind: 'started' | 'settled'; readonly toolCallId: string } | undefined {
  switch (part.type) {
    case 'tool-call':
      // A provider-executed call is the provider's silence, not our tool's.
      return part.providerExecuted !== true && executesInHost(part.toolName)
        ? { kind: 'started', toolCallId: part.toolCallId }
        : undefined;
    case 'tool-result':
      return part.preliminary === true
        ? undefined
        : { kind: 'settled', toolCallId: part.toolCallId };
    case 'tool-error':
    case 'tool-output-denied':
      return { kind: 'settled', toolCallId: part.toolCallId };
    case 'tool-approval-request':
      // Waiting on a decision, not executing.
      return { kind: 'settled', toolCallId: part.toolCall.toolCallId };
    case 'tool-approval-response':
      // The host answers an allowed call in-stream; an approved call now runs.
      return part.approved && executesInHost(part.toolCall.toolName)
        ? { kind: 'started', toolCallId: part.toolCall.toolCallId }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The legacy phase-aware watchdogs over one SDK `fullStream`: first-output,
 * reasoning-gap, inter-output and tool-executing windows, plus the absolute
 * streamed tool-input deadline. Expiry rejects the iteration with the typed
 * error and reports it to `onTimeout` first, so the caller can abort the
 * provider before the stream unwinds.
 *
 * The SDK's own `timeout.chunkMs` is not used: its timer keeps running while a
 * tool executes and resets on reasoning deltas, so it cannot hold these windows.
 */
export function watchHostStream(
  source: AsyncIterable<Part>,
  config: AssistantResilienceConfig,
  executesInHost: (toolName: string) => boolean,
  onTimeout: (error: HostStreamWatchdogError) => void
): AsyncIterable<Part> {
  return withToolCallInputTimeout(
    withInactivityTimeout(
      source,
      {
        firstOutputMs: config.streamFirstOutputMs,
        interOutputMs: config.streamInactivityMs,
        reasoningGapMs: config.streamReasoningGapMs,
        toolExecutingMs: config.toolExecutingMs,
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
        toolExecutionPartKind: (part) => toolExecutionPartKind(part, executesInHost),
      }
    ),
    config.toolCallInputMs,
    onTimeout
  );
}

/**
 * Settle provider work before the watched stream unwinds. A stall while a
 * host tool still runs is terminal, so that tool is cancelled with its run:
 * re-running the step could start a second execution of it.
 */
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
  if (error instanceof StreamStalledError && error.phase === 'tool-executing') {
    run.controller.abort(error);
  }
}
