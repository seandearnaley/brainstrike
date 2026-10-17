/**
 * One eval task, end to end: a fresh sandbox, the real standalone CLI host,
 * the run (approved through the CLI), the committed log's metrics, the hidden
 * verifier, and one scored result. Every failure becomes the result's reason.
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
import { driveEvalRun, type EvalHost, startEvalHost } from './host-cli.js';
import { type ProviderBoundary, startProviderBoundary } from './provider-boundary.js';
import type { EvalMode, EvalResult } from './results.js';
import { createEvalSandbox, type EvalSandbox, runVerifier } from './sandbox.js';
import {
  type EvalAttempt,
  type EvalRunSummary,
  readRunFromLog,
  scoreEvalAttempt,
} from './scoring.js';
import { scriptedModelId } from './scripted-platform.js';
import type { LoadedEvalTask } from './task.js';

const require = createRequire(import.meta.url);

/** The literal a cassette holds in place of the recording machine's workspace path. */
export const WORKSPACE_PLACEHOLDER = '<workspace>';
/** The key a replayed host holds; the boundary never reads it. */
const REPLAY_KEY = 'agent-evals-replay';
const VERIFY_TIMEOUT_MS = 120_000;
/** A verifier's output kept in a reason: its tail, where test runners report. */
const OUTPUT_TAIL = 2000;

/** Where the host's provider requests go: a boundary, the recorder, or (live) nowhere but the provider. */
export type ProviderEgress = ProviderBoundary;

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

/** Scripted mode's trusted platform module, composed for this one task. */
async function writeScriptedPlatform(root: string, loaded: LoadedEvalTask): Promise<string> {
  if (!loaded.script) {
    throw new Error(`${loaded.task.id} has no scripted-mode script.json`);
  }
  // The emitted module, which the host process loads with Node itself.
  const factory = pathToFileURL(require.resolve('@brainstrike/agent-evals/scripted-platform')).href;
  const model = { budgets: loaded.task.model, script: loaded.script, taskId: loaded.task.id };
  const file = join(root, 'scripted-platform.mjs');
  await writeFile(
    file,
    `import { scriptedEvalPlatform } from ${JSON.stringify(factory)};\nexport const createHostPlatform = scriptedEvalPlatform(${JSON.stringify(model)});\n`
  );
  return file;
}

/** The task's own cassette, decoded; a task without one cannot replay. */
export async function readTaskCassette(loaded: LoadedEvalTask): Promise<ProviderCassette> {
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
  readonly summary?: EvalRunSummary;
  readonly timedOut?: number;
}

/** Egress, host, run and its committed log; the host and the egress are always released. */
async function runOnHost(
  loaded: LoadedEvalTask,
  options: EvalRunOptions,
  sandbox: EvalSandbox
): Promise<HostStage> {
  const { task } = loaded;
  const failures: string[] = [];
  let egress: ProviderEgress | undefined;
  let host: EvalHost | undefined;
  let summary: EvalRunSummary | undefined;
  let timedOut: number | undefined;
  try {
    const substitutions = [{ from: sandbox.workspace, to: WORKSPACE_PLACEHOLDER }];
    egress = options.egress
      ? await options.egress(substitutions)
      : await defaultEgress(loaded, options.mode, substitutions);
    const platformModule =
      options.mode === 'scripted' ? await writeScriptedPlatform(sandbox.root, loaded) : undefined;
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
    const driven = await driveEvalRun(host, {
      modelId: options.mode === 'scripted' ? scriptedModelId(task.id) : task.model,
      prompt: task.prompt,
      timeoutMs: task.timeoutMs,
    });
    if (driven.status === 'error') {
      failures.push(driven.error);
    }
    timedOut = driven.status === 'timed-out' ? task.timeoutMs : undefined;
    if (driven.threadId !== undefined && driven.runId !== undefined) {
      summary = readRunFromLog(await host.rows(driven.threadId), driven.runId);
    }
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
    ...(summary ? { summary } : {}),
    ...(timedOut === undefined ? {} : { timedOut }),
  };
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
  const outcome = (attempt: EvalAttempt, summary?: EvalRunSummary): EvalTaskOutcome => {
    const score = scoreEvalAttempt(attempt);
    return {
      attempt,
      result: {
        batch: options.batch,
        finishedAt: new Date().toISOString(),
        metrics: summary?.metrics ?? null,
        mode: options.mode,
        modelId: summary?.modelId ?? null,
        pass: score.pass,
        reason: score.pass ? null : score.reason,
        startedAt,
        task: loaded.task.id,
        verdict: summary?.verdict.outcome ?? null,
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
  const verified =
    failures.length === 0 && stage.summary?.verdict.outcome === 'completed'
      ? await verifyStage(loaded, sandbox)
      : {};
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
      ...(failures.length > 0 ? { hostError: failures.join('; ') } : {}),
      ...(stage.summary ? { run: stage.summary } : {}),
      ...(stage.timedOut === undefined ? {} : { timedOut: stage.timedOut }),
      ...(verified.verifier ? { verifier: verified.verifier } : {}),
    },
    stage.summary
  );
}
