import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
  NATIVE_TOOL_RESULT_CHAR_BUDGET,
  type ResolvedSkillScriptExecution,
  type RunSkillScriptInput,
  type RuntimeData,
  type ScannedWorkspaceSkills,
} from '@brainstrike/agent';
import { ToolInputError } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/utils/logger';
import stripAnsi from 'strip-ansi';
import { runDetachedProcess, type ShellOutputStreamer } from './execute-command-tool';
import { resolveWorkspaceRoot } from './workspace-roots';

const logger = createLogger('RunSkillScriptTool');
const DEFAULT_TIMEOUT_MS = 120_000;
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

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || !(relative.startsWith('..') || path.isAbsolute(relative));
}

async function resolveWorkingDirectory(
  runtimeData: RuntimeData | undefined,
  input: RunSkillScriptInput,
  resolved: ResolvedSkillScriptExecution
): Promise<{ cwd: string; rootName: string }> {
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
  if (!isWithin(canonicalRoot, canonicalCwd)) {
    throw new ToolInputError(
      `cwd "${input.cwd}" resolves outside mounted root "${root.displayName}".`
    );
  }
  const canonicalSkillRoot = await fsPromises.realpath(resolved.skillRootPath);
  const canonicalScript = await fsPromises.realpath(resolved.absolutePath);
  if (!isWithin(canonicalSkillRoot, canonicalScript)) {
    throw new ToolInputError(
      `Resolved skill script "${resolved.scriptPath}" escapes skill "${resolved.skillName}".`
    );
  }
  return { cwd: canonicalCwd, rootName: root.displayName };
}

async function resolveRuntime(
  runtime: RunSkillScriptInput['runtime'],
  resolvePythonExecutable: (() => Promise<string>) | undefined
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
    // the resolver.
    if (!resolvePythonExecutable) {
      throw new Error(
        'The python3 skill-script runtime requires the bundled-Python resolver, and none was injected.'
      );
    }
    return { executable: await resolvePythonExecutable() };
  }
  if (process.platform === 'win32') {
    throw new ToolInputError('The bash skill-script runtime is unavailable on Windows.');
  }
  return { executable: 'bash' };
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
  const stdoutBudget = stderr.length > 0 ? Math.floor(budget * 0.6) : budget;
  const stderrBudget = stdout.length > 0 ? budget - stdoutBudget : budget;
  const cleanStdout = stripAnsi(stdout);
  const cleanStderr = stripAnsi(stderr);
  return {
    stderr: cleanStderr.slice(-stderrBudget),
    stdout: cleanStdout.slice(-stdoutBudget),
    truncated: cleanStdout.length > stdoutBudget || cleanStderr.length > stderrBudget,
  };
}

export async function runSkillScript(
  input: RunSkillScriptInput,
  runtimeData: RuntimeData | undefined,
  resolver: Pick<ScannedWorkspaceSkills, 'resolveScriptExecution'>,
  options?: {
    resolvePythonExecutable?: (() => Promise<string>) | undefined;
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
  const { cwd, rootName } = await resolveWorkingDirectory(runtimeData, input, resolved);
  const runtime = await resolveRuntime(input.runtime, options?.resolvePythonExecutable);
  const startedAt = Date.now();
  const outcome = await runDetachedProcess({
    argv: [resolved.absolutePath, ...(input.args ?? [])],
    cwd,
    ...(runtime.env ? { env: runtime.env } : {}),
    executable: runtime.executable,
    signal: options?.signal,
    streamer: options?.stream,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
