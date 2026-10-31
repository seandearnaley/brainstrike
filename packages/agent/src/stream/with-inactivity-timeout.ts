/**
 * Which silence killed the stream.
 *
 * `awaiting-output` — the provider has not produced anything yet FOR THE
 * CURRENT STEP. `reasoning` — it is emitting thought, not yet an answer.
 * `streaming` — it is delivering the answer and then went quiet.
 *
 * Not once per stream: time-to-first-output recurs at every step, because the
 * framework opens each one before the provider answers (see
 * {@link StreamInactivityOptions.countsAsProviderOutput}). Conflating the two
 * silences killed a healthy 18-minute turn (BST-1408), and recording which one
 * fired is what makes the failure class provable from a debug bundle instead of
 * reconstructible by inference.
 *
 * `reasoning` is the third silence, and it exists because the two-way split was
 * still one distinction short. A reasoning delta says the model is THINKING,
 * not that it has begun answering — so treating it as ordinary output armed the
 * tight inter-output window against exactly the pauses high reasoning effort is
 * made of. That killed `google/gemini-3.7-flash` at `effort: 'high'` on both
 * attempts of a turn, each time with `lastPartType: 'reasoning-delta'`.
 *
 * Every phase is the provider's: tool execution is not judged at all (see
 * {@link ToolExecutions}).
 */
export type StreamStallPhase = 'awaiting-output' | 'reasoning' | 'streaming';

/**
 * The three DELIBERATELY decoupled silence budgets. Resolved together (and
 * order-checked) by `resolveAssistantResilienceConfig`; see
 * `../config/resilience-config.ts` for why they must not be re-merged.
 */
export interface StreamInactivityWindows {
  /** Budget for the provider to produce its first output in each step. */
  readonly firstOutputMs: number;
  /** Budget for every gap once the provider is demonstrably ANSWERING. */
  readonly interOutputMs: number;
  /**
   * Budget for a gap while the provider is demonstrably THINKING.
   *
   * Governed separately from {@link interOutputMs} because a pause between
   * reasoning deltas is the same event as a pause before the first one — the
   * model is working and has not started its answer — and {@link firstOutputMs}
   * already exists to cover precisely that.
   */
  readonly reasoningGapMs: number;
}

/**
 * The tool calls the stream's producer is executing, as the AI SDK reports
 * them (`onToolExecutionStart` / `onToolExecutionEnd`).
 *
 * While any runs, the stream waits without a window, as the SDK's own `chunkMs`
 * never runs during tool execution: each tool is bounded by its own guard, and
 * a delegated child by its own run (ADR-0009).
 */
export class ToolExecutions {
  readonly #running = new Set<string>();
  readonly #listeners = new Set<() => void>();

  get running(): boolean {
    return this.#running.size > 0;
  }

  start(toolCallId: string): void {
    this.#change(() => this.#running.add(toolCallId));
  }

  end(toolCallId: string): void {
    this.#change(() => this.#running.delete(toolCallId));
  }

  /** Call `listener` whenever {@link running} flips; returns its release. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #change(apply: () => void): void {
    const was = this.running;
    apply();
    if (this.running === was) {
      return;
    }
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }
}

export interface StreamInactivityOptions<T> {
  /**
   * Whether a part is PROVIDER output, as opposed to framework scaffolding.
   *
   * This is the whole reason the phase means anything. The AI SDK opens the
   * stream and each step with its own parts (`start`, `start-step`,
   * `finish-step`) around the provider's output, so a step's first real
   * output can come minutes after the parts that frame it.
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
   * the stream element, so domain knowledge (SDK part types) is supplied by
   * the caller rather than assumed here.
   */
  readonly describePart?: (part: T) => string | undefined;
  readonly onTimeout?: (error: StreamStalledError) => void;
  /**
   * Classify a REASONING part, or `undefined` for anything that is not one.
   *
   * Reasoning is provider output — it must never re-arm the first-output
   * window — but it is not an answer, so the gaps around it are the model
   * working, not a wedged transport.
   *
   * `'content'` (a thinking delta) ENTERS the reasoning phase. `'marker'`
   * (block bookkeeping such as `reasoning-end`) PRESERVES whatever phase is
   * already in effect, and that distinction is load-bearing: providers exist
   * that emit `text-start` BEFORE `reasoning-end`, so a marker that set the
   * phase would widen the window back out just as the answer began. Preserving
   * instead keeps a no-answer-yet stream wide and an already-answering stream
   * tight, which is what each case actually needs.
   *
   * Absent means no part is reasoning — the honest default for a caller that
   * cannot tell, which reproduces the pre-existing two-phase behaviour rather
   * than silently widening any window.
   */
  readonly reasoningPartKind?: (part: T) => 'content' | 'marker' | undefined;
  /** The producer's running tools. Absent means every silence is the provider's. */
  readonly toolExecutions?: ToolExecutions;
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

/** The user-visible stall text, naming WHICH silence fired. */
export function describeStreamStall(error: StreamStalledError): string {
  if (error.phase === 'awaiting-output') {
    return `The model produced no output within ${error.inactivityMs}ms of the request starting.`;
  }
  if (error.phase === 'reasoning') {
    // "stalled without output" would be actively wrong here: the model WAS
    // producing output — reasoning — and then stopped mid-thought. Naming the
    // phase also points at the one setting that changes this outcome.
    return `The model stopped mid-reasoning, producing nothing further for ${error.inactivityMs}ms. Retry, or lower the reasoning effort if it recurs.`;
  }
  return `The model stream stalled after ${error.inactivityMs}ms without output.`;
}

function resolveWindowMs(phase: StreamStallPhase, windows: StreamInactivityWindows): number {
  if (phase === 'awaiting-output') {
    return windows.firstOutputMs;
  }
  if (phase === 'reasoning') {
    return windows.reasoningGapMs;
  }
  return windows.interOutputMs;
}

/**
 * Classify the part just delivered into the phase the NEXT silence is measured
 * against.
 *
 * Order matters: reasoning is checked before the generic output test, because
 * a reasoning part satisfies both (it IS provider output) and the narrower
 * answer is the correct one. Scaffolding both KEEPS and RE-ARMS the wide
 * window: a fresh step has its own time-to-first-output.
 */
function resolveNextPhase<T>(
  part: T,
  currentPhase: StreamStallPhase,
  options: StreamInactivityOptions<T> | undefined
): StreamStallPhase {
  const isOutput = options?.countsAsProviderOutput?.(part) ?? true;
  if (!isOutput) {
    return 'awaiting-output';
  }
  const reasoningKind = options?.reasoningPartKind?.(part);
  if (reasoningKind === 'content') {
    return 'reasoning';
  }
  if (reasoningKind === 'marker') {
    return currentPhase;
  }
  return 'streaming';
}

/** A tool started or the last one ended while the stream waited: judge the wait again. */
const TOOLS_CHANGED = Symbol('tool-executions-changed');

/**
 * Wrap an async iterable so that silence longer than the applicable window
 * throws {@link StreamStalledError}. The timer resets on every delivered item.
 * Used around the raw model stream so a wedged provider can never freeze the
 * run forever.
 *
 * The window is PHASE-AWARE, because "the provider is quiet" is several
 * different events:
 *
 * - `awaiting-output` → `firstOutputMs`. Has it started at all this step?
 * - `reasoning` → `reasoningGapMs`. It is thinking; has it stopped thinking?
 * - `streaming` → `interOutputMs`. It is answering; is it still delivering?
 *
 * The first two are the same question wearing different hats — the model is
 * working and has not begun its answer — which is why they share a budget
 * scale. Only the third asks whether a demonstrably-answering provider went
 * silent, and only there is a two-minute gap genuinely suspicious.
 *
 * Collapsing the first two into the third killed a healthy 18-minute turn
 * (BST-1408). Collapsing `reasoning` into `streaming` then killed
 * `google/gemini-3.7-flash` at `effort: 'high'`, twice in one turn, both times
 * on `lastPartType: 'reasoning-delta'`.
 *
 * While {@link ToolExecutions} has a tool running, the wait has no window.
 */
export async function* withInactivityTimeout<T>(
  source: AsyncIterable<T>,
  windows: StreamInactivityWindows,
  options?: StreamInactivityOptions<T>
): AsyncIterableIterator<T> {
  const iterator = source[Symbol.asyncIterator]();
  const tools = options?.toolExecutions;
  let partsSeen = 0;
  let lastPartType: string | undefined;
  let phase: StreamStallPhase = 'awaiting-output';
  // One read stays pending across re-judged waits: a tool change must never
  // start a second `next()` on the source.
  let pending: Promise<IteratorResult<T>> | undefined;
  try {
    while (true) {
      pending ??= iterator.next();
      const waitPhase = phase;
      const windowMs = resolveWindowMs(waitPhase, windows);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let releaseTools: (() => void) | undefined;
      const racers: Promise<IteratorResult<T> | typeof TOOLS_CHANGED>[] = [pending];
      if (!tools?.running) {
        racers.push(
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              const error = new StreamStalledError(windowMs, {
                lastPartType,
                partsSeen,
                phase: waitPhase,
              });
              // Settle the watchdog rejection first so aborting the source cannot
              // win the Promise.race and disguise a real stall as normal EOF.
              reject(error);
              options?.onTimeout?.(error);
            }, windowMs);
            (timer as { unref?: () => void }).unref?.();
          })
        );
      }
      if (tools) {
        racers.push(
          new Promise<typeof TOOLS_CHANGED>((resolve) => {
            releaseTools = tools.subscribe(() => resolve(TOOLS_CHANGED));
          })
        );
      }
      try {
        const outcome = await Promise.race(racers);
        if (outcome === TOOLS_CHANGED) {
          continue;
        }
        pending = undefined;
        if (outcome.done) {
          return;
        }
        partsSeen += 1;
        lastPartType = options?.describePart?.(outcome.value) ?? lastPartType;
        phase = resolveNextPhase(outcome.value, phase, options);
        yield outcome.value;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
        releaseTools?.();
      }
    }
  } finally {
    // Signal cleanup to the source iterator. We do NOT await the return()
    // promise because, if the source is suspended on a never-resolving await,
    // an awaited return() deadlocks. Calling without await is sufficient to
    // signal the generator to run its own finally blocks when it next resumes.
    void iterator.return?.();
  }
}
