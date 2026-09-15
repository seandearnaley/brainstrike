import { DELEGATED_STEP_USAGE_PART } from './delegated-step-usage';
import { DELEGATED_SYNTHESIS_PART } from './delegated-synthesis-outcomes';
import { asMastraStreamPart, type MastraStreamPart } from './mastra-chunk-decoding';
import { readStreamPartUsage, type UsageLike } from './runtime-assembly/usage-metering';
import { readMastraStreamPartString, readMastraStreamPartValue } from './tool-event-mapper';

const CHILD_OUTPUT_TYPES = new Set([
  DELEGATED_STEP_USAGE_PART,
  DELEGATED_SYNTHESIS_PART,
  'data-user-message',
  'tool-output',
]);

/**
 * A background child output is forwardable when it is a child envelope or a raw
 * `data-*` chunk; a missing or non-string discriminator is a contract break,
 * reported as such rather than as a TypeError.
 */
function isForwardableChildOutput(outputType: unknown): outputType is string {
  return (
    typeof outputType === 'string' &&
    (CHILD_OUTPUT_TYPES.has(outputType) || outputType.startsWith('data-'))
  );
}

function addParentUsage(total: UsageLike, part: MastraStreamPart): void {
  const next = readStreamPartUsage(part);
  if (!next) {
    return;
  }
  total.inputTokens = (total.inputTokens ?? 0) + (next.promptTokens ?? next.inputTokens ?? 0);
  total.outputTokens =
    (total.outputTokens ?? 0) + (next.completionTokens ?? next.outputTokens ?? 0);
  total.cachedInputTokens = (total.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0);
  total.cacheCreationInputTokens =
    (total.cacheCreationInputTokens ?? 0) + (next.cacheCreationInputTokens ?? 0);
}

function observeTaskLifetime(part: MastraStreamPart, activeTasks: Set<string>): void {
  switch (part.type) {
    case 'background-task-started':
    case 'background-task-running':
    case 'background-task-resumed':
    case 'background-task-completed':
    case 'background-task-failed':
    case 'background-task-suspended':
    case 'background-task-cancelled': {
      const taskId = readMastraStreamPartString(part, 'taskId');
      if (!taskId) {
        throw new Error('Native background lifecycle omitted its task identity.');
      }
      if (
        ['background-task-started', 'background-task-running', 'background-task-resumed'].includes(
          part.type
        )
      ) {
        activeTasks.add(taskId);
      } else {
        activeTasks.delete(taskId);
      }
      return;
    }
    default:
      return;
  }
}

/** Parent wakeups remain separate paragraphs within the host-owned response. */
async function* separateParentTurns(source: AsyncIterable<unknown>): AsyncGenerator<unknown> {
  let hasText = false;
  let needsBoundary = false;
  for await (const part of source) {
    const decoded = asMastraStreamPart(part);
    if (decoded.type === 'start') {
      needsBoundary = hasText;
    }
    if (decoded.type === 'text-delta') {
      if (needsBoundary) {
        yield { ...decoded, payload: { ...decoded.payload, text: '\n\n' } };
      }
      hasText = true;
      needsBoundary = false;
    }
    yield part;
  }
}

/** Fold the host idle loop's turns into one host-owned stream, retaining native child envelopes. */
export async function* projectBackgroundStream(
  source: AsyncIterable<unknown>,
  enabled = true,
  /** Filled with `[runId, toolCallId]` keys of every call dispatched in the background. */
  backgroundCalls?: Set<string>
): AsyncGenerator<unknown> {
  if (!enabled) {
    yield* source;
    return;
  }
  const calls = new Set<string>();
  const activeTasks = new Set<string>();
  const usage: UsageLike = {};
  let started = false;
  let terminal: MastraStreamPart | undefined;
  for await (const part of separateParentTurns(source)) {
    const decoded = asMastraStreamPart(part);
    const callId = readMastraStreamPartString(part, 'toolCallId');
    observeTaskLifetime(decoded, activeTasks);
    const callKey = JSON.stringify([readMastraStreamPartString(part, 'runId'), callId]);
    switch (decoded.type) {
      case 'start':
        if (started) {
          continue;
        }
        started = true;
        break;
      case 'finish': {
        terminal = decoded;
        addParentUsage(usage, decoded);
        continue;
      }
      case 'background-task-started':
      case 'background-task-running':
        if (!callId) {
          throw new Error('Native background task omitted its tool-call identity.');
        }
        calls.add(callKey);
        backgroundCalls?.add(callKey);
        continue;
      case 'tool-result':
        // Native dispatch acknowledgement is not the child's terminal result.
        if (callId && calls.has(callKey)) {
          continue;
        }
        break;
      case 'background-task-output': {
        const output = readMastraStreamPartValue(decoded.payload, 'payload');
        const outputType = asMastraStreamPart(output).type;
        // A child's `data-*` chunk (observational memory, approval/suspend data
        // parts, user messages) reaches the parent RAW in both paths: Mastra's
        // `ToolStream.custom()` writes it without the `tool-output` envelope in
        // the foreground, and the background task publishes the same object as
        // its output. Forward it unchanged, exactly as the foreground stream
        // already does; only a non-data, non-envelope chunk is a contract break.
        // (2026-09-13: `data-om-buffering-start` from a background Explorer
        // child hit the throw below and failed the root run.)
        if (!isForwardableChildOutput(outputType)) {
          throw new Error('Native background child output omitted its delegation envelope.');
        }
        yield output;
        continue;
      }
      case 'background-task-completed':
        yield { ...decoded, type: 'tool-result' };
        continue;
      case 'background-task-failed':
        yield { ...decoded, type: 'tool-error' };
        continue;
      case 'background-task-suspended':
        // The task is now parked in storage: the moment its withheld card may
        // publish, because only now can a decision on it be applied
        // (`releaseParkedNotices`). The card's own chunk preceded this by the
        // child's stream, before the task was durably suspended.
        yield part;
        continue;
      case 'background-task-resumed':
        // A parked child continues in this leg (a live decision): its held
        // pause terminal is dropped, its own finish will follow.
        yield part;
        continue;
      case 'background-task-cancelled':
        continue;
      default:
        break;
    }
    yield part;
  }
  if (activeTasks.size > 0) {
    throw new Error('Background stream ended with unfinished child work.');
  }
  if (terminal) {
    yield { ...terminal, usage };
  }
}
