/**
 * Scoring reads the host's committed log, never the CLI's printed output: the
 * log is the one owner of what the run did (`run.started`, `model.step`,
 * `interaction.requested`, `run.finished`).
 */
import type { HostLogRow } from '@brainstrike/agent-host/protocol';

export interface EvalRunMetrics {
  /** Approval interactions the run requested. */
  readonly approvals: number;
  /** Summed over the run's steps; null when any step reported none. */
  readonly inputTokens: number | null;
  /** Per tool name, the most calls of it the model made in one step: 2 or more is a parallel call. */
  readonly maxStepCallsByTool: Readonly<Record<string, number>>;
  readonly outputTokens: number | null;
  readonly steps: number;
  /** The model's tool calls, by the tool name it called. */
  readonly toolCalls: Readonly<Record<string, number>>;
  /** From `run.started` to `run.finished`, by their commit times; null while unfinished. */
  readonly wallMs: number | null;
}

export type EvalRunVerdict =
  | {
      readonly detail?: string;
      readonly outcome: 'completed' | 'failed' | 'interrupted' | 'stopped';
    }
  | { readonly outcome: 'unfinished' };

export interface EvalRunSummary {
  readonly metrics: EvalRunMetrics;
  /** The model id the run was started with, as `run.started` committed it. */
  readonly modelId: string;
  readonly runId: string;
  readonly verdict: EvalRunVerdict;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The step's reported count, or null when the provider reported none. */
function tokens(usage: unknown, field: 'inputTokens' | 'outputTokens'): number | null {
  const value = isRecord(usage) ? usage[field] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sum(values: readonly (number | null)[]): number | null {
  return values.reduce<number | null>(
    (total, value) => (total === null || value === null ? null : total + value),
    0
  );
}

/** The tool names of a committed step's assistant tool-call parts. */
function toolCallNames(messages: readonly unknown[]): string[] {
  return messages.flatMap((message) =>
    isRecord(message) && message['role'] === 'assistant' && Array.isArray(message['content'])
      ? message['content'].flatMap((part) =>
          isRecord(part) && part['type'] === 'tool-call' && typeof part['toolName'] === 'string'
            ? [part['toolName']]
            : []
        )
      : []
  );
}

/** Per tool name, its largest count among the steps' tool calls. */
function maxCallsInOneStep(steps: readonly (readonly string[])[]): Record<string, number> {
  const most: Record<string, number> = {};
  for (const names of steps) {
    const inStep: Record<string, number> = {};
    for (const name of names) {
      inStep[name] = (inStep[name] ?? 0) + 1;
    }
    for (const [name, count] of Object.entries(inStep)) {
      most[name] = Math.max(most[name] ?? 0, count);
    }
  }
  return most;
}

/** One run's metrics and verdict, from its thread's committed rows. */
export function readRunFromLog(rows: readonly HostLogRow[], runId: string): EvalRunSummary {
  const started = rows.find((row) => row.event.type === 'run.started' && row.event.runId === runId);
  if (started?.event.type !== 'run.started') {
    throw new Error(`The committed log has no run.started for run ${runId}`);
  }
  const finished = rows.find(
    (row) => row.event.type === 'run.finished' && row.event.runId === runId
  );
  const steps = rows.flatMap((row) =>
    row.event.type === 'model.step' && row.event.runId === runId ? [row.event] : []
  );
  const toolCalls: Record<string, number> = {};
  for (const name of steps.flatMap((step) => toolCallNames(step.messages))) {
    toolCalls[name] = (toolCalls[name] ?? 0) + 1;
  }
  const approvals = rows.filter(
    (row) =>
      row.event.type === 'interaction.requested' &&
      row.event.runId === runId &&
      row.event.kind === 'approval'
  ).length;
  const verdict: EvalRunVerdict =
    finished?.event.type === 'run.finished'
      ? {
          ...(finished.event.detail === undefined ? {} : { detail: finished.event.detail }),
          outcome: finished.event.outcome,
        }
      : { outcome: 'unfinished' };
  return {
    metrics: {
      approvals,
      inputTokens: sum(steps.map((step) => tokens(step.usage, 'inputTokens'))),
      maxStepCallsByTool: maxCallsInOneStep(steps.map((step) => toolCallNames(step.messages))),
      outputTokens: sum(steps.map((step) => tokens(step.usage, 'outputTokens'))),
      steps: steps.length,
      toolCalls,
      wallMs:
        finished?.ts !== undefined && started.ts !== undefined ? finished.ts - started.ts : null,
    },
    modelId: started.event.modelId,
    runId,
    verdict,
  };
}

/** What one task's attempt produced, each part present once that stage ran. */
export interface EvalAttempt {
  /** The loopback provider boundary: requests it refused and cassette exchanges nobody claimed. */
  readonly boundary?: {
    readonly refusals: readonly string[];
    readonly unserved: readonly string[];
  };
  /** Starting, driving or stopping the host failed. */
  /** The task's `expect` block, checked against the run's committed metrics. */
  readonly expect?: {
    readonly parallelCalls: { readonly atLeast: number; readonly toolId: string };
  };
  readonly hostError?: string;
  readonly run?: Pick<EvalRunSummary, 'verdict'> & { readonly metrics?: EvalRunMetrics };
  /** The run did not finish within the task's `timeoutMs`. */
  readonly timedOut?: number;
  readonly verifier?: { readonly exitCode: number | null; readonly output: string };
}

export type EvalScore = { readonly pass: true } | { readonly pass: false; readonly reason: string };

function listed(items: readonly string[]): string {
  return items.join('; ');
}

/** A pass needs every stage clean; the first failing stage, in this order, is the reason. */
export function scoreEvalAttempt(attempt: EvalAttempt): EvalScore {
  const fail = (reason: string): EvalScore => ({ pass: false, reason });
  if (attempt.hostError !== undefined) {
    return fail(attempt.hostError);
  }
  // A refused request is the cause of whatever the run did next, so it is the reason.
  const refusals = attempt.boundary?.refusals ?? [];
  if (refusals.length > 0) {
    return fail(
      `The provider boundary refused ${refusals.length} provider request(s): ${listed(refusals)}`
    );
  }
  if (attempt.timedOut !== undefined) {
    return fail(`The run timed out after ${attempt.timedOut} ms`);
  }
  if (!attempt.run) {
    return fail('The host committed no run');
  }
  const { verdict } = attempt.run;
  if (verdict.outcome !== 'completed') {
    return fail(
      verdict.outcome === 'unfinished'
        ? 'The run is unfinished: the log has no run.finished'
        : `The run ${verdict.outcome}${verdict.detail === undefined ? '' : `: ${verdict.detail}`}`
    );
  }
  const unserved = attempt.boundary?.unserved ?? [];
  if (unserved.length > 0) {
    return fail(
      `The replay left ${unserved.length} recorded exchange(s) unserved: ${listed(unserved)}`
    );
  }
  if (!attempt.verifier) {
    return fail('The verifier did not run');
  }
  if (attempt.verifier.exitCode !== 0) {
    return fail(
      `The verifier exited ${attempt.verifier.exitCode ?? 'by signal'}: ${attempt.verifier.output.trim()}`
    );
  }
  const unmet = unmetExpectation(attempt);
  return unmet === undefined ? { pass: true } : fail(unmet);
}

/** Why the run's committed metrics fall short of the task's `expect` block, if they do. */
function unmetExpectation(attempt: EvalAttempt): string | undefined {
  const expected = attempt.expect?.parallelCalls;
  if (expected === undefined) {
    return;
  }
  const metrics = attempt.run?.metrics;
  if (metrics === undefined) {
    return 'The task expects parallel tool calls, but the run reported no metrics';
  }
  const seen = metrics.maxStepCallsByTool[expected.toolId] ?? 0;
  return seen < expected.atLeast
    ? `The task expects at least ${expected.atLeast} ${expected.toolId} calls in one step; the run made at most ${seen}`
    : undefined;
}
