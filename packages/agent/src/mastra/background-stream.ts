import { DELEGATED_STEP_USAGE_PART } from './delegated-step-usage';
import { asMastraStreamPart, type MastraStreamPart } from './mastra-chunk-decoding';
import { readStreamPartUsage, type UsageLike } from './runtime-assembly/usage-metering';
import { readMastraStreamPartString, readMastraStreamPartValue } from './tool-event-mapper';

const CHILD_OUTPUT_TYPES = new Set([DELEGATED_STEP_USAGE_PART, 'data-user-message', 'tool-output']);

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

/** Fold native untilIdle turns into one host-owned stream, retaining native child envelopes. */
export async function* projectBackgroundStream(
  source: AsyncIterable<unknown>,
  enabled = true
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
        continue;
      case 'tool-result':
        // Native dispatch acknowledgement is not the child's terminal result.
        if (callId && calls.has(callKey)) {
          continue;
        }
        break;
      case 'background-task-output': {
        const output = readMastraStreamPartValue(decoded.payload, 'payload');
        if (!CHILD_OUTPUT_TYPES.has(asMastraStreamPart(output).type)) {
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
      case 'background-task-resumed':
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
