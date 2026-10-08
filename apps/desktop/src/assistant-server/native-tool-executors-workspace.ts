/**
 * Executor entries for the workspace context, artifact, and worktree tools
 * (BST-1646 step c). Each entry builds the request-scoped Mastra registry
 * object for ONE catalog definition; `native-tool-executors.ts` assembles the
 * exhaustive map with the shared host-capabilities executors.
 */

import {
  type ListWorkspaceContextInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
  type ReadToolOutputArtifactCursorInput,
  type ReadWorkspaceContextInput,
  readToolOutputArtifact,
  type UpdateWorkspaceContextSelectionInput,
  type UpdateWorkspaceTapestrySelectionsInput,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import {
  logToolFailure,
  parseToolExecuteInput,
  type ToolExecuteInput,
} from '@brainstrike/host-capabilities/native-tools';
import { createArtifactReaderModelProjection } from './artifact-reader-model-projection';
import { executorGroup } from './native-tool-executor-context';
import { projectListWorkspaceContextModelOutput } from './workspace-context-model-projection';
import {
  runListWorkspaceContext,
  runReadWorkspaceContext,
  runUpdateWorkspaceContextSelection,
  runUpdateWorkspaceTapestrySelections,
} from './workspace-context-tools';
import { buildWorktreeMastraTools } from './worktree-tools';

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
  [NATIVE_TOOL_ID.listWorkspaceContext]: ({ resolveActiveDomainCharBudget, runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.listWorkspaceContext],
    execute: async (input: ToolExecuteInput<ListWorkspaceContextInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listWorkspaceContext],
        input
      );
      try {
        return runListWorkspaceContext(resolvedInput, runtimeData);
      } catch (error) {
        logToolFailure('listWorkspaceContext failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.listWorkspaceContext,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listWorkspaceContext],
    toModelOutput: (output: unknown) =>
      projectListWorkspaceContextModelOutput(output, resolveActiveDomainCharBudget()),
  }),
  [NATIVE_TOOL_ID.readWorkspaceContext]: ({ runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.readWorkspaceContext],
    execute: async (input: ToolExecuteInput<ReadWorkspaceContextInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceContext],
        input
      );
      try {
        return await runReadWorkspaceContext(resolvedInput, runtimeData);
      } catch (error) {
        logToolFailure('readWorkspaceContext failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.readWorkspaceContext,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceContext],
  }),
  [NATIVE_TOOL_ID.updateWorkspaceContextSelection]: ({ runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.updateWorkspaceContextSelection],
    execute: async (input: ToolExecuteInput<UpdateWorkspaceContextSelectionInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.updateWorkspaceContextSelection],
        input
      );
      try {
        return await runUpdateWorkspaceContextSelection(resolvedInput, runtimeData);
      } catch (error) {
        logToolFailure('updateWorkspaceContextSelection failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.updateWorkspaceContextSelection,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.updateWorkspaceContextSelection],
  }),
  [NATIVE_TOOL_ID.updateWorkspaceTapestrySelections]: ({ runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.updateWorkspaceTapestrySelections],
    execute: async (input: ToolExecuteInput<UpdateWorkspaceTapestrySelectionsInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.updateWorkspaceTapestrySelections],
        input
      );
      try {
        return await runUpdateWorkspaceTapestrySelections(resolvedInput, runtimeData);
      } catch (error) {
        logToolFailure('updateWorkspaceTapestrySelections failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.updateWorkspaceTapestrySelections,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.updateWorkspaceTapestrySelections],
  }),
  // BST-1392. Both worktree ids are absent from LOCAL_DESKTOP_NATIVE_TOOL_IDS,
  // and this gate is what makes that exclusion real at runtime rather than
  // only in the catalog. The two entries are built in `worktree-tools.ts`.
  [NATIVE_TOOL_ID.listWorktrees]: ({ dependencies, isLocalProvider, runtimeData }) =>
    isLocalProvider
      ? undefined
      : buildWorktreeMastraTools(runtimeData, dependencies.worktreeTools)[
          NATIVE_TOOL_ID.listWorktrees
        ],
  [NATIVE_TOOL_ID.manageWorktree]: ({ dependencies, isLocalProvider, runtimeData }) =>
    isLocalProvider
      ? undefined
      : buildWorktreeMastraTools(runtimeData, dependencies.worktreeTools)[
          NATIVE_TOOL_ID.manageWorktree
        ],
});
