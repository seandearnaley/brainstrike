import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { resolveDesktopPythonExecutable } from '../python-runtime';
import { resolveDesktopSandboxHelperPath } from '../sandbox-runtime';
import { type DesktopToolBuildContext, executorGroup } from './native-tool-executor-context';
import { runPythonExecutor } from './native-tool-executors-python';
import { selfInspectionExecutors } from './native-tool-executors-self';
import { commandSessionExecutors } from './native-tool-executors-sessions';
import { executeCommandExecutor } from './native-tool-executors-shell';
import { runSkillScriptExecutor } from './native-tool-executors-skills';
import { mainDiagnosticsReader } from './query-diagnostics-tool';
import { mainQuerySelfRead } from './query-self-tool';

export const EXECUTION_TOOL_EXECUTORS = executorGroup({
  // Main correlates a legacy thread's commands through its own worktree/forge services.
  [NATIVE_TOOL_ID.executeCommand]: (context) =>
    executeCommandExecutor(() => context.dependencies)(context),
  // Main's legacy threads resolve scripts through their own request scan.
  [NATIVE_TOOL_ID.runSkillScript]: (context) =>
    runSkillScriptExecutor(
      context.dependencies.skillScriptResolver,
      context.dependencies.resolvePythonExecutable ?? resolveDesktopPythonExecutable
    )(context),
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
