/**
 * Eval results: one JSON line per task in `results/<UTC date>-<mode>.jsonl`
 * (gitignored), appended, and a summary table for the terminal.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Schema } from 'effect';
import { fileDecoder } from './task.js';

export const EVAL_MODES = ['scripted', 'replay', 'live'] as const;
export type EvalMode = (typeof EVAL_MODES)[number];

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Text = Schema.String.check(Schema.isMinCodePoints(1));

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

const COLUMNS = ['task', 'mode', 'result', 'steps', 'tools', 'in tok', 'out tok', 'wall ms'];

function cell(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : String(value);
}

/** A plain-text table: one row per task, then `<passed>/<total> passed`. */
export function formatEvalSummary(results: readonly EvalResult[]): string {
  const rows = results.map((result) => [
    result.task,
    result.mode,
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
  ].join('\n');
}
