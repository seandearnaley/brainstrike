/**
 * Per-run record of how long each tool's `execute` ACTUALLY ran.
 *
 * Exists because wall-clock between a tool's `tool.started` and its terminal
 * run event is not execution time for an approval-gated call. `tool.started` is
 * emitted from Mastra's `tool-call` part — when the MODEL emits the call — and
 * the gate then SUSPENDS the run before `execute` is ever invoked. The terminal
 * event arrives on the resume leg, so the gap spans however long a human took
 * to click Approve: a two-second script behind a five-minute approval reads as
 * a five-minute tool call.
 *
 * The producer is the only place that number is knowable independent of which
 * run events survived, which is why it has to put it on the wire.
 *
 * HISTORY, because this comment used to assert the opposite. It said the resume
 * leg emits only `tool.completed, run.step.finished, run.step.started,
 * run.step.finished, run.finished` — "no second `tool.started`", with
 * `tool.completed` FIRST on the leg, so nothing precedes it that a consumer
 * could treat as an execution-start marker. True when measured; FALSE since
 * BST-1440, which makes the resume leg synthesise a `tool.started`
 * (`makeResumedStartChunks` in `../mastra/agent-streaming.ts`) so the Threads
 * panel's "needs you" signal clears when the user ANSWERS rather than when the
 * tool finishes.
 *
 * That does NOT make this module redundant. `durationMs` still wins outright in
 * `collectToolDurations`, so the measured value is what users see; the resumed
 * start only improves the fallback for events that carry no measurement. The
 * remaining claims stand: no `run.resumed` (both approval paths run
 * `maxAttempts: 1`, so the stall loop never reaches the attempt that emits it)
 * and no `run.started` (Mastra's `resumeStream` emits no `start` part).
 *
 * Scope is per RUNTIME, which is per request: `initializeMastraRuntime` is the
 * single construction point and the approval resume builds its own. The guard
 * wrapper writes on the leg where `execute` runs, and the stream mapper on that
 * same leg reads it — so a resumed call reports the time it actually spent
 * working, not the time a human spent deciding.
 */
export interface ToolExecutionDurations {
  /** Elapsed ms for a completed call, or `undefined` if none was recorded. */
  read(toolCallId: string): number | undefined;
  record(toolCallId: string, durationMs: number): void;
}

export function createToolExecutionDurations(): ToolExecutionDurations {
  const byToolCallId = new Map<string, number>();
  return {
    read(toolCallId) {
      return byToolCallId.get(toolCallId);
    },
    record(toolCallId, durationMs) {
      // A retried/duplicated call id keeps the LATEST measurement: the terminal
      // event a consumer is about to label belongs to the most recent execution.
      byToolCallId.set(toolCallId, durationMs);
    },
  };
}
