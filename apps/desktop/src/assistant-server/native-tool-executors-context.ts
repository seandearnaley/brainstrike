/**
 * The curated workspace-context reads, built over the shared build context so
 * the desktop agent host can run them in its own process. This module must not
 * import Electron: the host bundle loads it.
 */
import {
  type ListWorkspaceContextInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
  type ReadWorkspaceContextInput,
  type UpdateWorkspaceContextSelectionInput,
  type UpdateWorkspaceTapestrySelectionsInput,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import {
  logToolFailure,
  type NativeToolExecutor,
  parseToolExecuteInput,
  type ToolExecuteInput,
} from '@brainstrike/host-capabilities/native-tools';
import { projectListWorkspaceContextModelOutput } from './workspace-context-model-projection';
import { runListWorkspaceContext, runReadWorkspaceContext } from './workspace-context-read-tools';
import {
  runUpdateWorkspaceContextSelection,
  runUpdateWorkspaceTapestrySelections,
  type WorkspaceContextBroadcaster,
} from './workspace-context-tools';
import type { WorkspaceIndexSummary } from './workspace-index-summary';

/** The curated-context read tools' ids, for the host's executed-tool set. */
export const CONTEXT_READ_TOOL_IDS = [
  NATIVE_TOOL_ID.listWorkspaceContext,
  NATIVE_TOOL_ID.readWorkspaceContext,
] as const;

/** The curated-context reads; the listing reports the native index status `readWorkspaceIndex` returns. */
export function contextReadExecutors(readWorkspaceIndex: () => Promise<WorkspaceIndexSummary>): {
  readonly [NATIVE_TOOL_ID.listWorkspaceContext]: NativeToolExecutor;
  readonly [NATIVE_TOOL_ID.readWorkspaceContext]: NativeToolExecutor;
} {
  return {
    [NATIVE_TOOL_ID.listWorkspaceContext]: ({ resolveActiveDomainCharBudget, runtimeData }) => ({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.listWorkspaceContext],
      execute: async (input: ToolExecuteInput<ListWorkspaceContextInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listWorkspaceContext],
          input
        );
        try {
          return runListWorkspaceContext(resolvedInput, runtimeData, await readWorkspaceIndex());
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
  };
}

/** The selection write-backs: validated here, delivered to the windows by `broadcaster`. */
export function contextWriteExecutors(broadcaster: WorkspaceContextBroadcaster): {
  readonly [NATIVE_TOOL_ID.updateWorkspaceContextSelection]: NativeToolExecutor;
  readonly [NATIVE_TOOL_ID.updateWorkspaceTapestrySelections]: NativeToolExecutor;
} {
  return {
    [NATIVE_TOOL_ID.updateWorkspaceContextSelection]: ({ runtimeData }) => ({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.updateWorkspaceContextSelection],
      execute: async (input: ToolExecuteInput<UpdateWorkspaceContextSelectionInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.updateWorkspaceContextSelection],
          input
        );
        try {
          return await runUpdateWorkspaceContextSelection(resolvedInput, runtimeData, broadcaster);
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
          return await runUpdateWorkspaceTapestrySelections(
            resolvedInput,
            runtimeData,
            broadcaster
          );
        } catch (error) {
          logToolFailure('updateWorkspaceTapestrySelections failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.updateWorkspaceTapestrySelections,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.updateWorkspaceTapestrySelections],
    }),
  };
}
