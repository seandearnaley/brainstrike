#!/usr/bin/env node
/**
 * pnpm --filter @brainstrike/agent-evals eval [--task <id>] [--mode scripted|replay|live] [--trials <n>]
 *   live also takes: --live --max-spend-usd <dollars> [--model anthropic::<model>]
 * pnpm --filter @brainstrike/agent-evals record --task <id> --model <provider::model>  (owner only)
 *
 * See docs/agents/agent-evals.md.
 */
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assertLiveAllowed, evalRunModel, evalSpendCap } from './live-gate.ts';
import { recordEvalCassette } from './record.ts';
import {
  appendEvalResults,
  EVAL_MODES,
  type EvalMode,
  formatEvalSummary,
  resultsFilePath,
} from './results.ts';
import { providerCredentialEnvNames, runEvalBatch } from './runner.ts';
import { type LoadedEvalTask, loadEvalTasks } from './task.ts';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const TASKS_DIR = join(PACKAGE_ROOT, 'tasks');
const RESULTS_DIR = join(PACKAGE_ROOT, 'results');

function evalMode(value: string | undefined): EvalMode {
  const mode = value ?? 'scripted';
  if (!(EVAL_MODES as readonly string[]).includes(mode)) {
    throw new Error(`--mode must be one of ${EVAL_MODES.join(', ')}, not ${mode}`);
  }
  return mode as EvalMode;
}

/** The tasks `--task` names, or every task; replay without `--task` runs the tasks with cassettes. */
function selectTasks(
  tasks: readonly LoadedEvalTask[],
  mode: EvalMode,
  id: string | undefined
): readonly LoadedEvalTask[] {
  if (id !== undefined) {
    const named = tasks.find((loaded) => loaded.task.id === id);
    if (!named) {
      throw new Error(`No task ${id}. Tasks: ${tasks.map((loaded) => loaded.task.id).join(', ')}`);
    }
    return [named];
  }
  if (mode !== 'replay') {
    return tasks;
  }
  const uncassetted = tasks.filter((loaded) => !loaded.cassettePath);
  if (uncassetted.length > 0) {
    process.stderr.write(
      `Replay runs the ${tasks.length - uncassetted.length} task(s) with a cassette. Without one (the owner records them): ${uncassetted.map((loaded) => loaded.task.id).join(', ')}\n`
    );
  }
  return tasks.filter((loaded) => loaded.cassettePath);
}

/** The owner's key for the live model's provider, read from the shell; never printed. */
function liveCredential(model: string): Record<string, string> {
  const names = providerCredentialEnvNames(model);
  const value = names.map((name) => process.env[name]).find((candidate) => candidate?.trim());
  const [name] = names;
  if (!(name && value)) {
    throw new Error(`Live ${model} needs ${names.join(' or ')} in this shell`);
  }
  return { [name]: value };
}

/** How many times each task runs: once, or `--trials`. */
function trialCount(value: string | undefined): number {
  const trials = value === undefined ? 1 : Number(value);
  if (!(Number.isInteger(trials) && trials > 0)) {
    throw new Error(`--trials must be a positive whole number, not ${value}`);
  }
  return trials;
}

async function evalCommand(values: {
  readonly live?: boolean;
  readonly 'max-spend-usd'?: string;
  readonly mode?: string;
  readonly model?: string;
  readonly task?: string;
  readonly trials?: string;
}): Promise<boolean> {
  const mode = evalMode(values.mode);
  if (mode === 'live') {
    assertLiveAllowed(values.live ?? false, process.env);
  }
  const spendCapUsd = evalSpendCap(mode, values['max-spend-usd']);
  const selected = selectTasks(await loadEvalTasks(TASKS_DIR), mode, values.task);
  if (selected.length === 0) {
    throw new Error(`No task can run in ${mode} mode`);
  }
  // Every run's model is settled before any run starts; live, they are all Anthropic's, so one key serves.
  const [liveModel] = selected.map((loaded) => evalRunModel(mode, values.model, loaded.task.model));
  const results = await runEvalBatch(selected, {
    batch: randomUUID(),
    ...(liveModel === undefined ? {} : { credential: liveCredential(liveModel) }),
    mode,
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(spendCapUsd === undefined ? {} : { spendCapUsd }),
    trials: trialCount(values.trials),
  });
  const file = resultsFilePath(RESULTS_DIR, new Date(), mode);
  await appendEvalResults(file, results);
  process.stdout.write(`${formatEvalSummary(results)}\nResults: ${file}\n`);
  // A run the spend cap cut short has a failed line, so it never exits 0.
  return results.every((result) => result.pass);
}

async function main(args: readonly string[]): Promise<boolean> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: [...args],
    options: {
      live: { type: 'boolean' },
      'max-spend-usd': { type: 'string' },
      mode: { type: 'string' },
      model: { type: 'string' },
      task: { type: 'string' },
      trials: { type: 'string' },
    },
    strict: true,
  });
  const [command, ...extra] = positionals;
  if (extra.length > 0) {
    throw new Error(`Unexpected arguments: ${extra.join(' ')}`);
  }
  if (command === 'eval') {
    return await evalCommand(values);
  }
  if (command === 'record') {
    if (
      !(values.task && values.model) ||
      values.mode !== undefined ||
      values.live ||
      values['max-spend-usd'] !== undefined ||
      values.trials !== undefined
    ) {
      throw new Error('Usage: record --task <id> --model <provider::model>');
    }
    process.stdout.write(
      `${await recordEvalCassette({ env: process.env, model: values.model, taskDir: join(TASKS_DIR, values.task) })}\n`
    );
    return true;
  }
  throw new Error(
    'Usage: eval [--task <id>] [--mode scripted|replay|live] [--live --max-spend-usd <dollars> --model anthropic::<model>] [--trials <n>] | record --task <id> --model <id>'
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then(
    (passed) => {
      process.exitCode = passed ? 0 : 1;
    },
    (cause: unknown) => {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 2;
    }
  );
}
