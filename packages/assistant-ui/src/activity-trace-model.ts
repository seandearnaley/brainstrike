import { isGuardedToolError } from '@brainstrike/assistant-contract';
import { isDeclinedToolCallResult } from '@brainstrike/assistant-contract/tool-approval';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract/tool-metadata';
import { type ActivityVerb, verbForTool } from './activity-verbs';
import {
  narrowRunPythonDisplayResult,
  type RunPythonDisplayResult,
} from './run-python-result-model';
import { isToolCallPart } from './tool-activity';
import { extractPrimaryArg } from './tool-summaries';

export type ActivityStepKind = 'reasoning' | 'tool';
export type ActivityStepState = 'cancelled' | 'done' | 'failed' | 'running' | 'waiting';

export interface ActivityStep {
  readonly durationMs: number | undefined;
  readonly id: string;
  readonly kind: ActivityStepKind;
  readonly partIndex: number;
  readonly state: ActivityStepState;
  /** `extractPrimaryArg(...).display` for tools (middle-ellipsised past 64
      chars); null for reasoning. Render-only — never dedupe on this. */
  readonly target: string | null;
  /** `extractPrimaryArg(...).full` (untruncated) for tools; null for
      reasoning. Distinct-target counts (edited/read N files) key on this,
      since two long paths can share `target`'s display after ellipsising. */
  readonly targetKey: string | null;
  readonly verb: ActivityVerb;
}

export interface ActivityCounts {
  readonly failed: number;
  readonly steps: number;
}

export interface ActivitySummary {
  readonly counts: ActivityCounts;
  readonly live: string;
  /** The resting HEADLINE: `verbs`, or the `Worked`/`Thought` placeholder. */
  readonly resting: string;
  /**
   * The verb summary alone, or null when NO tool step settled. Distinct from
   * `resting` on purpose: the header demotes the verb summary to a
   * `· <verbs>` meta segment when `Stopped`/`Activity failed` takes the
   * headline, and demoting `resting` there put the placeholder on screen as
   * "Stopped after 4.0s · Worked · 1 step" (review finding 1).
   */
  readonly verbs: string | null;
  /**
   * The run is paused on the USER: a gated step exists and no tool step is
   * still executing. Deliberately narrower than the `Waiting for approval`
   * label (a gate wins the label race even while a sibling call runs) —
   * `activity-trace.tsx` gates the elapsed clock and the sr-announcement on
   * this, so real concurrent work still ticks.
   */
  readonly waiting: boolean;
}

const REASONING_VERB: ActivityVerb = Object.freeze({
  active: 'Thinking',
  done: 'Thought',
  family: 'other',
});
const MAX_RESTING_VERBS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function statusOf(part: Record<string, unknown>): { reason?: unknown; type?: unknown } | undefined {
  const status = part['status'];
  return isRecord(status) ? status : undefined;
}

/** The message a result-level `isError` flag implies; it states none of its own. */
export const TOOL_EXECUTION_FAILED_MESSAGE = 'Tool execution failed.';

/**
 * THE reader of "this settled result states its own failure" — and of the
 * message it states, since those are one question, not two (bot round 1,
 * Claude Important 2). The card's error line and the trace's failed verdict
 * used to be two copies of the same shape list (`readResultErrorMessage` in
 * `tool-fallback.tsx`), and they had already drifted: on an `ok: true`
 * envelope the message reader returned the advisory string while the state
 * reader called the step failed.
 *
 * The success discriminator is read FIRST and is final: `ok: true` means the
 * tool says it succeeded, so an `error` member beside it is advisory domain
 * data and this returns null — `{ ok: true, error: 'warning: deprecated
 * flag' }` must never read Failed (the surviving half of the BST-1679
 * ruling). Otherwise the recognised shapes are the ones the card's error line
 * has always rendered beyond the guarded envelope: a non-empty `error`
 * string, an `ok: false` envelope whose `error.message` explains it, and a
 * result-level `isError` flag, which carries no message of its own and takes
 * the generic one.
 *
 * It lives HERE, not only in the card, because both surfaces derive from it
 * (BST-1681 phase 3): while the card read these as Failed and the trace read
 * them as `done`, one step showed a red error line under a headline that
 * counted it a success.
 */
export function readResultError(result: unknown): string | null {
  if (!isRecord(result) || Array.isArray(result)) {
    return null;
  }
  if (result['ok'] === true) {
    return null;
  }
  const error = result['error'];
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  if (result['ok'] === false && isRecord(error) && !Array.isArray(error)) {
    const message = error['message'];
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  return result['isError'] === true ? TOOL_EXECUTION_FAILED_MESSAGE : null;
}

/** Whether {@link readResultError} finds a stated failure in this result. */
function statesResultError(result: unknown): boolean {
  return readResultError(result) !== null;
}

/**
 * BST-1070: the reading of a SETTLED `run_python` result. The generic path
 * renders a green check for any error-free result, which would lie for three
 * of this tool's arms: cancelled/timed-out/killed runs did not complete
 * (design rule: cancelled NEVER renders as success) and an `unavailable`
 * result means nothing ran at all (destructive). A non-zero exit stays `done`
 * — the tool call completed; the result surface right below carries the amber
 * "finished with an error".
 */
export function runPythonStepState(result: RunPythonDisplayResult): ActivityStepState {
  switch (result.kind) {
    case 'completed':
      return 'done';
    case 'unavailable':
      return 'failed';
    default:
      // timed_out / killed / cancelled / network_denied / declined: the run
      // stopped without completing — network_denied and declined by the
      // user's explicit choice.
      return 'cancelled';
  }
}

/**
 * The two readings a SETTLED result can make on top of a generic `done`.
 * Both used to be card-only overrides in `tool-fallback.tsx`, which is how a
 * declined call came to read `Stopped` on its card and count as a `Completed`
 * step in the trace headline at the same time (Task 4 review, Minor 1).
 * Neither may ever weaken a non-`done` generic verdict — see the call site.
 */
function settledResultOverride(input: {
  readonly result: unknown;
  /** Enables the tool's own settled reading (today: `run_python`). */
  readonly toolName: string | undefined;
}): ActivityStepState {
  const { result, toolName } = input;
  // BST-1282: a call the user DECLINED at its approval gate settles with the
  // shared `DeclinedToolCallResult` envelope and no error flag. Left alone it
  // would earn a green Completed for a tool that never ran, so it takes the
  // muted `cancelled` treatment — never the destructive Failed, because
  // nothing broke. Tool-agnostic: the envelope is the shared contract shape.
  if (isDeclinedToolCallResult(result)) {
    return 'cancelled';
  }
  if (toolName !== NATIVE_TOOL_ID.runPython) {
    return 'done';
  }
  // Gated on the tool NAME, not on the result shape: `{kind: 'unavailable'}`
  // is ordinary domain data for some other tool, and must not inherit
  // run_python's destructive reading. A shape that fails narrowing (malformed
  // or future) stays `done` rather than inventing a state.
  const runPython = narrowRunPythonDisplayResult(result);
  return runPython ? runPythonStepState(runPython) : 'done';
}

/**
 * THE state machine for a tool step. Every surface that draws one resolves
 * here, so a step can never read two different states in two places:
 * `assistant-activity-parts.tsx` via `deriveActivitySteps` (the trace
 * headline, the step rows and the group's counts), `tool-fallback-state.ts`
 * via `resolveCardStatus`, plus `todo-progress.tsx`'s task-list card and
 * `subagent-execution-card.tsx`. There are NO card-only overrides left: the
 * declined envelope and the settled `run_python` reading both moved here
 * (Task 4 review, Minor 1). The subagent card's `no-answer` is the one
 * refinement outside this function, and it too rides strictly on top of a
 * generic `done` — it reads the delegation's own result shape, which is not a
 * tool-step signal at all.
 *
 * Canonical signals only (repo rule): status type/reason, the part's `isError`
 * flag, a guarded error envelope, or a result that states its own error.
 * Exposed as a plain input record so the card can call it with the props it
 * already has, instead of assembling a fake part.
 *
 * ORDER is load-bearing: the tool-specific readings apply ONLY once the
 * generic branches have resolved to `done`. `running`, `waiting` and the
 * incomplete states must keep winning, or a transport abort's `status.error`
 * would vanish behind a Completed/Stopped step and a still-running call would
 * lose its live mark.
 */
export function toolStepStateFor(input: {
  readonly isError?: boolean;
  readonly result?: unknown;
  readonly status?: { readonly reason?: unknown; readonly type?: unknown } | undefined;
  /** Enables the tool's own settled reading (today: `run_python`). */
  readonly toolName?: string;
}): ActivityStepState {
  const { status } = input;
  if (status?.type === 'running') {
    return 'running';
  }
  if (status?.type === 'requires-action') {
    return 'waiting';
  }
  if (status?.type === 'incomplete') {
    return status.reason === 'cancelled' ? 'cancelled' : 'failed';
  }
  // ORDERING HAZARD (bot round 1, Claude Minor 6): `statesResultError` runs
  // BEFORE `settledResultOverride`, so a tool whose own settled reading lives
  // there cannot soften a result that states an error — a `run_python` payload
  // carrying a non-empty `error` string would read `failed` here and never
  // reach `runPythonStepState`. That is the right precedence today (a stated
  // error is a stated error), but a tool-specific reading that needs to WIN
  // over it has to move above this branch, not into the override.
  if (
    input.isError === true ||
    isGuardedToolError(input.result) ||
    statesResultError(input.result)
  ) {
    return 'failed';
  }
  if (status === undefined && input.result === undefined) {
    return 'running';
  }
  return settledResultOverride({ result: input.result, toolName: input.toolName });
}

/** The part-record entry point into {@link toolStepStateFor}. */
function toolStepState(part: Record<string, unknown>, toolName: string): ActivityStepState {
  return toolStepStateFor({
    isError: part['isError'] === true,
    result: part['result'],
    status: statusOf(part),
    toolName,
  });
}

function reasoningStepState(part: Record<string, unknown>): ActivityStepState {
  return statusOf(part)?.type === 'running' ? 'running' : 'done';
}

export function deriveActivitySteps(
  parts: readonly unknown[],
  durations: Readonly<Record<string, number>>
): readonly ActivityStep[] {
  const steps: ActivityStep[] = [];
  for (const [partIndex, part] of parts.entries()) {
    if (isToolCallPart(part)) {
      const toolCallId =
        typeof part['toolCallId'] === 'string' ? part['toolCallId'] : `tool-${partIndex}`;
      const toolName =
        typeof part['toolName'] === 'string' && part['toolName'].length > 0
          ? part['toolName']
          : 'tool';
      const argsText = typeof part['argsText'] === 'string' ? part['argsText'] : undefined;
      const primaryArg = extractPrimaryArg(part['args'], argsText);
      steps.push({
        durationMs: durations[toolCallId],
        id: toolCallId,
        kind: 'tool',
        partIndex,
        state: toolStepState(part, toolName),
        target: primaryArg?.display ?? null,
        targetKey: primaryArg?.full ?? null,
        verb: verbForTool(toolName),
      });
      continue;
    }
    if (isRecord(part) && part['type'] === 'reasoning') {
      steps.push({
        durationMs: undefined,
        id: `reasoning-${partIndex}`,
        kind: 'reasoning',
        partIndex,
        state: reasoningStepState(part),
        target: null,
        targetKey: null,
        verb: REASONING_VERB,
      });
    }
  }
  return steps;
}

function liveLabel(steps: readonly ActivityStep[]): string {
  const waiting = steps.findLast((step) => step.state === 'waiting');
  if (waiting) {
    return 'Waiting for approval';
  }
  const runningTool = steps.findLast((step) => step.kind === 'tool' && step.state === 'running');
  if (runningTool) {
    return runningTool.target
      ? `${runningTool.verb.active} ${runningTool.target}`
      : runningTool.verb.active;
  }
  if (steps.some((step) => step.kind === 'reasoning' && step.state === 'running')) {
    return 'Thinking';
  }
  return 'Working';
}

function lowerInitial(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

/**
 * Whether the resting phrase folds a distinct-target file count in. The
 * decision is the VERB's own `countsFiles` flag, never its family: `read`
 * covers directory listings, artifact reads and context reads too, whose
 * targets are not files (review finding — those read "Listed 2 files").
 */
function foldsFileCount(verb: ActivityVerb | undefined, fileCount: number): boolean {
  if (verb?.countsFiles === 'always') {
    return fileCount > 0;
  }
  return verb?.countsFiles === 'plural' && fileCount > 1;
}

/**
 * The verb summary, or null when nothing settled (a cancelled/still-running
 * group). Cancelled steps are deliberately NOT settled: a cancelled call did
 * not do the thing its done-verb claims.
 */
function verbSummary(steps: readonly ActivityStep[]): string | null {
  const settled = steps.filter(
    (step) => step.kind === 'tool' && (step.state === 'done' || step.state === 'failed')
  );
  if (settled.length === 0) {
    return null;
  }
  const targetsByVerb = new Map<string, Set<string>>();
  // Keyed on `verb.done` alone: assumes no `done` string is shared by two
  // families (e.g. two distinct native tools both reading "Read"). True
  // today by inspection of TOOL_VERBS — if that ever changes, key on
  // `${family}:${done}` instead so unrelated families don't merge counts.
  const verbByDone = new Map<string, ActivityVerb>();
  for (const step of settled) {
    const key = step.verb.done;
    const targets = targetsByVerb.get(key) ?? new Set<string>();
    // Dedupe on the untruncated `targetKey`, not the display-capped
    // `target` — two long paths that share a head/tail after 64-char
    // middle-ellipsising must still count as two distinct files.
    if (step.targetKey) {
      targets.add(step.targetKey);
    }
    targetsByVerb.set(key, targets);
    verbByDone.set(key, step.verb);
  }
  const phrases = [...targetsByVerb.entries()].map(([verbDone, targets]) => {
    const fileCount = targets.size;
    if (!foldsFileCount(verbByDone.get(verbDone), fileCount)) {
      return verbDone;
    }
    return `${verbDone} ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;
  });
  const shown = phrases.slice(0, MAX_RESTING_VERBS);
  const rest = phrases.length - shown.length;
  const joined = shown
    .map((phrase, index) => (index === 0 ? phrase : lowerInitial(phrase)))
    .join(', ');
  return rest > 0 ? `${joined} +${rest} more` : joined;
}

/** The headline stand-in when no verb summary exists. */
function restingPlaceholder(steps: readonly ActivityStep[]): string {
  return steps.some((step) => step.kind === 'reasoning') ? 'Thought' : 'Worked';
}

export function summarizeActivity(steps: readonly ActivityStep[]): ActivitySummary {
  const toolSteps = steps.filter((step) => step.kind === 'tool');
  const verbs = verbSummary(steps);
  return {
    counts: {
      failed: toolSteps.filter((step) => step.state === 'failed').length,
      steps: toolSteps.length,
    },
    live: liveLabel(steps),
    resting: verbs ?? restingPlaceholder(steps),
    verbs,
    waiting:
      steps.some((step) => step.state === 'waiting') &&
      !toolSteps.some((step) => step.state === 'running'),
  };
}
