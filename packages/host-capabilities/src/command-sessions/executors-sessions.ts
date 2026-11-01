/**
 * inspectCommandSessions and manageCommandSession over a caller-supplied
 * session manager: the agent host's own (desktop and standalone), starting
 * sessions only in the run's admitted roots.
 */
import {
  type InspectCommandSessionsInput,
  type ManageCommandSessionInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
  readToolExecutionThreadId,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import type { NativeToolBuildContext, NativeToolDefinition } from '../native-tools/executors.ts';
import {
  parseToolExecuteInput,
  type ToolExecuteContext,
  type ToolExecuteInput,
} from '../native-tools/tool-execute-support.ts';
import {
  type CommandSessionToolDependencies,
  INSPECT_COMMAND_SESSIONS_TRANSFORM,
  MANAGE_COMMAND_SESSION_TRANSFORM,
  runInspectCommandSessions,
  runManageCommandSession,
} from './command-session-tools.ts';

export function commandSessionExecutors<Context extends NativeToolBuildContext>(
  dependencies: (context: Context) => CommandSessionToolDependencies
): {
  readonly [NATIVE_TOOL_ID.inspectCommandSessions]: (
    context: Context
  ) => NativeToolDefinition | undefined;
  readonly [NATIVE_TOOL_ID.manageCommandSession]: (
    context: Context
  ) => NativeToolDefinition | undefined;
} {
  return {
    [NATIVE_TOOL_ID.inspectCommandSessions]: (context) => ({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.inspectCommandSessions],
      execute: (input: ToolExecuteInput<InspectCommandSessionsInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.inspectCommandSessions],
          input
        );
        return runInspectCommandSessions(resolvedInput, context.runtimeData, dependencies(context));
      },
      id: NATIVE_TOOL_ID.inspectCommandSessions,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.inspectCommandSessions],
      transform: INSPECT_COMMAND_SESSIONS_TRANSFORM,
    }),
    [NATIVE_TOOL_ID.manageCommandSession]: (context) => ({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.manageCommandSession],
      execute: async (
        input: ToolExecuteInput<ManageCommandSessionInput>,
        options?: ToolExecuteContext
      ) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageCommandSession],
          input
        );
        return await runManageCommandSession(resolvedInput, context.runtimeData, {
          ...dependencies(context),
          executionThreadId: readToolExecutionThreadId([input, options]),
          ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
        });
      },
      id: NATIVE_TOOL_ID.manageCommandSession,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageCommandSession],
      transform: MANAGE_COMMAND_SESSION_TRANSFORM,
    }),
  };
}
