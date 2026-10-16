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

/** The visible text: the incomplete call never reached execution. */
export function describeToolCallInputTimeout(error: ToolCallInputStreamingTimeoutError): string {
  return `The model did not finish streaming a tool call's arguments within ${error.timeoutMs}ms. The incomplete tool call was cancelled before execution.`;
}

/**
 * Streamed tool-input boundaries in both stream vocabularies this deadline
 * wraps: Mastra's chunk names and the AI SDK 7 `fullStream` part names.
 */
const INPUT_START_PARTS: ReadonlySet<string> = new Set([
  'tool-call-input-streaming-start',
  'tool-call-delta',
  'tool-input-start',
  'tool-input-delta',
]);
const INPUT_END_PARTS: ReadonlySet<string> = new Set([
  'tool-call-input-streaming-end',
  'tool-input-end',
]);

function readPart(value: unknown): ToolCallInputPart | undefined {
  if (!(value && typeof value === 'object')) {
    return;
  }
  return value as ToolCallInputPart;
}

function readToolCallId(part: ToolCallInputPart): string | undefined {
  const toolCallId = part.toolCallId;
  if (typeof toolCallId === 'string' && toolCallId.length > 0) {
    return toolCallId;
  }
  const id = part.id;
  if (typeof id === 'string' && id.length > 0) {
    return id;
  }
  const payload = part.payload;
  const payloadToolCallId = payload?.toolCallId;
  if (typeof payloadToolCallId === 'string' && payloadToolCallId.length > 0) {
    return payloadToolCallId;
  }
  const payloadId = payload?.id;
  if (typeof payloadId === 'string' && payloadId.length > 0) {
    return payloadId;
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
  const partType = part.type;
  const settles =
    partType === 'tool-call' || partType === 'tool-result' || partType === 'tool-error';
  if (!(settles || INPUT_START_PARTS.has(partType) || INPUT_END_PARTS.has(partType))) {
    return;
  }
  const toolCallId = readToolCallId(part);
  if (!toolCallId) {
    return;
  }

  if (settles || INPUT_END_PARTS.has(partType)) {
    activeInputs.delete(toolCallId);
    completedCalls.add(toolCallId);
    return;
  }

  if (!(completedCalls.has(toolCallId) || activeInputs.has(toolCallId))) {
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
 * first-delta deadline stable until the stream emits the matching input end or
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
      if (earliest && earliest.startedAt + timeoutMs <= Date.now()) {
        const error = new ToolCallInputStreamingTimeoutError(timeoutMs, earliest.toolCallId);
        onTimeout?.(error);
        throw error;
      }
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
    void iterator.return?.();
  }
}
