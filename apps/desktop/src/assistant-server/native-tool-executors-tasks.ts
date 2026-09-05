/**
 * Executor entries for the suspending and task-list tools (BST-1646 step c).
 * Each entry builds the request-scoped Mastra registry object for ONE catalog
 * definition; `native-tool-executors.ts` assembles the exhaustive map.
 */
import {
  createAskUserTool,
  createSubmitPlanTool,
  type ManageTaskListInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import { runManageTaskList } from './manage-task-list-tool';
import { executorGroup } from './native-tool-executor-context';
import {
  logToolFailure,
  parseToolExecuteInput,
  type ToolExecuteInput,
} from './tool-execute-support';

export const TASK_TOOL_EXECUTORS = executorGroup({
  // The two SUSPENDING native tools are registered as the factory-returned
  // Mastra Tool objects DIRECTLY (not re-wrapped in the registry's
  // { description, execute, id, inputSchema } literal shape): re-wrapping
  // would drop suspendSchema/resumeSchema and break both suspension and the
  // hasSuspendSchema fail-safe/plan-mode keep-rule. Excluded for the
  // built-in local provider (same WebGPU-prefill reasoning as the task-list
  // tool and the plan-mode gate).
  [NATIVE_TOOL_ID.askUser]: ({ isLocalProvider }) =>
    isLocalProvider ? undefined : createAskUserTool(),
  [NATIVE_TOOL_ID.submitPlan]: ({ isLocalProvider }) =>
    isLocalProvider ? undefined : createSubmitPlanTool(),
  // The built-in local model never gets the task-list tool: its persisted plan
  // is never re-injected into local instructions either (see
  // readThreadTaskListForTurn in assistant-server/agent-stream-init.ts and the provider gate on
  // buildCurrentTaskListNote in agent-runtime.ts), and the tiny on-device
  // model's WebGPU prefill budget cannot afford advertising a tool whose state
  // it will never see reflected back.
  [NATIVE_TOOL_ID.manageTaskList]: ({ isLocalProvider, runtimeData }) =>
    isLocalProvider
      ? undefined
      : {
          description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.manageTaskList],
          execute: async (input: ToolExecuteInput<ManageTaskListInput>) => {
            const resolvedInput = parseToolExecuteInput(
              NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageTaskList],
              input
            );
            try {
              return await runManageTaskList(resolvedInput, runtimeData);
            } catch (error) {
              logToolFailure('manageTaskList failed', error, resolvedInput);
              throw error;
            }
          },
          id: NATIVE_TOOL_ID.manageTaskList,
          inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageTaskList],
        },
});
