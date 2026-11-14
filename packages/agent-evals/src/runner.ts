/**
 * One eval task, end to end: a fresh sandbox, the real standalone CLI host,
 * the task's turns on one thread (approved through the CLI), the committed
 * log's metrics, the hidden verifier, and one scored result. Every failure
 * becomes the result's reason.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSupportedProvider } from '@brainstrike/assistant-contract';
import { providerEnvKeys } from '@brainstrike/assistant-contract/provider-metadata';
import {
  type ProviderCassette,
  type ProviderCassetteSubstitution,
  parseProviderCassette,
} from '@brainstrike/test-utils/provider-cassette';
import { driveEvalRun, type EvalHost, startEvalHost } from './host-cli.ts';
import { type ProviderBoundary, startProviderBoundary } from './provider-boundary.ts';
import type { EvalMode, EvalResult } from './results.ts';
import { createEvalSandbox, type EvalSandbox, runVerifier } from './sandbox.ts';
import {
  type EvalAttempt,
  type EvalThreadSummary,
  gradeProbe,
  readThreadFromLog,
  scoreEvalAttempt,
  threadMetrics,
} from './scoring.ts';
import { type ScriptedEvalModel, scriptedModelId } from './scripted-platform.ts';
import { type LoadedEvalTask, scriptTurns } from './task.ts';

const require = createRequire(import.meta.url);

/** The literal a cassette holds in place of the recording machine's workspace path. */
export const WORKSPACE_PLACEHOLDER = '<workspace>';
/** The key a replayed host holds; the boundary never reads it. */
const REPLAY_KEY = 'agent-evals-replay';
const VERIFY_TIMEOUT_MS = 120_000;
/** A verifier's output kept in a reason: its tail, where test runners report. */
const OUTPUT_TAIL = 2000;

/** Where the host's provider requests go: a boundary, the recorder, or (live) nowhere but the provider. */
type ProviderEgress = ProviderBoundary;

export interface EvalRunOptions {
  readonly batch: string;
  /** Live mode only: the provider credential, by its env name, from the owner's shell. */
  readonly credential?: Readonly<Record<string, string>>;
  /**
   * The provider egress for this attempt, given the workspace substitutions. By
   * default scripted mode refuses every request and replay serves the task's cassette.
   */
  readonly egress?: (
    substitutions: readonly ProviderCassetteSubstitution[]
  ) => Promise<ProviderEgress | undefined>;
  readonly mode: EvalMode;
  /** Which run of the task this is within its batch, from 1; 1 when the task runs once. */
  readonly trial?: number;
}

/** The env names the provider's key may be read from, in precedence order. */
export function providerCredentialEnvNames(model: string): readonly string[] {
  const provider = model.slice(0, model.indexOf('::'));
  if (!isSupportedProvider(provider)) {
    throw new Error(`${model} names no supported provider`);
  }
  return providerEnvKeys(provider);
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL ? `…${trimmed.slice(-OUTPUT_TAIL)}` : trimmed;
}

/** The task's prompts in turn order: its own, then each follow-up's. */
function turnPrompts({ task }: LoadedEvalTask): string[] {
  return [task.prompt, ...(task.followUps ?? []).map((followUp) => followUp.prompt)];
}

/** Scripted mode's trusted model for this one task: its script, turn by turn. */
function scriptedModel(loaded: LoadedEvalTask): ScriptedEvalModel {
  const { script, task } = loaded;
  if (!script) {
    throw new Error(`${task.id} has no scripted-mode script.json`);
  }
  const prompts = turnPrompts(loaded);
  return {
    budgets: task.model,
    ...(task.inputTokenLimit === undefined ? {} : { inputTokenLimit: task.inputTokenLimit }),
    ...(script.summary === undefined ? {} : { summary: script.summary }),
    taskId: task.id,
    turns: scriptTurns(script).map((turn, index) => {
      const prompt = prompts[index];
      if (prompt === undefined) {
        throw new Error(`${task.id}'s script has a turn the task does not`);
      }
      return { ...turn, prompt };
    }),
  };
}

/**
 * The trusted platform module this attempt's host loads, when it needs one:
 * scripted mode's model, or (replay and live) the task's pinned input budget.
 */
async function writeEvalPlatform(
  root: string,
  loaded: LoadedEvalTask,
  mode: EvalMode
): Promise<string | undefined> {
  const pin = loaded.task.inputTokenLimit;
  if (mode !== 'scripted' && pin === undefined) {
    return;
  }
  // The emitted module, which the host process loads with Node itself.
  const factory = pathToFileURL(require.resolve('@brainstrike/agent-evals/scripted-platform')).href;
  const composed =
    mode === 'scripted'
      ? `scriptedEvalPlatform(${JSON.stringify(scriptedModel(loaded))})`
      : `pinnedEvalPlatform(${JSON.stringify(pin)})`;
  const file = join(root, 'eval-platform.mjs');
  await writeFile(
    file,
    `import { pinnedEvalPlatform, scriptedEvalPlatform } from ${JSON.stringify(factory)};\nexport const createHostPlatform = ${composed};\n`
  );
  return file;
}

/** The task's own cassette, decoded; a task without one cannot replay. */
async function readTaskCassette(loaded: LoadedEvalTask): Promise<ProviderCassette> {
  if (!loaded.cassettePath) {
    throw new Error(
      `${loaded.task.id} has no cassette to replay; the owner records one with the record command`
    );
  }
  return parseProviderCassette(await readFile(loaded.cassettePath, 'utf8'), loaded.cassettePath);
}

async function defaultEgress(
  loaded: LoadedEvalTask,
  mode: EvalMode,
  substitutions: readonly ProviderCassetteSubstitution[]
): Promise<ProviderEgress | undefined> {
  switch (mode) {
    case 'scripted':
      return await startProviderBoundary({ substitutions });
    case 'replay':
      return await startProviderBoundary({
        cassette: await readTaskCassette(loaded),
        substitutions,
      });
    case 'live':
      return;
  }
}

/** The host's provider credential: none scripted, a placeholder on replay, the owner's key live. */
function credentialEnv(loaded: LoadedEvalTask, options: EvalRunOptions): Record<string, string> {
  switch (options.mode) {
    case 'scripted':
      return {};
    case 'replay': {
      const [name] = providerCredentialEnvNames(loaded.task.model);
      if (!name) {
        throw new Error(`${loaded.task.model} has no credential env name`);
      }
      return { [name]: REPLAY_KEY };
    }
    case 'live':
      if (!options.credential) {
        throw new Error('Live mode needs the provider credential from the owner’s shell');
      }
      return { ...options.credential };
  }
}

export interface EvalTaskOutcome {
  readonly attempt: EvalAttempt;
  readonly result: EvalResult;
}

/** Runs one task in `options.mode` and scores it. A task's own failure is its result, never a throw. */
export async function runEvalTask(
  loaded: LoadedEvalTask,
  options: EvalRunOptions
): Promise<EvalResult> {
  return (await attemptEvalTask(loaded, options)).result;
}

interface HostStage {
  readonly boundary?: EvalAttempt['boundary'];
  readonly failures: readonly string[];
  /** Every turn that started, from the thread's committed log. */
  readonly thread?: EvalThreadSummary;
  readonly timedOut?: number;
}

/**
 * The task's turns on one thread, each after the one before completed. A turn
 * that errors, times out or does not complete ends the thread there.
 */
async function driveTurns(
  host: EvalHost,
  loaded: LoadedEvalTask,
  mode: EvalMode
): Promise<Pick<HostStage, 'failures' | 'thread' | 'timedOut'>> {
  const { task } = loaded;
  const modelId = mode === 'scripted' ? scriptedModelId(task.id) : task.model;
  const runIds: string[] = [];
  let threadId: string | undefined;
  let thread: EvalThreadSummary | undefined;
  const read = async () => {
    if (threadId !== undefined && runIds.length > 0) {
      thread = readThreadFromLog(await host.rows(threadId), runIds);
    }
  };
  for (const prompt of turnPrompts(loaded)) {
    const driven = await driveEvalRun(host, {
      modelId,
      prompt,
      ...(threadId === undefined ? {} : { threadId }),
      timeoutMs: task.timeoutMs,
    });
    threadId ??= driven.threadId;
    if (driven.runId !== undefined) {
      runIds.push(driven.runId);
    }
    await read();
    if (driven.status === 'error') {
      return { failures: [driven.error], ...(thread ? { thread } : {}) };
    }
    if (driven.status === 'timed-out') {
      return { failures: [], ...(thread ? { thread } : {}), timedOut: task.timeoutMs };
    }
    if (thread?.runs.at(-1)?.verdict.outcome !== 'completed') {
      break;
    }
  }
  return { failures: [], ...(thread ? { thread } : {}) };
}

/** Egress, host, turns and their committed log; the host and the egress are always released. */
async function runOnHost(
  loaded: LoadedEvalTask,
  options: EvalRunOptions,
  sandbox: EvalSandbox
): Promise<HostStage> {
  const failures: string[] = [];
  let egress: ProviderEgress | undefined;
  let host: EvalHost | undefined;
  let thread: EvalThreadSummary | undefined;
  let timedOut: number | undefined;
  try {
    const substitutions = [{ from: sandbox.workspace, to: WORKSPACE_PLACEHOLDER }];
    egress = options.egress
      ? await options.egress(substitutions)
      : await defaultEgress(loaded, options.mode, substitutions);
    const platformModule = await writeEvalPlatform(sandbox.root, loaded, options.mode);
    host = await startEvalHost({
      dataRoot: sandbox.dataRoot,
      env: {
        ...sandbox.env,
        ['MASTRA_OFFLINE']: 'true',
        ...egress?.env,
        ...credentialEnv(loaded, options),
      },
      ...(platformModule ? { platformModule } : {}),
      workspace: sandbox.workspace,
    });
    const driven = await driveTurns(host, loaded, options.mode);
    failures.push(...driven.failures);
    thread = driven.thread;
    timedOut = driven.timedOut;
  } catch (cause) {
    failures.push(message(cause));
  }
  try {
    await host?.close();
  } catch (cause) {
    failures.push(`Host stop: ${message(cause)}`);
  }
  const boundary = egress && { refusals: egress.refusals(), unserved: egress.unserved() };
  try {
    await egress?.close();
  } catch (cause) {
    failures.push(`Provider egress close: ${message(cause)}`);
  }
  return {
    ...(boundary ? { boundary } : {}),
    failures,
    ...(thread ? { thread } : {}),
    ...(timedOut === undefined ? {} : { timedOut }),
  };
}

/** How many of the task's probes the thread's answers satisfied. */
function probeCounts(
  loaded: LoadedEvalTask,
  thread: EvalThreadSummary
): { passed: number; total: number } {
  let passed = 0;
  let total = 0;
  for (const [index, followUp] of (loaded.task.followUps ?? []).entries()) {
    if (followUp.probe) {
      total += 1;
      const answer = thread.answers[index + 1] ?? '';
      passed += gradeProbe(answer, followUp.probe).missing.length === 0 ? 1 : 0;
    }
  }
  return { passed, total };
}

/** The hidden verifier over the finished workspace; its own failure to run is a reason. */
async function verifyStage(
  loaded: LoadedEvalTask,
  sandbox: EvalSandbox
): Promise<{ readonly failure?: string; readonly verifier?: EvalAttempt['verifier'] }> {
  try {
    const verified = await runVerifier({
      command: loaded.task.verify.command,
      env: sandbox.env,
      timeoutMs: VERIFY_TIMEOUT_MS,
      verifyDir: loaded.verifyDir,
      workspace: sandbox.workspace,
    });
    return { verifier: { exitCode: verified.exitCode, output: tail(verified.output) } };
  } catch (cause) {
    return { failure: `Verifier: ${message(cause)}` };
  }
}

/** {@link runEvalTask}, keeping the scored attempt (record mode checks its boundary). */
export async function attemptEvalTask(
  loaded: LoadedEvalTask,
  options: EvalRunOptions
): Promise<EvalTaskOutcome> {
  const startedAt = new Date().toISOString();
  const outcome = (attempt: EvalAttempt, thread?: EvalThreadSummary): EvalTaskOutcome => {
    const score = scoreEvalAttempt(attempt);
    return {
      attempt,
      result: {
        batch: options.batch,
        finishedAt: new Date().toISOString(),
        metrics: (thread && threadMetrics(thread.runs)) ?? null,
        mode: options.mode,
        modelId: thread?.runs[0]?.modelId ?? null,
        pass: score.pass,
        reason: score.pass ? null : score.reason,
        startedAt,
        task: loaded.task.id,
        thread: thread
          ? {
              compactions: thread.compactions,
              probes: probeCounts(loaded, thread),
              spend: thread.spend,
              turns: thread.runs.length,
            }
          : null,
        trial: options.trial ?? 1,
        // The turn the thread ended on: its last when every turn completed.
        verdict: thread?.runs.at(-1)?.verdict.outcome ?? null,
        verifierExitCode: attempt.verifier?.exitCode ?? null,
      },
    };
  };
  let sandbox: EvalSandbox;
  try {
    sandbox = await createEvalSandbox(loaded.repoDir);
  } catch (cause) {
    return outcome({ hostError: `Sandbox: ${message(cause)}` });
  }
  const stage = await runOnHost(loaded, options, sandbox);
  const failures = [...stage.failures];
  const runs = stage.thread?.runs ?? [];
  // The verifier reads the workspace every turn left: all of them, completed.
  const finished =
    runs.length === turnPrompts(loaded).length &&
    runs.every((run) => run.verdict.outcome === 'completed');
  const verified = failures.length === 0 && finished ? await verifyStage(loaded, sandbox) : {};
  if (verified.failure) {
    failures.push(verified.failure);
  }
  try {
    await sandbox.remove();
  } catch (cause) {
    failures.push(`Sandbox removal: ${message(cause)}`);
  }
  return outcome(
    {
      ...(stage.boundary ? { boundary: stage.boundary } : {}),
      ...(loaded.task.expect ? { expect: loaded.task.expect } : {}),
      ...(loaded.task.followUps ? { followUps: loaded.task.followUps } : {}),
      ...(failures.length > 0 ? { hostError: failures.join('; ') } : {}),
      ...(runs[0] ? { run: runs[0] } : {}),
      ...(stage.thread ? { thread: stage.thread } : {}),
      ...(stage.timedOut === undefined ? {} : { timedOut: stage.timedOut }),
      ...(verified.verifier ? { verifier: verified.verifier } : {}),
    },
    stage.thread
  );
}
