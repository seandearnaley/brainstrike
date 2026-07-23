interface ToolCallInputPart {
  id?: unknown;
  payload?: {
    id?: unknown;
    toolCallId?: unknown;
  };
  toolCallId?: unknown;
  type?: unknown;
}

export class ToolCallInputStreamingTimeoutError extends Error {
  readonly code = 'tool_call_input_streaming_timeout';

  constructor(
    public readonly timeoutMs: number,
    public readonly toolCallId: string
  ) {
    super(`Tool call "${toolCallId}" did not finish streaming its input within ${timeoutMs}ms`);
    this.name = 'ToolCallInputStreamingTimeoutError';
  }
}

function readPart(value: unknown): ToolCallInputPart | undefined {
  if (!(value && typeof value === 'object')) {
    return;
  }
  return value as ToolCallInputPart;
}

function readToolCallId(part: ToolCallInputPart): string | undefined {
  const candidates = [part.toolCallId, part.id, part.payload?.toolCallId, part.payload?.id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return;
}

function observeToolCallInputPart(
  value: unknown,
  activeInputs: Map<string, number>,
  completedCalls: Set<string>
): void {
  const part = readPart(value);
  if (!part || typeof part.type !== 'string') {
    return;
  }
  const toolCallId = readToolCallId(part);
  if (!toolCallId) {
    return;
  }

  if (part.type === 'tool-call' || part.type === 'tool-result' || part.type === 'tool-error') {
    activeInputs.delete(toolCallId);
    completedCalls.add(toolCallId);
    return;
  }

  if (part.type === 'tool-call-input-streaming-end') {
    activeInputs.delete(toolCallId);
    return;
  }

  if (
    (part.type === 'tool-call-input-streaming-start' || part.type === 'tool-call-delta') &&
    !completedCalls.has(toolCallId) &&
    !activeInputs.has(toolCallId)
  ) {
    activeInputs.set(toolCallId, Date.now());
  }
}

function findEarliestInput(
  activeInputs: ReadonlyMap<string, number>
): { startedAt: number; toolCallId: string } | undefined {
  let earliest: { startedAt: number; toolCallId: string } | undefined;
  for (const [toolCallId, startedAt] of activeInputs) {
    if (!earliest || startedAt < earliest.startedAt) {
      earliest = { startedAt, toolCallId };
    }
  }
  return earliest;
}

/**
 * Bound the absolute time spent assembling one streamed tool-call input.
 *
 * The ordinary stream inactivity watchdog resets on every delivered part.
 * Provider `tool-call-delta` parts therefore prove transport activity but do
 * not prove that the call will ever become executable. This wrapper keeps the
 * first-delta deadline stable until Mastra emits the matching input end or
 * complete tool call.
 */
export async function* withToolCallInputTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number,
  onTimeout?: (error: ToolCallInputStreamingTimeoutError) => void
): AsyncIterableIterator<T> {
  const iterator = source[Symbol.asyncIterator]();
  const activeInputs = new Map<string, number>();
  const completedCalls = new Set<string>();

  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const earliest = findEarliestInput(activeInputs);
      const nextResult = iterator.next();
      let result: IteratorResult<T>;
      try {
        result = earliest
          ? await Promise.race([
              nextResult,
              new Promise<never>((_resolve, reject) => {
                const remainingMs = Math.max(0, earliest.startedAt + timeoutMs - Date.now());
                timer = setTimeout(() => {
                  const error = new ToolCallInputStreamingTimeoutError(
                    timeoutMs,
                    earliest.toolCallId
                  );
                  // Preserve the semantic timeout even when owner cancellation
                  // makes the underlying reader settle at the same boundary.
                  reject(error);
                  onTimeout?.(error);
                }, remainingMs);
                (timer as { unref?: () => void }).unref?.();
              }),
            ])
          : await nextResult;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
      if (result.done) {
        return;
      }
      observeToolCallInputPart(result.value, activeInputs, completedCalls);
      yield result.value;
    }
  } finally {
    iterator.return?.();
  }
}
