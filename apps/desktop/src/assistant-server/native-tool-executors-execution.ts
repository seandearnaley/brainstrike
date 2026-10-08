/**
 * Executor entries for the execution, session, and self-inspection tools
 * (BST-1646 step c). Each entry builds the request-scoped Mastra registry
 * object for ONE catalog definition; `native-tool-executors.ts` assembles the
 * exhaustive map.
 */
import {
  type InspectCommandSessionsInput,
  type ManageCommandSessionInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
  type RunSkillScriptInput,
  readToolExecutionThreadId,
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
import {
  INSPECT_COMMAND_SESSIONS_TRANSFORM,
  MANAGE_COMMAND_SESSION_TRANSFORM,
  runInspectCommandSessions,
  runManageCommandSession,
} from './command-session-tools';
import { executorGroup } from './native-tool-executor-context';
import { runPythonExecutor } from './native-tool-executors-python';
import { selfInspectionExecutors } from './native-tool-executors-self';
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
  // Session tools are omitted for the built-in local provider: both ids are
  // absent from LOCAL_DESKTOP_NATIVE_TOOL_IDS and this gate makes that real
  // at runtime rather than only in the catalog.
  [NATIVE_TOOL_ID.inspectCommandSessions]: ({ dependencies, isLocalProvider, runtimeData }) =>
    isLocalProvider
      ? undefined
      : {
          description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.inspectCommandSessions],
          execute: (input: ToolExecuteInput<InspectCommandSessionsInput>) => {
            const resolvedInput = parseToolExecuteInput(
              NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.inspectCommandSessions],
              input
            );
            try {
              return runInspectCommandSessions(resolvedInput, runtimeData, {
                ...(dependencies.commandSessionManager
                  ? { manager: dependencies.commandSessionManager }
                  : {}),
              });
            } catch (error) {
              logToolFailure('inspectCommandSessions failed', error, resolvedInput);
              throw error;
            }
          },
          id: NATIVE_TOOL_ID.inspectCommandSessions,
          inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.inspectCommandSessions],
          transform: INSPECT_COMMAND_SESSIONS_TRANSFORM,
        },
  [NATIVE_TOOL_ID.manageCommandSession]: ({ dependencies, isLocalProvider, runtimeData }) =>
    isLocalProvider
      ? undefined
      : {
          description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.manageCommandSession],
          execute: async (
            input: ToolExecuteInput<ManageCommandSessionInput>,
            options?: ToolExecuteContext
          ) => {
            const resolvedInput = parseToolExecuteInput(
              NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageCommandSession],
              input
            );
            try {
              return await runManageCommandSession(resolvedInput, runtimeData, {
                executionThreadId: readToolExecutionThreadId([input, options]),
                ...(dependencies.commandSessionManager
                  ? { manager: dependencies.commandSessionManager }
                  : {}),
                ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
              });
            } catch (error) {
              logToolFailure('manageCommandSession failed', error, resolvedInput);
              throw error;
            }
          },
          id: NATIVE_TOOL_ID.manageCommandSession,
          inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageCommandSession],
          transform: MANAGE_COMMAND_SESSION_TRANSFORM,
        },
  ...selfInspectionExecutors(mainQuerySelfRead(), mainDiagnosticsReader),
});
