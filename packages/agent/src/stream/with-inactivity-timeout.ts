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
 * `tool-executing` — the provider finished a tool call and OUR tool is
 * running. The silence is not the provider's at all, so it is bounded by the
 * per-tool execution guard (which always fires first) and this phase carries
 * only a backstop against a broken guard (BST-1777). Measuring a running tool
 * against the tight `streaming` window is why the guard had to be a flat 60s —
 * under every tool's own declared budget.
 */
export type StreamStallPhase = 'awaiting-output' | 'reasoning' | 'streaming' | 'tool-executing';

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
  /**
   * Backstop while at least one tool call is executing. Derived to sit above
   * the largest budget the execution guard can grant; never user-visible
   * unless the guard itself is broken.
   */
  readonly toolExecutingMs: number;
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
  /**
   * Tool calls already known to be EXECUTING before the first part of this
   * stream is even read (BST-1777 final review, I1).
   *
   * A Mastra resume leg never replays the suspended step's `tool-call` part —
   * only the human's approval answer resumes it — so a call approved on a
   * PRIOR leg starts running on THIS leg with no `started` boundary for
   * {@link toolExecutionPartKind} to observe. Without seeding, the watchdog
   * measures that execution against `firstOutputMs` (the provider's own
   * silence budget) instead of `toolExecutingMs`, which is not just the wrong
   * number: `firstOutputMs` (600000ms) is SHORTER than the largest budget the
   * per-tool guard can grant (605000ms), so an execution that is still
   * healthy under its own guard would be killed here first, reported with the
   * wrong phase (`awaiting-output` instead of `tool-executing`) and the wrong
   * user-facing diagnosis (provider silence, not a broken execution guard).
   * The approval-resume leg this seed exists for runs at `maxAttempts: 1`
   * (see `attempt-legs.ts`, `createToolApprovalIteratorFromRuntime` — an
   * approval is consumed by `approveToolCall`/`declineToolCall` and cannot be
   * re-issued), so this is not about a stall being wrongly retried on THIS
   * leg — it cannot be, here — only about the misclassified phase and
   * message.
   *
   * Absent means no seed, which reproduces the pre-existing behaviour
   * exactly: `toolCallsInFlight` starts empty and the first phase is
   * `awaiting-output`, as it always was.
   */
  readonly initialToolCallIds?: readonly string[];
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
  /**
   * Classify a part that STARTS or SETTLES one tool execution, or `undefined`.
   *
   * Reference-counted by `toolCallId` so parallel calls hold the phase until
   * the last one settles. A part meaning "waiting on a human" (approval,
   * suspension) must be reported as `settled`: the tool is not executing.
   *
   * Absent means no part is a tool boundary, which reproduces the three-phase
   * behaviour rather than widening any window.
   */
  readonly toolExecutionPartKind?: (
    part: T
  ) => { readonly kind: 'started' | 'settled'; readonly toolCallId: string } | undefined;
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

function resolveWindowMs(phase: StreamStallPhase, windows: StreamInactivityWindows): number {
  if (phase === 'tool-executing') {
    return windows.toolExecutingMs;
  }
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
 * answer is the correct one.
 */
function resolveNextPhase<T>(
  part: T,
  currentPhase: Exclude<StreamStallPhase, 'tool-executing'>,
  options: StreamInactivityOptions<T> | undefined
): Exclude<StreamStallPhase, 'tool-executing'> {
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

/**
 * Track tool-execution boundaries by reference count. A part that STARTS a
 * call adds its id; a part that SETTLES one removes it. Settling an id that
 * was never added (a lost or out-of-order `started` part) is a no-op rather
 * than going negative — `Set.delete` on a missing key is already exactly that.
 */
function trackToolExecution<T>(
  part: T,
  inFlight: Set<string>,
  options: StreamInactivityOptions<T> | undefined
): void {
  const boundary = options?.toolExecutionPartKind?.(part);
  if (!boundary) {
    return;
  }
  if (boundary.kind === 'started') {
    inFlight.add(boundary.toolCallId);
    return;
  }
  inFlight.delete(boundary.toolCallId);
}

/**
 * Wrap an async iterable so that silence longer than the applicable window
 * throws {@link StreamStalledError}. The timer resets on every delivered item.
 * Used around the raw Mastra stream so a wedged provider/tool can never freeze
 * the data-stream session forever.
 *
 * The window is PHASE-AWARE across THREE states, because "the provider is
 * quiet" is three different events:
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
 */
export async function* withInactivityTimeout<T>(
  source: AsyncIterable<T>,
  windows: StreamInactivityWindows,
  options?: StreamInactivityOptions<T>
): AsyncIterableIterator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let partsSeen = 0;
  let lastPartType: string | undefined;
  const toolCallsInFlight = new Set<string>(options?.initialToolCallIds ?? []);
  // Seeding starts the FIRST wait already in `tool-executing` — otherwise a
  // resume leg's opening silence (before any part has been read at all) would
  // be measured against the provider window for the instant between "seeded"
  // and "first part observed".
  let phase: StreamStallPhase = toolCallsInFlight.size > 0 ? 'tool-executing' : 'awaiting-output';
  let providerPhase: Exclude<StreamStallPhase, 'tool-executing'> = 'awaiting-output';
  // A resume leg opens with framework scaffolding (`start`/`step-start`)
  // BEFORE the resumed call's `tool-result` — real output from Mastra's own
  // integration traces. The ordinary scaffolding-clear below would wipe a
  // SEEDED id on that very first `step-start`, before the call it was seeded
  // for ever gets to settle. Gating the clear on "has this leg produced any
  // real provider output yet" is the smallest fix: it only ever DELAYS when
  // the clear can fire, so the existing guarantee (a lost `settled` can only
  // tighten a LATER step's window) still holds once the leg is actually
  // underway.
  let hasSeenProviderOutput = false;
  try {
    while (true) {
      const windowMs = resolveWindowMs(phase, windows);
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
        providerPhase = resolveNextPhase(result.value, providerPhase, options);
        if (providerPhase !== 'awaiting-output') {
          hasSeenProviderOutput = true;
        }
        // Tool execution OVERRIDES the provider phases rather than joining
        // their state machine: while any call is in flight the silence belongs
        // to our tool, whatever part happened to arrive last. `providerPhase`
        // is tracked separately so a `reasoning-end` marker arriving mid-tool
        // cannot "preserve" `tool-executing` into the provider state machine.
        trackToolExecution(result.value, toolCallsInFlight, options);
        if (providerPhase === 'awaiting-output' && hasSeenProviderOutput) {
          // Scaffolding opens a new step, so the previous step's tools are
          // over. Clearing here means a lost `settled` part can only ever
          // TIGHTEN the next window, never hold the wide one open — gated on
          // `hasSeenProviderOutput` so a resume leg's OPENING scaffolding
          // cannot wipe a seeded id before its own settle ever arrives.
          toolCallsInFlight.clear();
        }
        phase = toolCallsInFlight.size > 0 ? 'tool-executing' : providerPhase;
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
