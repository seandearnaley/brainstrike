/**
 * Which silence killed the stream.
 *
 * `awaiting-output` — the provider has not produced anything yet FOR THE
 * CURRENT STEP. `streaming` — it started and then went quiet.
 *
 * Not once per stream: time-to-first-output recurs at every step, because the
 * framework opens each one before the provider answers (see
 * {@link StreamInactivityOptions.countsAsProviderOutput}). Conflating the two
 * silences killed a healthy 18-minute turn (BST-1408), and recording which one
 * fired is what makes the failure class provable from a debug bundle instead of
 * reconstructible by inference.
 */
export type StreamStallPhase = 'awaiting-output' | 'streaming';

/**
 * The two DELIBERATELY decoupled silence budgets. Resolved together (and
 * order-checked) by `resolveAssistantResilienceConfig`; see
 * `../config/resilience-config.ts` for why they must not be re-merged.
 */
export interface StreamInactivityWindows {
  /** Budget for the provider to produce its first output in each step. */
  readonly firstOutputMs: number;
  /** Budget for every gap once the provider is demonstrably producing output. */
  readonly interOutputMs: number;
}

export interface StreamInactivityOptions<T> {
  /**
   * Whether a part is PROVIDER output, as opposed to framework scaffolding.
   *
   * This is the whole reason the phase means anything. Measured against the
   * real `@mastra/core` loop, a turn's raw parts arrive as:
   *
   *     start       t+0ms      <- framework, instant
   *     step-start  t+7ms      <- framework, instant
   *     tool-call   t+312ms    <- provider, after 305ms of thinking
   *     ...
   *     step-start  t+321ms    <- framework, instant
   *     text-start  t+723ms    <- provider, after 402ms of thinking
   *
   * Treating any part as "the provider started" therefore ends the wide window
   * within milliseconds and measures every real time-to-first-token against the
   * tight one. Scaffolding parts keep the stream in `awaiting-output` AND
   * re-arm it, so each step gets its own budget.
   *
   * Absent means every part counts as output — the honest default for a caller
   * with no framework prologue to discount.
   */
  readonly countsAsProviderOutput?: (part: T) => boolean;
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
  /** The window that actually expired — first-output or inter-output. */
  readonly inactivityMs: number;
  /**
   * The last part the caller could NAME, which is not necessarily the last part
   * delivered: an undescribable part leaves the previous name in place rather
   * than erasing the breadcrumb, since "we saw 7 parts and cannot say what any
   * of them were" is the reconstruct-by-inference state this exists to remove.
   */
  readonly lastPartType: string | undefined;
  /**
   * Every part delivered before the silence, scaffolding included — it is
   * transport activity, and `partsSeen: 2` next to `phase: 'awaiting-output'`
   * is precisely the "prologue arrived, provider never did" story.
   */
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
 * The window is PHASE-AWARE: `firstOutputMs` governs the wait for the provider
 * to say anything in the current step, `interOutputMs` every gap once it has.
 * The two answer different questions — "has the provider started answering?"
 * versus "is it still delivering?" — and a request with a large prompt at high
 * reasoning effort routinely spends minutes on the former, in EVERY step, while
 * a gap that long mid-output is genuinely suspicious.
 */
export async function* withInactivityTimeout<T>(
  source: AsyncIterable<T>,
  windows: StreamInactivityWindows,
  options?: StreamInactivityOptions<T>
): AsyncIterableIterator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let partsSeen = 0;
  let lastPartType: string | undefined;
  let phase: StreamStallPhase = 'awaiting-output';
  try {
    while (true) {
      const windowMs = phase === 'awaiting-output' ? windows.firstOutputMs : windows.interOutputMs;
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
        lastPartType = options?.describePart?.(result.value) ?? lastPartType;
        // Scaffolding both KEEPS and RE-ARMS the wide window: a fresh step has
        // its own time-to-first-output, so a step opened after a tool result
        // must not inherit the previous step's `streaming` phase.
        const isOutput = options?.countsAsProviderOutput?.(result.value) ?? true;
        phase = isOutput ? 'streaming' : 'awaiting-output';
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
