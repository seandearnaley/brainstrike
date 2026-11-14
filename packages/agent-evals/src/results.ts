/**
 * Eval results: one JSON line per run of a task in
 * `results/<UTC date>-<mode>.jsonl` (gitignored), appended, and a summary
 * table for the terminal.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Schema } from 'effect';
import { fileDecoder } from './task.ts';

export const EVAL_MODES = ['scripted', 'replay', 'live'] as const;
export type EvalMode = (typeof EVAL_MODES)[number];

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Text = Schema.String.check(Schema.isMinCodePoints(1));
const Cost = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const EvalResultSchema = Schema.Struct({
  /** One `eval` invocation: every task it ran shares it. */
  batch: Text,
  finishedAt: Text,
  metrics: Schema.NullOr(
    Schema.Struct({
      approvals: Count,
      inputTokens: Schema.NullOr(Count),
      maxStepCallsByTool: Schema.Record(Schema.String, Count),
      outputTokens: Schema.NullOr(Count),
      steps: Count,
      toolCalls: Schema.Record(Schema.String, Count),
      wallMs: Schema.NullOr(Count),
    })
  ),
  mode: Schema.Literals(EVAL_MODES),
  /** As `run.started` committed it; null when no run started. */
  modelId: Schema.NullOr(Text),
  pass: Schema.Boolean,
  reason: Schema.NullOr(Text),
  startedAt: Text,
  task: Text,
  /** The whole thread, every turn's run included; null when no run started. */
  thread: Schema.NullOr(
    Schema.Struct({
      compactions: Schema.Struct({ agentic: Count, deterministic: Count }),
      probes: Schema.Struct({ passed: Count, total: Count }),
      /** Every model call the thread paid for, from the host's cost ledger. */
      spend: Schema.Struct({
        bySource: Schema.Record(
          Schema.String,
          Schema.Struct({ costUsd: Schema.NullOr(Cost), inputTokens: Count, outputTokens: Count })
        ),
        cacheReadTokens: Count,
        cacheWriteTokens: Count,
        costUsd: Schema.NullOr(Cost),
        /** Calls the provider bills but never reported usage for; any makes the total unknown. */
        unreportedCalls: Count,
      }),
      turns: Count,
    })
  ),
  /** Which run of the task this is within its batch, from 1. */
  trial: Schema.Int.check(Schema.isGreaterThan(0)),
  verdict: Schema.NullOr(Text),
  verifierExitCode: Schema.NullOr(Schema.Int),
}).check(
  Schema.makeFilter((result) =>
    result.pass === (result.reason === null)
      ? undefined
      : { issue: 'A failed result has a reason and a passed one has none', path: ['reason'] }
  )
);
export type EvalResult = typeof EvalResultSchema.Type;

const decodeEvalResult = fileDecoder(EvalResultSchema, 'eval result');

/** `<dir>/<UTC date>-<mode>.jsonl`. */
export function resultsFilePath(dir: string, at: Date, mode: EvalMode): string {
  return join(dir, `${at.toISOString().slice(0, 10)}-${mode}.jsonl`);
}

/** Validates every result first, then appends them as one write. */
export async function appendEvalResults(
  file: string,
  results: readonly EvalResult[]
): Promise<void> {
  const lines = results.map(
    (result) => `${JSON.stringify(decodeEvalResult(result, `${result.task} result`))}\n`
  );
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, lines.join(''));
}

const COLUMNS = [
  'task',
  'mode',
  'trial',
  'result',
  'steps',
  'tools',
  'in tok',
  'out tok',
  'wall ms',
  'turns',
  'compact',
  'probes',
  'cost $',
];

function cell(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : String(value);
}

/** Probes answered of probes asked; none asked reads as no figure. */
function probesCell(thread: EvalResult['thread']): string {
  return thread && thread.probes.total > 0 ? `${thread.probes.passed}/${thread.probes.total}` : '-';
}

function costCell(thread: EvalResult['thread']): string {
  const cost = thread?.spend.costUsd;
  return cost === null || cost === undefined ? '-' : cost.toFixed(4);
}

/** Per task, how many of its trials passed, in the order the tasks first ran. */
function trialLines(results: readonly EvalResult[]): string[] {
  const tasks = new Map<string, { passed: number; trials: number }>();
  for (const result of results) {
    const task = tasks.get(result.task) ?? { passed: 0, trials: 0 };
    tasks.set(result.task, {
      passed: task.passed + (result.pass ? 1 : 0),
      trials: task.trials + 1,
    });
  }
  return [...tasks.values()].some((task) => task.trials > 1)
    ? [...tasks].map(([id, task]) => `${id}: ${task.passed}/${task.trials} trials passed`)
    : [];
}

/**
 * A plain-text table: one row per run of a task, then `<passed>/<total> passed`
 * and, when a task ran more than once, each task's share of passing trials.
 */
export function formatEvalSummary(results: readonly EvalResult[]): string {
  const rows = results.map((result) => [
    result.task,
    result.mode,
    String(result.trial),
    result.pass ? 'PASS' : 'FAIL',
    cell(result.metrics?.steps),
    cell(
      result.metrics
        ? Object.values(result.metrics.toolCalls).reduce((total, count) => total + count, 0)
        : null
    ),
    cell(result.metrics?.inputTokens),
    cell(result.metrics?.outputTokens),
    cell(result.metrics?.wallMs),
    cell(result.thread?.turns),
    cell(
      result.thread
        ? result.thread.compactions.agentic + result.thread.compactions.deterministic
        : null
    ),
    probesCell(result.thread),
    costCell(result.thread),
    result.reason ?? '',
  ]);
  const widths = COLUMNS.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => (row[index] ?? '').length))
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((value, index) => (index < widths.length ? value.padEnd(widths[index] ?? 0) : value))
      .join('  ')
      .trimEnd();
  const passed = results.filter((result) => result.pass).length;
  return [
    line([...COLUMNS, 'reason']),
    ...rows.map(line),
    `${passed}/${results.length} passed`,
    ...trialLines(results),
  ].join('\n');
}
