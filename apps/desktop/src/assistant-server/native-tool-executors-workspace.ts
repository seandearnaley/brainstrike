/**
 * Executor entries for the workspace context, artifact, and worktree tools
 * (BST-1646 step c). Each entry builds the request-scoped Mastra registry
 * object for ONE catalog definition; `native-tool-executors.ts` assembles the
 * exhaustive map with the shared host-capabilities executors.
 */

import {
  NATIVE_TOOL_INPUT_SCHEMAS,
  type ReadToolOutputArtifactCursorInput,
  readToolOutputArtifact,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import {
  logToolFailure,
  parseToolExecuteInput,
  type ToolExecuteInput,
} from '@brainstrike/host-capabilities/native-tools';
import { createArtifactReaderModelProjection } from './artifact-reader-model-projection';
import { type DesktopToolBuildContext, executorGroup } from './native-tool-executor-context';
import { contextWriteExecutors } from './native-tool-executors-context';
import { worktreeToolExecutors } from './native-tool-executors-worktree';
import { mainWorkspaceContextBroadcaster } from './workspace-context-broadcast';

export const WORKSPACE_TOOL_EXECUTORS = executorGroup({
  [NATIVE_TOOL_ID.readToolOutputArtifact]: ({ dependencies, resolveActiveDomainCharBudget }) => {
    const toolOutputArtifactReader = dependencies.toolOutputArtifactReader;
    if (!toolOutputArtifactReader) {
      return;
    }
    return {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.readToolOutputArtifact],
      execute: async (input: ToolExecuteInput<ReadToolOutputArtifactCursorInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readToolOutputArtifact],
          input
        );
        try {
          return await readToolOutputArtifact(
            { ...resolvedInput, mode: 'cursor' },
            {
              reader: toolOutputArtifactReader,
            }
          );
        } catch (error) {
          logToolFailure('readToolOutputArtifact failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.readToolOutputArtifact,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readToolOutputArtifact],
      toModelOutput: createArtifactReaderModelProjection(resolveActiveDomainCharBudget),
    };
  },
  ...contextWriteExecutors(mainWorkspaceContextBroadcaster),
  // Main passes its own worktree service for a legacy thread.
  ...worktreeToolExecutors(
    ({ dependencies }: DesktopToolBuildContext) => dependencies.worktreeTools
  ),
});
