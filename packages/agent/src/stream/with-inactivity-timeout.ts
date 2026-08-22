/**
 * Which silence killed the stream. A stall BEFORE the first part means the
 * provider never started answering; a stall AFTER it means the provider started
 * and then went quiet. Conflating the two is what killed a healthy 18-minute
 * turn (BST-1408), and recording which one fired is what makes the failure
 * class provable from a debug bundle instead of reconstructible by inference.
 */
export type StreamStallPhase = 'first-part' | 'inter-part';

/**
 * The two DELIBERATELY decoupled silence budgets. Resolved together (and
 * order-checked) by `resolveAssistantResilienceConfig`; see
 * `../config/resilience-config.ts` for why they must not be re-merged.
 */
export interface StreamInactivityWindows {
  /** Budget from stream start until the FIRST part arrives. */
  readonly firstPartMs: number;
  /** Budget for every gap once at least one part has been delivered. */
  readonly interPartMs: number;
}

export interface StreamInactivityOptions<T> {
  /**
   * Name the part kind for the stall diagnostic. The watchdog is generic over
   * the stream element, so domain knowledge (Mastra part types) is supplied by
   * the caller rather than assumed here.
   */
  readonly describePart?: (part: T) => string | undefined;
  readonly onTimeout?: (error: StreamStalledError) => void;
}

export interface StreamStalledErrorContext {
  readonly lastPartType?: string | undefined;
  readonly partsSeen: number;
  readonly phase: StreamStallPhase;
}

export class StreamStalledError extends Error {
  readonly code = 'stream_inactivity_timeout';
  /** The window that actually expired — first-part or inter-part. */
  readonly inactivityMs: number;
  /** What the source last delivered, when the caller can name it. */
  readonly lastPartType: string | undefined;
  /** How many parts arrived before the silence. Zero implies `first-part`. */
  readonly partsSeen: number;
  readonly phase: StreamStallPhase;

  constructor(inactivityMs: number, context: StreamStalledErrorContext) {
    super(`Stream produced no output for ${inactivityMs}ms`);
    this.name = 'StreamStalledError';
    this.inactivityMs = inactivityMs;
    this.lastPartType = context.lastPartType;
    this.partsSeen = context.partsSeen;
    this.phase = context.phase;
  }
}

/**
 * Wrap an async iterable so that silence longer than the applicable window
 * throws {@link StreamStalledError}. The timer resets on every delivered item.
 * Used around the raw Mastra stream so a wedged provider/tool can never freeze
 * the data-stream session forever.
 *
 * The window is PHASE-AWARE: `firstPartMs` governs the wait for the very first
 * item, `interPartMs` every gap after it. The two answer different questions —
 * "has the provider started answering?" versus "is it still delivering?" — and
 * a cold request with a large prompt at high reasoning effort routinely spends
 * minutes on the former while a mid-stream gap that long is genuinely
 * suspicious.
 */
export async function* withInactivityTimeout<T>(
  source: AsyncIterable<T>,
  windows: StreamInactivityWindows,
  options?: StreamInactivityOptions<T>
): AsyncIterableIterator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let partsSeen = 0;
  let lastPartType: string | undefined;
  try {
    while (true) {
      const phase: StreamStallPhase = partsSeen === 0 ? 'first-part' : 'inter-part';
      const windowMs = phase === 'first-part' ? windows.firstPartMs : windows.interPartMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watchdog = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new StreamStalledError(windowMs, { lastPartType, partsSeen, phase });
          // Settle the watchdog rejection first so aborting the source cannot
          // win the Promise.race and disguise a real stall as normal EOF.
          reject(error);
          options?.onTimeout?.(error);
        }, windowMs);
        (timer as { unref?: () => void }).unref?.();
      });
      try {
        const result = await Promise.race([iterator.next(), watchdog]);
        if (result.done) {
          return;
        }
        partsSeen += 1;
        lastPartType = options?.describePart?.(result.value);
        yield result.value;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    }
  } finally {
    // Signal cleanup to the source iterator. We do NOT await the return()
    // promise because, if the source is suspended on a never-resolving await,
    // an awaited return() deadlocks. Calling without await is sufficient to
    // signal the generator to run its own finally blocks when it next resumes.
    iterator.return?.();
  }
}
