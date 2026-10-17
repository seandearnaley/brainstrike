#!/usr/bin/env node
/**
 * pnpm --filter @brainstrike/agent-evals eval [--task <id>] [--mode scripted|replay|live] [--live]
 * pnpm --filter @brainstrike/agent-evals record --task <id> --model <provider::model>  (owner only)
 *
 * See docs/agents/agent-evals.md.
 */
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assertLiveAllowed } from './live-gate.js';
import { recordEvalCassette } from './record.js';
import {
  appendEvalResults,
  EVAL_MODES,
  type EvalMode,
  type EvalResult,
  formatEvalSummary,
  resultsFilePath,
} from './results.js';
import { providerCredentialEnvNames, runEvalTask } from './runner.js';
import { type LoadedEvalTask, loadEvalTasks } from './task.js';

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

/** The owner's key for this task's provider, read from the shell; never printed. */
function liveCredential(loaded: LoadedEvalTask): Record<string, string> {
  const names = providerCredentialEnvNames(loaded.task.model);
  const value = names.map((name) => process.env[name]).find((candidate) => candidate?.trim());
  const [name] = names;
  if (!(name && value)) {
    throw new Error(`Live ${loaded.task.id} needs ${names.join(' or ')} in this shell`);
  }
  return { [name]: value };
}

async function evalCommand(values: {
  readonly live?: boolean;
  readonly mode?: string;
  readonly task?: string;
}): Promise<boolean> {
  const mode = evalMode(values.mode);
  if (mode === 'live') {
    assertLiveAllowed(values.live ?? false, process.env);
  }
  const selected = selectTasks(await loadEvalTasks(TASKS_DIR), mode, values.task);
  if (selected.length === 0) {
    throw new Error(`No task can run in ${mode} mode`);
  }
  const batch = randomUUID();
  const results: EvalResult[] = [];
  for (const loaded of selected) {
    process.stderr.write(`${loaded.task.id} (${mode})…\n`);
    results.push(
      await runEvalTask(loaded, {
        batch,
        ...(mode === 'live' ? { credential: liveCredential(loaded) } : {}),
        mode,
      })
    );
  }
  const file = resultsFilePath(RESULTS_DIR, new Date(), mode);
  await appendEvalResults(file, results);
  process.stdout.write(`${formatEvalSummary(results)}\nResults: ${file}\n`);
  return results.every((result) => result.pass);
}

async function main(args: readonly string[]): Promise<boolean> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: [...args],
    options: {
      live: { type: 'boolean' },
      mode: { type: 'string' },
      model: { type: 'string' },
      task: { type: 'string' },
    },
    strict: true,
  });
  const [command, ...extra] = positionals;
  if (extra.length > 0) {
    throw new Error(`Unexpected arguments: ${extra.join(' ')}`);
  }
  if (command === 'eval') {
    if (values.model !== undefined) {
      throw new Error('eval runs each task on its own task.json model; --model is for record');
    }
    return await evalCommand(values);
  }
  if (command === 'record') {
    if (!(values.task && values.model) || values.mode !== undefined || values.live) {
      throw new Error('Usage: record --task <id> --model <provider::model>');
    }
    process.stdout.write(
      `${await recordEvalCassette({ env: process.env, model: values.model, taskDir: join(TASKS_DIR, values.task) })}\n`
    );
    return true;
  }
  throw new Error(
    'Usage: eval [--task <id>] [--mode scripted|replay|live] [--live] | record --task <id> --model <id>'
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
