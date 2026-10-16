import {
  type AssistantRunEvent,
  readAssistantRunEventDataPart,
} from '@brainstrike/assistant-contract';

function runEventTimestamp(data: AssistantRunEvent): number | undefined {
  const timestamp = Date.parse(data.timestamp);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/**
 * The producer's measured execution time, when it stamped one.
 *
 * The `typeof`/finite checks are TYPE NARROWING, not validation: a non-numeric
 * or non-finite `durationMs` never reaches here, because it is not valid JSON
 * and `readAssistantRunEventDataPart` drops the whole event first (verified —
 * a string and a NaN both make the event vanish, not the field). Only the
 * NEGATIVE case is reachable — from an OLD persisted event, since the producer
 * now measures with a monotonic clock (`performance.now()`) and can no longer
 * emit one — and it falls back to the timestamp delta rather than rendering a
 * negative duration.
 *
 * ZERO is a real value, not an absence: a DECLINED approval-gated call is
 * stamped 0 because the tool is known not to have run. Treating it as falsy
 * would fall back to the gap, i.e. the human's deliberation time.
 */
function runEventDurationMs(data: AssistantRunEvent): number | undefined {
  const durationMs = data.durationMs;
  return typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
    ? durationMs
    : undefined;
}

function runEventToolCallId(data: AssistantRunEvent): string | undefined {
  const toolCallId = data.metadata?.['toolCallId'];
  return typeof toolCallId === 'string' ? toolCallId : undefined;
}

/**
 * Map each tool call's id to its execution time (ms).
 *
 * PREFERS the producer's own `durationMs` on the terminal event. The agent's
 * guard wrapper measures around the real `execute` and stamps it (see
 * `tool-execution-durations.ts` in @brainstrike/agent), which is the only
 * honest number for an APPROVAL-GATED call: `tool.started` comes from Mastra's
 * `tool-call` part — when the MODEL emits the call — and the gate then suspends
 * the run before `execute` is ever invoked. The terminal event arrives on the
 * resume leg, so the timestamp gap spans however long a human took to click
 * Approve; a two-second script behind a five-minute approval read as five
 * minutes.
 *
 * That is why `durationMs` exists and why it wins here: it is measured at the
 * producer around the real `execute`, so it is independent of which run events
 * survived and of how long the human took.
 *
 * HISTORY, because this comment used to say the opposite. It claimed the resume
 * leg emits `tool.completed` FIRST with no second `tool.started`, and that
 * nothing downstream could repair the deliberation gap. That was true when
 * written and was FALSE since BST-1440: the shipped resume leg synthesised a
 * `tool.started` (`makeResumedStartChunks` in
 * `packages/agent/src/mastra/agent-streaming.ts`, routed through the shared
 * lifecycle seam; removed with ADR-0022) so the Threads panel's "needs you"
 * signal could clear when the user ANSWERED rather than when the tool
 * finished.
 *
 * What that changes here, precisely:
 *   - `durationMs` PRESENT — the normal path for anything this build produced —
 *     is unaffected. It wins outright before `startedAt` is ever consulted, so
 *     the extra start event is inert.
 *   - `durationMs` ABSENT is now MORE accurate, not less. The resume-leg
 *     `tool.started` overwrites the pausing leg's entry (parts are in append
 *     order), so the delta spans the resumed execution instead of the human's
 *     deliberation. The old comment's "nothing downstream can repair that" no
 *     longer holds — a two-second script behind a five-minute approval reads as
 *     two seconds on this path too.
 * Both branches are pinned in `__tests__/tool-durations.test.ts`.
 *
 * FALLS BACK to the `tool.started` → terminal timestamp delta when there is no
 * `durationMs` — an older persisted thread, or a runtime that did not record.
 * Never a fabricated value.
 * Pure + unit-tested against realistic event shapes.
 */
export function collectToolDurations(parts: readonly unknown[]): Record<string, number> {
  const startedAt = new Map<string, number>();
  const durations: Record<string, number> = {};

  for (const part of parts) {
    const data = readAssistantRunEventDataPart(part);
    if (!data) {
      continue;
    }
    const kind = data.kind;
    // Allowlist, not a denylist — every other `tool.*` kind is ignored on
    // purpose. `tool.approval.requested` (BST-1402) carries the paused call's
    // `toolCallId` but is NOT a lifecycle start: opening a window on it would
    // clock the USER's deliberation as tool execution, and closing one on it
    // would time a call that never ran. `tool.resume.unsupported` (BST-558) is
    // excluded for the mirror-image reason (the tool is still suspended).
    if (kind !== 'tool.started' && kind !== 'tool.completed' && kind !== 'tool.failed') {
      continue;
    }
    const toolCallId = runEventToolCallId(data);
    const timestamp = runEventTimestamp(data);
    if (toolCallId === undefined || timestamp === undefined) {
      continue;
    }
    if (kind === 'tool.started') {
      startedAt.set(toolCallId, timestamp);
      continue;
    }
    // The producer's measurement wins outright: it is the real execution
    // window, and it does not need a start event to have survived.
    const measured = runEventDurationMs(data);
    if (measured !== undefined) {
      durations[toolCallId] = measured;
      continue;
    }
    const start = startedAt.get(toolCallId);
    if (start !== undefined && timestamp >= start) {
      durations[toolCallId] = timestamp - start;
    }
  }

  return durations;
}

/** Human duration: `420ms`, `3.4s`, `1m 12s`. */
export function formatActivityDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}
