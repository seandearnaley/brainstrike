/**
 * run_python and runSkillScript over a caller-supplied code-execution host:
 * the desktop agent host resolves the bundled CPython and the Linux sandbox
 * helper from the app paths it was launched with. This module must not import
 * Electron: the host bundle loads it.
 */
import {
  createRunPythonTool,
  NATIVE_TOOL_INPUT_SCHEMAS,
  type RunSkillScriptInput,
  resolveGuardedToolSignal,
  type ScannedWorkspaceSkills,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import {
  logToolFailure,
  type NativeToolExecutor,
  parseToolExecuteInput,
  resolveShellOutputStreamer,
  type ToolExecuteContext,
  type ToolExecuteInput,
} from '@brainstrike/host-capabilities/native-tools';
import { BUNDLED_PYTHON_ENV } from '../python-runtime/resolve-python-binary';
import { runSkillScript } from './run-skill-script-tool';

/** Where this process finds the bundled interpreter and the sandbox helper. */
export interface CodeExecutionHost {
  /** Resolves the build-time-unpacked bundled CPython; never a PATH python. */
  readonly resolvePythonExecutable: (signal?: AbortSignal) => Promise<string>;
  /** The packaged Linux seccomp helper; undefined where none applies. */
  readonly resolveSeccompApplyPath: () => string | undefined;
}

export function runPythonExecutor(host: CodeExecutionHost): NativeToolExecutor {
  return () =>
    createRunPythonTool({
      resolveHost: async (signal) => {
        // LAZY import, deliberately. `@brainstrike/agent/fence-executor`
        // pulls in @anthropic-ai/sandbox-runtime AND evaluates
        // `promisify(fs.realpath.native)` at MODULE SCOPE. A top-level
        // import would load all of that merely to BUILD the tool map —
        // on every desktop main startup, and inside every test that
        // imports this registry (measured: it broke 8 suites that mock
        // `node:fs` without a `.native`). Loading it only when a
        // run_python call actually needs an executor is what the seam's
        // Node-only subpath posture intends.
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
          interpreters: { python: { command, env: BUNDLED_PYTHON_ENV, scriptExtension: 'py' } },
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
  resolvePythonExecutable: (signal?: AbortSignal) => Promise<string>
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
          resolvePythonExecutable,
          signal: resolveGuardedToolSignal(options),
          ...(stream ? { stream } : {}),
        });
      },
      id: NATIVE_TOOL_ID.runSkillScript,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.runSkillScript],
    };
  };
}
