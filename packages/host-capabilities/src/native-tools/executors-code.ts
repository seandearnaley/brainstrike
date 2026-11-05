/**
 * run_python and runSkillScript over the code-execution host each agent host
 * injects: Desktop's resolves its bundled CPython and packaged Linux sandbox
 * helper from its launch app paths; the standalone CLI's runs the system
 * Python 3 (`system-python.ts`).
 */
import {
  createRunPythonTool,
  NATIVE_TOOL_INPUT_SCHEMAS,
  type RunSkillScriptInput,
  resolveGuardedToolSignal,
  type ScannedWorkspaceSkills,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import type { WindowsCommandEntry } from './execute-command-tool.ts';
import type { NativeToolExecutor } from './host-tools.ts';
import { PYTHON_LAUNCH_ENV, runSkillScript } from './run-skill-script-tool.ts';
import {
  logToolFailure,
  parseToolExecuteInput,
  resolveShellOutputStreamer,
  type ToolExecuteContext,
  type ToolExecuteInput,
} from './tool-execute-support.ts';

/** Where this host finds its Python interpreter, its sandbox helper and its Windows wrapper. */
export interface CodeExecutionHost {
  /**
   * The Python 3 this host runs: Desktop's build-time-unpacked bundled
   * CPython, the CLI's system Python. One that cannot be produced throws an
   * error whose `code` starts with `python_`, which run_python reports as
   * `interpreter_unavailable`.
   */
  readonly resolvePythonExecutable: (signal?: AbortSignal) => Promise<string>;
  /** The packaged Linux seccomp helper; undefined where sandbox-runtime finds its own. */
  readonly resolveSeccompApplyPath: () => string | undefined;
  /** The Windows command wrapper this host ships, which skill scripts start through. */
  readonly windowsCommandEntry: WindowsCommandEntry;
}

export function runPythonExecutor(host: CodeExecutionHost): NativeToolExecutor {
  return () =>
    createRunPythonTool({
      resolveHost: async (signal) => {
        // LAZY import, deliberately. `@brainstrike/agent/fence-executor`
        // pulls in @anthropic-ai/sandbox-runtime AND evaluates
        // `promisify(fs.realpath.native)` at MODULE SCOPE. A top-level
        // import would load all of that merely to BUILD the tool map, on
        // every host start. Loading it only when a run_python call actually
        // needs an executor is what the seam's Node-only subpath intends.
        const { createFenceExecutorFactory, FenceUnsupportedPlatformError, isFenceSupported } =
          await import('@brainstrike/agent/fence-executor');
        // Fence FIRST, interpreter second. On a host with no OS fence
        // (Windows today) the missing half is the sandbox, and resolving
        // the interpreter first would report a python_* failure there —
        // telling the user to fix the interpreter on a machine that
        // could not have run anything anyway, inverting exactly the
        // "which half is missing" distinction the error mapping exists
        // to preserve.
        if (!isFenceSupported()) {
          throw new FenceUnsupportedPlatformError(process.platform);
        }
        const command = await host.resolvePythonExecutable(signal);
        const linuxSeccompApplyPath = host.resolveSeccompApplyPath();
        const fence = createFenceExecutorFactory({
          ...(linuxSeccompApplyPath === undefined ? {} : { linuxSeccompApplyPath }),
          interpreters: { python: { command, env: PYTHON_LAUNCH_ENV, scriptExtension: 'py' } },
        });
        // `undefined` on a host with no OS fence (Windows today). Under
        // exactOptionalPropertyTypes an explicit `fence: undefined` is
        // not assignable, and omitting the key is also the honest
        // shape: the capability is ABSENT, and the seam then throws
        // ExecutorKindUnavailableError rather than degrading.
        return fence ? { fence } : {};
      },
    });
}

export function runSkillScriptExecutor(
  skillScriptResolver: Pick<ScannedWorkspaceSkills, 'resolveScriptExecution'> | undefined,
  host: Pick<CodeExecutionHost, 'resolvePythonExecutable' | 'windowsCommandEntry'>
): NativeToolExecutor {
  // Skill execution is capability-gated by the trusted per-request scan
  // engine: no resolver, no tool; omission is the explicit capability result.
  return ({ runtimeData }) => {
    if (!skillScriptResolver) {
      return;
    }
    return {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.runSkillScript],
      execute: async (
        input: ToolExecuteInput<RunSkillScriptInput>,
        options?: ToolExecuteContext
      ) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.runSkillScript],
          input
        );
        const stream = resolveShellOutputStreamer(options, (error) => {
          logToolFailure('runSkillScript output streaming failed', error, resolvedInput);
        });
        return await runSkillScript(resolvedInput, runtimeData, skillScriptResolver, {
          resolvePythonExecutable: host.resolvePythonExecutable,
          signal: resolveGuardedToolSignal(options),
          ...(stream ? { stream } : {}),
          windowsCommandEntry: host.windowsCommandEntry,
        });
      },
      id: NATIVE_TOOL_ID.runSkillScript,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.runSkillScript],
    };
  };
}
