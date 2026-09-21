import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
  NATIVE_TOOL_RESULT_CHAR_BUDGET,
  type ResolvedSkillScriptExecution,
  type RunSkillScriptInput,
  type RuntimeData,
  type ScannedWorkspaceSkills,
  serializationOverhead,
  sliceTailCodePoints,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, ToolInputError } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import stripAnsi from 'strip-ansi';
import {
  requireExecutionBudget,
  runDetachedProcess,
  type ShellOutputStreamer,
} from './execute-command-tool';
import { withWorkspaceMutationLease } from './workspace-mutation-lease';
import { isWithinRoot } from './workspace-path';
import { resolveWorkspaceRoot } from './workspace-roots';

const logger = createLogger('RunSkillScriptTool');
const { defaultMs: DEFAULT_TIMEOUT_MS } = requireExecutionBudget(NATIVE_TOOL_ID.runSkillScript);
const OUTPUT_ENVELOPE_CHARS = 1200;

export interface RunSkillScriptToolResult {
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly policy: ResolvedSkillScriptExecution['policy'];
  readonly rootName: string;
  readonly runtime: RunSkillScriptInput['runtime'];
  readonly scriptPath: string;
  readonly signal: string | null;
  readonly skillName: string;
  readonly sourceTier: ResolvedSkillScriptExecution['sourceTier'];
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly workingDirectory: string;
}

async function resolveWorkingDirectory(
  runtimeData: RuntimeData | undefined,
  input: RunSkillScriptInput,
  resolved: ResolvedSkillScriptExecution
): Promise<{ cwd: string; rootName: string; rootPath: string }> {
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  if (resolved.sourceRootId && resolved.sourceRootId !== root.rootId) {
    throw new ToolInputError(
      `Workspace-local skill "${resolved.skillName}" belongs to root id "${resolved.sourceRootId}", not "${root.rootId}".`
    );
  }
  const canonicalRoot = await fsPromises.realpath(root.path);
  const requestedCwd = path.resolve(canonicalRoot, input.cwd);
  let canonicalCwd: string;
  try {
    canonicalCwd = await fsPromises.realpath(requestedCwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ToolInputError(`cwd "${input.cwd}" does not exist in root "${root.displayName}".`);
    }
    throw error;
  }
  if (!isWithinRoot(canonicalRoot, canonicalCwd)) {
    throw new ToolInputError(
      `cwd "${input.cwd}" resolves outside mounted root "${root.displayName}".`
    );
  }
  const canonicalSkillRoot = await fsPromises.realpath(resolved.skillRootPath);
  const canonicalScript = await fsPromises.realpath(resolved.absolutePath);
  if (!isWithinRoot(canonicalSkillRoot, canonicalScript)) {
    throw new ToolInputError(
      `Resolved skill script "${resolved.scriptPath}" escapes skill "${resolved.skillName}".`
    );
  }
  return { cwd: canonicalCwd, rootName: root.displayName, rootPath: canonicalRoot };
}

async function resolveRuntime(
  runtime: RunSkillScriptInput['runtime'],
  resolvePythonExecutable: ((signal?: AbortSignal) => Promise<string>) | undefined,
  signal: AbortSignal | undefined
): Promise<{
  env?: NodeJS.ProcessEnv;
  executable: string;
}> {
  if (runtime === 'node') {
    return {
      env: {
        // biome-ignore lint/style/useNamingConvention: Electron's documented Node-mode switch.
        ELECTRON_RUN_AS_NODE: '1',
      },
      executable: process.execPath,
    };
  }
  if (runtime === 'python3') {
    // BST-1061: python3 means the BUNDLED CPython, resolved through the
    // injected capability — never a PATH `python`/`python3` fallback. An
    // unusable bundled runtime surfaces as a typed PythonRuntimeError from
    // the resolver. `signal` (PR #2205 review) lets a cold first-run unpack
    // — the only slow part of resolution — actually be interrupted by the
    // caller's timeout/Stop budget; see `resolveRuntimeTimeoutSignal`.
    if (!resolvePythonExecutable) {
      throw new Error(
        'The python3 skill-script runtime requires the bundled-Python resolver, and none was injected.'
      );
    }
    return { executable: await resolvePythonExecutable(signal) };
  }
  if (process.platform === 'win32') {
    throw new ToolInputError('The bash skill-script runtime is unavailable on Windows.');
  }
  return { executable: 'bash' };
}

/**
 * Bounds `resolveRuntime` by the SAME `timeoutMs` budget the model asked for
 * on the whole tool call, combined with the caller's own cancellation
 * (`options.signal`, e.g. a user Stop) — PR #2205 review. Without this, a
 * cold `python3` resolve (sha256 over a ~25MB archive, then `tar -xzf` of a
 * ~250MB CPython tree) ran entirely BEFORE `startedAt` was captured and
 * before `input.timeoutMs` had anything to bound: a tool call the model
 * capped at 30s could silently block for a minute or more, and Stop could
 * not reach an in-flight extraction.
 */
function createRuntimeResolveSignal(
  timeoutMs: number,
  externalSignal: AbortSignal | undefined
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
}

function fitOutput(
  stdout: string,
  stderr: string
): {
  stderr: string;
  stdout: string;
  truncated: boolean;
} {
  const budget = Math.max(0, NATIVE_TOOL_RESULT_CHAR_BUDGET - OUTPUT_ENVELOPE_CHARS);
  const cleanStdout = stripAnsi(stdout);
  const cleanStderr = stripAnsi(stderr);
  // Fit against the SERIALIZED size, not raw length (mirrors run_python): a
  // script printing JSON nearly doubles under JSON.stringify, and a raw-length
  // fit breaks the serialized self-bound the model projection enforces.
  const serializedBudget = Math.max(
    0,
    budget - serializationOverhead(cleanStdout, cleanStderr, budget)
  );
  const stdoutBudget =
    cleanStderr.length > 0 ? Math.floor(serializedBudget * 0.6) : serializedBudget;
  const stderrBudget = cleanStdout.length > 0 ? serializedBudget - stdoutBudget : serializedBudget;
  const keptStdout = sliceTailCodePoints(cleanStdout, stdoutBudget);
  const keptStderr = sliceTailCodePoints(cleanStderr, stderrBudget);
  return {
    stderr: keptStderr,
    stdout: keptStdout,
    truncated: keptStdout.length < cleanStdout.length || keptStderr.length < cleanStderr.length,
  };
}

export async function runSkillScript(
  input: RunSkillScriptInput,
  runtimeData: RuntimeData | undefined,
  resolver: Pick<ScannedWorkspaceSkills, 'resolveScriptExecution'>,
  options?: {
    resolvePythonExecutable?: ((signal?: AbortSignal) => Promise<string>) | undefined;
    signal?: AbortSignal | undefined;
    stream?: ShellOutputStreamer | undefined;
  }
): Promise<RunSkillScriptToolResult> {
  const resolved = await resolver.resolveScriptExecution({
    ...(input.args ? { args: input.args } : {}),
    runtime: input.runtime,
    scriptPath: input.scriptPath,
    skillName: input.skillName,
  });
  const { cwd, rootName, rootPath } = await resolveWorkingDirectory(runtimeData, input, resolved);

  // `startedAt` and `timeoutMs` are captured BEFORE resolving the runtime
  // (PR #2205 review): a cold `python3` resolve can itself take real time
  // (hashing a ~25MB archive, then `tar -xzf` of a ~250MB tree), and that
  // work used to run before either existed — under-reporting `durationMs`
  // and leaving `input.timeoutMs` with nothing to bound.
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const executionSignal = createRuntimeResolveSignal(timeoutMs, options?.signal);
  const preparationTimeoutMessage = `Preparing the "${input.runtime}" skill-script runtime and workspace ownership exceeded the ${timeoutMs}ms timeout; the script was not run.`;
  const runtime = await resolveRuntime(
    input.runtime,
    options?.resolvePythonExecutable,
    executionSignal
  ).catch((error: unknown) => {
    if (executionSignal.aborted) {
      throw new ToolInputError(
        options?.signal?.aborted
          ? 'The skill script was aborted before execution.'
          : preparationTimeoutMessage
      );
    }
    throw error;
  });
  let spawned = false;
  const outcome = await withWorkspaceMutationLease(
    rootPath,
    'opaque',
    async () => {
      const remainingTimeoutMs = timeoutMs - (Date.now() - startedAt);
      if (remainingTimeoutMs <= 0) {
        // Runtime resolution and workspace admission share the same budget.
        // Never spawn after that budget has expired.
        throw new ToolInputError(preparationTimeoutMessage);
      }
      spawned = true;
      return runDetachedProcess({
        argv: [resolved.absolutePath, ...(input.args ?? [])],
        cwd,
        ...(runtime.env ? { env: runtime.env } : {}),
        executable: runtime.executable,
        signal: options?.signal,
        streamer: options?.stream,
        timeoutMs: remainingTimeoutMs,
      });
    },
    executionSignal
  ).catch((error: unknown) => {
    if (!spawned && executionSignal.aborted) {
      throw new ToolInputError(
        options?.signal?.aborted
          ? 'The skill script was aborted before execution.'
          : preparationTimeoutMessage
      );
    }
    throw error;
  });
  const durationMs = Date.now() - startedAt;
  const output = fitOutput(outcome.stdout, outcome.stderr);
  logger.info('Skill script execution finished', {
    argumentCount: input.args?.length ?? 0,
    argumentLengths: input.args?.map((argument) => argument.length) ?? [],
    durationMs,
    exitCode: outcome.exitCode,
    mountedRoot: rootName,
    scriptPath: resolved.scriptPath,
    skillName: resolved.skillName,
    sourceTier: resolved.sourceTier,
  });
  return {
    durationMs,
    exitCode: outcome.exitCode,
    policy: resolved.policy,
    rootName,
    runtime: input.runtime,
    scriptPath: resolved.scriptPath,
    signal: outcome.signal,
    skillName: resolved.skillName,
    sourceTier: resolved.sourceTier,
    stderr: output.stderr,
    stdout: output.stdout,
    timedOut: outcome.timedOut,
    truncated: output.truncated,
    workingDirectory: input.cwd,
  };
}
