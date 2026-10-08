/**
 * Executor entries for the execution, session, and self-inspection tools
 * (BST-1646 step c). Each entry builds the request-scoped Mastra registry
 * object for ONE catalog definition; `native-tool-executors.ts` assembles the
 * exhaustive map.
 */
import {
  NATIVE_TOOL_INPUT_SCHEMAS,
  type RunSkillScriptInput,
  resolveGuardedToolSignal,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import {
  logToolFailure,
  parseToolExecuteInput,
  resolveShellOutputStreamer,
  type ToolExecuteContext,
  type ToolExecuteInput,
} from '@brainstrike/host-capabilities/native-tools';
import { resolveDesktopPythonExecutable } from '../python-runtime';
import { resolveDesktopSandboxHelperPath } from '../sandbox-runtime';
import { type DesktopToolBuildContext, executorGroup } from './native-tool-executor-context';
import { runPythonExecutor } from './native-tool-executors-python';
import { selfInspectionExecutors } from './native-tool-executors-self';
import { commandSessionExecutors } from './native-tool-executors-sessions';
import { executeCommandExecutor } from './native-tool-executors-shell';
import { mainDiagnosticsReader } from './query-diagnostics-tool';
import { mainQuerySelfRead } from './query-self-tool';
import { runSkillScript } from './run-skill-script-tool';

export const EXECUTION_TOOL_EXECUTORS = executorGroup({
  // Main correlates a legacy thread's commands through its own worktree/forge services.
  [NATIVE_TOOL_ID.executeCommand]: (context) =>
    executeCommandExecutor(() => context.dependencies)(context),
  // Skill execution is capability-gated by the trusted per-request scan
  // engine: no resolver, no tool (the enabled-id filter in assistant-tools.ts
  // treats that omission as the explicit capability result).
  [NATIVE_TOOL_ID.runSkillScript]: ({ dependencies, runtimeData }) => {
    const skillScriptResolver = dependencies.skillScriptResolver;
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
        try {
          return await runSkillScript(resolvedInput, runtimeData, skillScriptResolver, {
            resolvePythonExecutable:
              dependencies.resolvePythonExecutable ?? resolveDesktopPythonExecutable,
            signal: resolveGuardedToolSignal(options),
            ...(stream ? { stream } : {}),
          });
        } catch (error) {
          logToolFailure('runSkillScript failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.runSkillScript,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.runSkillScript],
    };
  },
  // Main resolves the bundled runtime and sandbox helper from Electron's app facts.
  [NATIVE_TOOL_ID.runPython]: (context) =>
    runPythonExecutor({
      resolvePythonExecutable:
        context.dependencies.resolvePythonExecutable ?? resolveDesktopPythonExecutable,
      resolveSeccompApplyPath:
        context.dependencies.resolveSeccompApplyPath ?? resolveDesktopSandboxHelperPath,
    })(context),
  // Main's legacy threads read its own process-wide session manager.
  ...commandSessionExecutors(({ dependencies }: DesktopToolBuildContext) =>
    dependencies.commandSessionManager ? { manager: dependencies.commandSessionManager } : {}
  ),
  ...selfInspectionExecutors(mainQuerySelfRead(), mainDiagnosticsReader),
});
