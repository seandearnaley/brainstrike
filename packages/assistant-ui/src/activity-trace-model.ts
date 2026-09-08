import { isGuardedToolError } from '@brainstrike/assistant-contract';
import { type ActivityVerb, verbForTool } from './activity-verbs';
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
  readonly resting: string;
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

/**
 * Canonical flags only (repo rule): status type/reason, `isError`, guarded
 * error. This is the phase-2 activity-trace state machine; the legacy
 * `summarizeToolActivity` (`tool-activity.ts`) it superseded was deleted with
 * `AssistantActivityGroup` (BST-1679).
 */
function toolStepState(part: Record<string, unknown>): ActivityStepState {
  const status = statusOf(part);
  if (status?.type === 'running') {
    return 'running';
  }
  if (status?.type === 'requires-action') {
    return 'waiting';
  }
  if (status?.type === 'incomplete') {
    return status.reason === 'cancelled' ? 'cancelled' : 'failed';
  }
  if (part['isError'] === true || isGuardedToolError(part['result'])) {
    return 'failed';
  }
  if (status === undefined && part['result'] === undefined) {
    return 'running';
  }
  return 'done';
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
        state: toolStepState(part),
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

function restingLabel(steps: readonly ActivityStep[]): string {
  const settled = steps.filter(
    (step) => step.kind === 'tool' && (step.state === 'done' || step.state === 'failed')
  );
  if (settled.length === 0) {
    return steps.some((step) => step.kind === 'reasoning') ? 'Thought' : 'Worked';
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

export function summarizeActivity(steps: readonly ActivityStep[]): ActivitySummary {
  const toolSteps = steps.filter((step) => step.kind === 'tool');
  return {
    counts: {
      failed: toolSteps.filter((step) => step.state === 'failed').length,
      steps: toolSteps.length,
    },
    live: liveLabel(steps),
    resting: restingLabel(steps),
    waiting:
      steps.some((step) => step.state === 'waiting') &&
      !toolSteps.some((step) => step.state === 'running'),
  };
}
