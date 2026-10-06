import { NATIVE_TOOL_INPUT_SCHEMAS, type ReadWorkspaceDirectoryInput } from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import type { NativeToolExecutor } from './native-tool-executor-context';
import { runReadWorkspaceDirectory } from './read-workspace-directory-tool';
import {
  logToolFailure,
  parseToolExecuteInput,
  type ToolExecuteInput,
} from './tool-execute-support';

/** The canonical catalog factory, shared by the desktop and Node host. */
export const createReadWorkspaceDirectoryTool: NativeToolExecutor = ({ runtimeData }) => ({
  description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.readWorkspaceDirectory],
  execute: async (input: ToolExecuteInput<ReadWorkspaceDirectoryInput>) => {
    const resolvedInput = parseToolExecuteInput(
      NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceDirectory],
      input
    );
    try {
      return await runReadWorkspaceDirectory(resolvedInput, runtimeData);
    } catch (error) {
      logToolFailure('readWorkspaceDirectory failed', error, resolvedInput);
      throw error;
    }
  },
  id: NATIVE_TOOL_ID.readWorkspaceDirectory,
  inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceDirectory],
});
