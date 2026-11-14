/**
 * Scoring reads the host's committed log, never the CLI's printed output: the
 * log is the one owner of what the run did (`run.started`, `model.step`,
 * `interaction.requested`, `run.finished`).
 */
import { ThreadLedgerFold } from '@brainstrike/agent-host/ledger-projection';
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import { Predicate } from 'effect';

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

/** The step's reported count, or null when the provider reported none. */
function tokens(usage: unknown, field: 'inputTokens' | 'outputTokens'): number | null {
  const value = Predicate.isObject(usage) ? usage[field] : undefined;
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
    Predicate.isObject(message) &&
    message['role'] === 'assistant' &&
    Array.isArray(message['content'])
      ? message['content'].flatMap((part) =>
          Predicate.isObject(part) &&
          part['type'] === 'tool-call' &&
          typeof part['toolName'] === 'string'
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

/** What the thread's calls of one kind cost: the chat itself, a compaction summary, an observer. */
export interface EvalSourceSpend {
  /** List price plus what the provider billed; null when a call of this kind has no price. */
  readonly costUsd: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Every model call the thread paid for, as the host's own cost ledger folds its log. */
export interface EvalThreadSpend {
  /** By the ledger's usage kind: `chat`, `compaction-summary`, `thread-title` and the rest. */
  readonly bySource: Readonly<Record<string, EvalSourceSpend>>;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /**
   * Null when any call has no price, or the provider bills a call it never
   * reported usage for: a partial total would read as the whole.
   */
  readonly costUsd: number | null;
  /** Calls a Stop, a timeout or a failure cut off that the provider bills but never reported. */
  readonly unreportedCalls: number;
}

export interface EvalThreadSummary {
  /** Each turn's final answer text, in turn order; empty for a turn that ended without one. */
  readonly answers: readonly string[];
  /** Committed compactions: summarized by a model, or dropped without one. */
  readonly compactions: { readonly agentic: number; readonly deterministic: number };
  readonly runs: readonly EvalRunSummary[];
  readonly spend: EvalThreadSpend;
}

function addCost(total: number | null, cost: number | null): number | null {
  return total === null || cost === null ? null : total + cost;
}

/** The thread's spend, from the same fold the app's cost views read. */
function readSpend(rows: readonly HostLogRow[]): EvalThreadSpend {
  const fold = new ThreadLedgerFold();
  for (const row of rows) {
    fold.apply(row);
  }
  const bySource: Record<string, EvalSourceSpend> = {};
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd: number | null = 0;
  for (const usage of fold.perModel()) {
    const cost =
      usage.estimatedCostUsd === null ? null : usage.estimatedCostUsd + (usage.billedCostUsd ?? 0);
    const source = bySource[usage.runKind] ?? { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    bySource[usage.runKind] = {
      costUsd: addCost(source.costUsd, cost),
      inputTokens: source.inputTokens + usage.inputTokens,
      outputTokens: source.outputTokens + usage.outputTokens,
    };
    cacheReadTokens += usage.cacheReadTokens;
    cacheWriteTokens += usage.cacheCreationTokens;
    costUsd = addCost(costUsd, cost);
  }
  const unreportedCalls = fold
    .read()
    .runs.reduce((total, run) => total + run.unreportedCallCount, 0);
  return {
    bySource,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: unreportedCalls > 0 ? null : costUsd,
    unreportedCalls,
  };
}

/** The text of the run's last step: what the person reads as the turn's answer. */
function finalAnswer(rows: readonly HostLogRow[], runId: string): string {
  const last = rows.findLast((row) => row.event.type === 'model.step' && row.event.runId === runId);
  if (last?.event.type !== 'model.step') {
    return '';
  }
  return last.event.messages
    .flatMap((message) =>
      Predicate.isObject(message) &&
      message['role'] === 'assistant' &&
      Array.isArray(message['content'])
        ? message['content'].flatMap((part) =>
            Predicate.isObject(part) && part['type'] === 'text' && typeof part['text'] === 'string'
              ? [part['text']]
              : []
          )
        : []
    )
    .join('');
}

/** A thread's turns, compactions and spend, from its committed rows; `runIds` in turn order. */
export function readThreadFromLog(
  rows: readonly HostLogRow[],
  runIds: readonly string[]
): EvalThreadSummary {
  const compactions = { agentic: 0, deterministic: 0 };
  for (const row of rows) {
    if (row.event.type === 'context.compacted') {
      compactions[row.event.kind] += 1;
    }
  }
  return {
    answers: runIds.map((runId) => finalAnswer(rows, runId)),
    compactions,
    runs: runIds.map((runId) => readRunFromLog(rows, runId)),
    spend: readSpend(rows),
  };
}

/** The whole thread's metrics: every turn's counts summed, and the widest step of any turn. */
export function threadMetrics(runs: readonly EvalRunSummary[]): EvalRunMetrics | undefined {
  const [first, ...rest] = runs.map((run) => run.metrics);
  if (!first) {
    return;
  }
  const counts = (
    into: Readonly<Record<string, number>>,
    from: Readonly<Record<string, number>>,
    combine: (a: number, b: number) => number
  ) => {
    const merged = { ...into };
    for (const [name, count] of Object.entries(from)) {
      merged[name] = combine(merged[name] ?? 0, count);
    }
    return merged;
  };
  return rest.reduce<EvalRunMetrics>(
    (total, metrics) => ({
      approvals: total.approvals + metrics.approvals,
      inputTokens: sum([total.inputTokens, metrics.inputTokens]),
      maxStepCallsByTool: counts(total.maxStepCallsByTool, metrics.maxStepCallsByTool, Math.max),
      outputTokens: sum([total.outputTokens, metrics.outputTokens]),
      steps: total.steps + metrics.steps,
      toolCalls: counts(total.toolCalls, metrics.toolCalls, (a, b) => a + b),
      wallMs: sum([total.wallMs, metrics.wallMs]),
    }),
    first
  );
}

/** A probe: the facts a turn's answer must state. */
export interface EvalProbe {
  readonly facts: readonly string[];
}

/**
 * Grades one probe answer: which of the probe's facts the answer leaves out.
 * A fact counts as stated when the answer contains it, whatever the letter
 * case. Every fact is required, so one omission fails the probe.
 */
export function gradeProbe(answer: string, probe: EvalProbe): { readonly missing: string[] } {
  const said = answer.toLowerCase();
  return { missing: probe.facts.filter((fact) => !said.includes(fact.toLowerCase())) };
}

/** What one task's attempt produced, each part present once that stage ran. */
export interface EvalAttempt {
  /** The loopback provider boundary: requests it refused and cassette exchanges nobody claimed. */
  readonly boundary?: {
    readonly refusals: readonly string[];
    readonly unserved: readonly string[];
  };
  /** The task's `expect` block, checked against the committed log. */
  readonly expect?: {
    readonly compactions?: {
      readonly atLeast: number;
      readonly kind?: keyof EvalThreadSummary['compactions'];
    };
    readonly parallelCalls?: { readonly atLeast: number; readonly toolId: string };
  };
  /** The task's follow-up turns, in order: turn 2 onwards. */
  readonly followUps?: readonly { readonly probe?: EvalProbe }[];
  /** Starting, driving or stopping the host failed. */
  readonly hostError?: string;
  /** The first turn's run. */
  readonly run?: Pick<EvalRunSummary, 'verdict'> & { readonly metrics?: EvalRunMetrics };
  /** Why a live run's spend cap started none of the thread's later turns. */
  readonly spendCapped?: string;
  /** The whole thread, the first turn included: each turn's run and answer, and its compactions. */
  readonly thread?: Pick<EvalThreadSummary, 'answers' | 'compactions'> & {
    /** Every turn's metrics as one: what `expect.parallelCalls` is read from. */
    readonly metrics?: EvalRunMetrics;
    readonly runs: readonly Pick<EvalRunSummary, 'verdict'>[];
  };
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
  // The cap is why the later turns never ran.
  if (attempt.spendCapped !== undefined) {
    return fail(attempt.spendCapped);
  }
  const turn = unfinishedFollowUp(attempt);
  if (turn !== undefined) {
    return fail(turn);
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
  const unmet = unmetExpectation(attempt) ?? unmetCompactions(attempt) ?? missedProbe(attempt);
  return unmet === undefined ? { pass: true } : fail(unmet);
}

/** The first follow-up turn that never ran or did not complete, if any. Turn 1 is `attempt.run`. */
function unfinishedFollowUp(attempt: EvalAttempt): string | undefined {
  for (const index of (attempt.followUps ?? []).keys()) {
    const turn = index + 2;
    const verdict = attempt.thread?.runs[index + 1]?.verdict;
    if (verdict === undefined) {
      return `Turn ${turn} never ran`;
    }
    if (verdict.outcome === 'unfinished') {
      return `Turn ${turn} is unfinished: the log has no run.finished`;
    }
    if (verdict.outcome !== 'completed') {
      return `Turn ${turn} ${verdict.outcome}${verdict.detail === undefined ? '' : `: ${verdict.detail}`}`;
    }
  }
  return;
}

/**
 * Why the thread's compactions fall short of the task's `expect` block, if
 * they do: fewer than it asks for, or one of another kind than it names.
 */
function unmetCompactions(attempt: EvalAttempt): string | undefined {
  const expected = attempt.expect?.compactions;
  if (expected === undefined) {
    return;
  }
  const counts = { agentic: 0, deterministic: 0, ...attempt.thread?.compactions };
  const committed = counts.agentic + counts.deterministic;
  if (committed < expected.atLeast) {
    return `The task expects at least ${expected.atLeast} compaction(s); the thread committed ${committed}`;
  }
  const other = expected.kind === 'agentic' ? 'deterministic' : 'agentic';
  return expected.kind !== undefined && counts[other] > 0
    ? `The task expects only ${expected.kind} compactions; the thread committed ${counts[other]} ${other}`
    : undefined;
}

/** The first probe whose turn's answer leaves a fact out, if any. */
function missedProbe(attempt: EvalAttempt): string | undefined {
  for (const [index, followUp] of (attempt.followUps ?? []).entries()) {
    if (!followUp.probe) {
      continue;
    }
    const { missing } = gradeProbe(attempt.thread?.answers[index + 1] ?? '', followUp.probe);
    if (missing.length > 0) {
      return `Turn ${index + 2}'s answer leaves out: ${listed(missing)}`;
    }
  }
  return;
}

/** Why the run's committed metrics fall short of the task's `expect` block, if they do. */
function unmetExpectation(attempt: EvalAttempt): string | undefined {
  const expected = attempt.expect?.parallelCalls;
  if (expected === undefined) {
    return;
  }
  // Any turn may make the calls; a one-turn attempt has only its run's metrics.
  const metrics = attempt.thread?.metrics ?? attempt.run?.metrics;
  if (metrics === undefined) {
    return 'The task expects parallel tool calls, but the run reported no metrics';
  }
  const seen = metrics.maxStepCallsByTool[expected.toolId] ?? 0;
  return seen < expected.atLeast
    ? `The task expects at least ${expected.atLeast} ${expected.toolId} calls in one step; the run made at most ${seen}`
    : undefined;
}
