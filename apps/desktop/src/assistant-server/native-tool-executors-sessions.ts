/**
 * inspectCommandSessions and manageCommandSession over a caller-supplied
 * session manager: Main's legacy threads use its process-wide manager, the
 * desktop agent host its own, starting sessions only in the run's admitted
 * roots. This module must not import Electron: the host bundle loads it.
 */
import {
  type InspectCommandSessionsInput,
  type ManageCommandSessionInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
  readToolExecutionThreadId,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import {
  logToolFailure,
  type NativeToolBuildContext,
  parseToolExecuteInput,
  type ToolExecuteContext,
  type ToolExecuteInput,
} from '@brainstrike/host-capabilities/native-tools';
import {
  type CommandSessionToolDependencies,
  INSPECT_COMMAND_SESSIONS_TRANSFORM,
  MANAGE_COMMAND_SESSION_TRANSFORM,
  runInspectCommandSessions,
  runManageCommandSession,
} from './command-session-tools';
import type { MastraTool } from './native-tool-executor-context';

export function commandSessionExecutors<Context extends NativeToolBuildContext>(
  dependencies: (context: Context) => CommandSessionToolDependencies
): {
  readonly [NATIVE_TOOL_ID.inspectCommandSessions]: (context: Context) => MastraTool | undefined;
  readonly [NATIVE_TOOL_ID.manageCommandSession]: (context: Context) => MastraTool | undefined;
} {
  return {
    // Session tools are omitted for the built-in local provider: both ids are
    // absent from LOCAL_DESKTOP_NATIVE_TOOL_IDS and this gate makes that real
    // at runtime rather than only in the catalog.
    [NATIVE_TOOL_ID.inspectCommandSessions]: (context) =>
      context.isLocalProvider
        ? undefined
        : {
            description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.inspectCommandSessions],
            execute: (input: ToolExecuteInput<InspectCommandSessionsInput>) => {
              const resolvedInput = parseToolExecuteInput(
                NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.inspectCommandSessions],
                input
              );
              try {
                return runInspectCommandSessions(
                  resolvedInput,
                  context.runtimeData,
                  dependencies(context)
                );
              } catch (error) {
                logToolFailure('inspectCommandSessions failed', error, resolvedInput);
                throw error;
              }
            },
            id: NATIVE_TOOL_ID.inspectCommandSessions,
            inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.inspectCommandSessions],
            transform: INSPECT_COMMAND_SESSIONS_TRANSFORM,
          },
    [NATIVE_TOOL_ID.manageCommandSession]: (context) =>
      context.isLocalProvider
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
                return await runManageCommandSession(resolvedInput, context.runtimeData, {
                  ...dependencies(context),
                  executionThreadId: readToolExecutionThreadId([input, options]),
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
  };
}
